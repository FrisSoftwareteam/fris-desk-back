import type { Types } from 'mongoose';
import { mongo } from 'mongoose';
import mongoose from 'mongoose';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { AttachmentModel } from '../../models/Attachment.js';
import { TicketModel } from '../../models/Ticket.js';
import { getGraph } from '../graph/GraphService.js';

const ATTEMPTS = 5;
const DELAY_MS = 4_000;

/**
 * Housekeeping once a reply has been sent, run in the background so the officer isn't kept waiting:
 * - records the sent message's Outlook conversation on the ticket, so replies to it thread back
 *   even if the shareholder removes the [REG-…] reference from the subject;
 * - with ATTACHMENT_STORAGE=mailbox, points the attachments we uploaded at the copy in Sent Items
 *   and deletes the database copy (keeps a free Atlas tier from filling up).
 * Failures are logged only: the email has already gone and the ticket is correct either way.
 */
export function afterSend(
  ticketId: Types.ObjectId,
  internetMessageId: string | null,
  attachmentIds: Types.ObjectId[],
): void {
  if (!internetMessageId) return;
  void (async () => {
    const graph = getGraph();
    if (!graph) return;
    try {
      let sent = null;
      for (let i = 0; i < ATTEMPTS && !sent; i++) {
        await new Promise((r) => setTimeout(r, DELAY_MS));
        sent = await graph.findSentItem(internetMessageId);
      }
      if (!sent?.id) {
        logger.warn({ ticketId }, 'Sent message not found in Sent Items; skipped follow-up housekeeping');
        return;
      }
      if (sent.conversationId) {
        await TicketModel.updateOne(
          { _id: ticketId, conversationId: { $ne: sent.conversationId } },
          { $addToSet: { otherConversationIds: sent.conversationId } },
        );
      }
      if (env.ATTACHMENT_STORAGE !== 'mailbox' || attachmentIds.length === 0) return;

      const inSent = await graph.listAttachments(sent.id);
      const used = new Set<string>();
      const bucket = new mongo.GridFSBucket(mongoose.connection.db!, { bucketName: 'attachments' });
      for (const a of await AttachmentModel.find({ _id: { $in: attachmentIds }, storage: 'database' })) {
        const original = inSent.find((g) => g.id && !used.has(g.id) && g.name === a.filename);
        if (!original?.id) continue;
        used.add(original.id);
        const blobId = a.blobId;
        a.storage = 'mailbox';
        a.graphMessageId = sent.id;
        a.graphAttachmentId = original.id;
        a.blobId = null;
        await a.save();
        if (blobId) await bucket.delete(blobId).catch(() => undefined);
      }
    } catch (err) {
      logger.warn({ err, ticketId }, 'Post-send housekeeping failed');
    }
  })();
}
