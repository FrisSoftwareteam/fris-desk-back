import { ConfidentialClientApplication } from '@azure/msal-node';
import {
  Client,
  CustomAuthenticationProvider,
  MiddlewareFactory,
  type Context,
  type Middleware,
  type ResponseType,
} from '@microsoft/microsoft-graph-client';
import type { Attachment, Message, MailFolder, Subscription } from '@microsoft/microsoft-graph-types';
import { env } from '../../config/env.js';

// App-only (client-credentials) access to the shared mailbox (BUILD_SPEC §2, §8.3). The Exchange
// Application Access Policy must limit this app to that one mailbox.

export const MESSAGE_FIELDS = [
  'id',
  'conversationId',
  'internetMessageId',
  'subject',
  'from',
  'sender',
  'toRecipients',
  'ccRecipients',
  'replyTo',
  'body',
  'bodyPreview',
  'receivedDateTime',
  'hasAttachments',
  'isDraft',
  // Needed to recognise auto-replies and newsletters (never auto-acknowledged).
  'internetMessageHeaders',
].join(',');

/**
 * Longest a Graph call may take, retries included. Without a limit one hung connection would stall
 * mail sync for good (it never runs two passes at once).
 */
const GRAPH_TIMEOUT_MS = 120_000;

/** Gives every Graph request a deadline; runs first in the client's middleware chain. */
class TimeoutHandler implements Middleware {
  private next?: Middleware;

  async execute(context: Context): Promise<void> {
    context.options = { ...context.options, signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS) };
    await this.next?.execute(context);
  }

  setNext(next: Middleware): void {
    this.next = next;
  }
}

/** One page of a delta query: new/changed messages plus the link to continue from. */
export interface DeltaPage {
  messages: (Message & { '@removed'?: unknown })[];
  nextLink?: string;
  deltaLink?: string;
}

export class GraphService {
  private readonly msal: ConfidentialClientApplication;
  readonly client: Client;
  readonly mailbox: string;

  constructor(opts: { tenantId: string; clientId: string; clientSecret: string; mailbox: string }) {
    this.mailbox = opts.mailbox;
    this.msal = new ConfidentialClientApplication({
      auth: {
        clientId: opts.clientId,
        clientSecret: opts.clientSecret,
        authority: `https://login.microsoftonline.com/${opts.tenantId}`,
      },
    });
    // MSAL caches the token and only goes to Entra again when it is about to expire.
    const authProvider = new CustomAuthenticationProvider((done) => {
      this.msal
        .acquireTokenByClientCredential({ scopes: ['https://graph.microsoft.com/.default'] })
        .then((result) => done(null, result?.accessToken ?? null))
        .catch((err: unknown) => done(err as Error, null));
    });
    this.client = Client.initWithMiddleware({
      middleware: [new TimeoutHandler(), ...MiddlewareFactory.getDefaultMiddlewareChain(authProvider)],
    });
  }

  private get base() {
    return `/users/${encodeURIComponent(this.mailbox)}`;
  }

  getInbox(): Promise<MailFolder> {
    return this.client
      .api(`${this.base}/mailFolders/inbox`)
      .select('id,displayName,totalItemCount,unreadItemCount')
      .get();
  }

  /**
   * Starts or continues a delta query over the Inbox. With no link, starts fresh from `since`.
   * Follow `nextLink` until a page returns `deltaLink`; store that for the next sync.
   */
  async getInboxDelta(link: string | null, since: Date): Promise<DeltaPage> {
    const request = link
      ? this.client.api(link)
      : this.client
          .api(`${this.base}/mailFolders/inbox/messages/delta`)
          .select('id,conversationId,receivedDateTime,isDraft')
          .filter(`receivedDateTime ge ${since.toISOString()}`);
    const res = (await request.header('Prefer', 'odata.maxpagesize=50').get()) as {
      value: DeltaPage['messages'];
      '@odata.nextLink'?: string;
      '@odata.deltaLink'?: string;
    };
    return { messages: res.value, nextLink: res['@odata.nextLink'], deltaLink: res['@odata.deltaLink'] };
  }

  getMessage(id: string): Promise<Message> {
    return this.client
      .api(`${this.base}/messages/${encodeURIComponent(id)}`)
      .header('Prefer', 'outlook.body-content-type="html"')
      .select(MESSAGE_FIELDS)
      .get();
  }

  async listAttachments(messageId: string): Promise<(Attachment & { contentId?: string | null })[]> {
    const res = (await this.client
      .api(`${this.base}/messages/${encodeURIComponent(messageId)}/attachments`)
      // contentId only exists on file attachments, so it must be type-qualified (a plain 'contentId'
      // is rejected); this also avoids downloading contentBytes.
      .select('id,name,contentType,size,isInline,microsoft.graph.fileAttachment/contentId')
      .get()) as { value: (Attachment & { contentId?: string | null })[] };
    return res.value;
  }

  /** Raw bytes of a file attachment (works for large attachments, unlike contentBytes). */
  async getAttachmentContent(messageId: string, attachmentId: string): Promise<Buffer> {
    const data = (await this.client
      .api(
        `${this.base}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}/$value`,
      )
      .responseType('arraybuffer' as ResponseType)
      .get()) as ArrayBuffer;
    return Buffer.from(data);
  }

  // ── Sending (as the shared mailbox) ─────────────────────────────────────────
  // Replies are created from the original message (createReply/…), so the shareholder's mail
  // client threads them correctly (In-Reply-To/References) and they stay in the same Outlook
  // conversation. Each send is: create draft → set recipients/body → add attachments → send.

  /** Creates a reply / reply-all / forward draft of a mailbox message, with the original quoted. */
  createResponseDraft(messageId: string, kind: 'reply' | 'reply_all' | 'forward'): Promise<Message> {
    const action = { reply: 'createReply', reply_all: 'createReplyAll', forward: 'createForward' }[kind];
    return this.client.api(`${this.base}/messages/${encodeURIComponent(messageId)}/${action}`).post({});
  }

  /** Creates a brand-new draft (e.g. replying on a phone enquiry that has no email to reply to). */
  createNewDraft(): Promise<Message> {
    return this.client.api(`${this.base}/messages`).post({ body: { contentType: 'html', content: '' } });
  }

  updateDraft(draftId: string, patch: Partial<Message>): Promise<Message> {
    return this.client.api(`${this.base}/messages/${encodeURIComponent(draftId)}`).patch(patch);
  }

  /** Attaches a file to a draft; files over 3 MB go through an upload session, as Graph requires. */
  async addDraftAttachment(draftId: string, file: { name: string; contentType: string; data: Buffer }): Promise<void> {
    const base = `${this.base}/messages/${encodeURIComponent(draftId)}/attachments`;
    if (file.data.length <= 3 * 1024 * 1024) {
      await this.client.api(base).post({
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: file.name,
        contentType: file.contentType,
        contentBytes: file.data.toString('base64'),
      });
      return;
    }
    const session = (await this.client.api(`${base}/createUploadSession`).post({
      AttachmentItem: {
        attachmentType: 'file',
        name: file.name,
        size: file.data.length,
        contentType: file.contentType,
      },
    })) as { uploadUrl: string };
    // Chunks must be multiples of 320 KiB. The upload URL is pre-authorised (no bearer token).
    const chunk = 320 * 1024 * 12;
    for (let start = 0; start < file.data.length; start += chunk) {
      const end = Math.min(start + chunk, file.data.length);
      const res = await fetch(session.uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Length': String(end - start),
          'Content-Range': `bytes ${start}-${end - 1}/${file.data.length}`,
        },
        body: new Uint8Array(file.data.subarray(start, end)),
        signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`Attachment upload failed (HTTP ${res.status})`);
    }
  }

  /** Finds a message we sent in Sent Items by its Internet Message-ID (it can take a few seconds to appear). */
  async findSentItem(internetMessageId: string): Promise<Message | null> {
    const escaped = internetMessageId.replace(/'/g, "''");
    const res = (await this.client
      .api(`${this.base}/mailFolders/sentitems/messages`)
      .filter(`internetMessageId eq '${escaped}'`)
      .select('id,conversationId')
      .top(1)
      .get()) as { value: Message[] };
    return res.value[0] ?? null;
  }

  async sendDraft(draftId: string): Promise<void> {
    await this.client.api(`${this.base}/messages/${encodeURIComponent(draftId)}/send`).post({});
  }

  /** Removes a draft we created but couldn't send, so it doesn't linger in the mailbox's Drafts. */
  async deleteMessage(messageId: string): Promise<void> {
    await this.client.api(`${this.base}/messages/${encodeURIComponent(messageId)}`).delete();
  }

  // ── Change-notification subscriptions (push) ────────────────────────────────

  createInboxSubscription(notificationUrl: string, clientState: string, expires: Date): Promise<Subscription> {
    return this.client.api('/subscriptions').post({
      changeType: 'created',
      notificationUrl,
      resource: `users/${this.mailbox}/mailFolders('inbox')/messages`,
      expirationDateTime: expires.toISOString(),
      clientState,
    });
  }

  renewSubscription(id: string, expires: Date): Promise<Subscription> {
    return this.client.api(`/subscriptions/${id}`).patch({ expirationDateTime: expires.toISOString() });
  }

  async deleteSubscription(id: string): Promise<void> {
    await this.client.api(`/subscriptions/${id}`).delete();
  }
}

let instance: GraphService | null | undefined;

/** The shared GraphService, or null when Graph isn't configured in backend/.env. */
export function getGraph(): GraphService | null {
  if (instance === undefined) {
    instance =
      env.AZURE_TENANT_ID && env.AZURE_CLIENT_ID && env.AZURE_CLIENT_SECRET && env.GRAPH_SHARED_MAILBOX
        ? new GraphService({
            tenantId: env.AZURE_TENANT_ID,
            clientId: env.AZURE_CLIENT_ID,
            clientSecret: env.AZURE_CLIENT_SECRET,
            mailbox: env.GRAPH_SHARED_MAILBOX,
          })
        : null;
  }
  return instance;
}
