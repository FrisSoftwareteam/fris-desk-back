import { Readable } from 'node:stream';
import mongoose, { Types, mongo } from 'mongoose';
import { env } from '../../config/env.js';
import { AttachmentModel, type AttachmentDoc, type AttachmentStorage } from '../../models/Attachment.js';
import { getGraph } from '../graph/GraphService.js';

export interface AttachmentMeta {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  ticketId: string | null;
  /** For inline images referenced from HTML as cid:<contentId>. */
  contentId: string | null;
  isInline: boolean;
}

export interface NewAttachment {
  filename: string;
  contentType: string;
  size: number;
  ticketId: Types.ObjectId | null;
  contentId?: string | null;
  isInline?: boolean;
  /** Where the original lives in the shared mailbox (required for 'mailbox' storage). */
  graphMessageId?: string | null;
  graphAttachmentId?: string | null;
}

/**
 * Attachment storage (BUILD_SPEC §5). Details always go in the `attachments` collection; where the
 * bytes live depends on ATTACHMENT_STORAGE:
 * - 'mailbox'  — nothing copied; fetched from the shared mailbox via Graph when opened. Uses almost
 *               no database space (good for a free Atlas tier). If the email is deleted from the
 *               mailbox, its attachments can no longer be opened.
 * - 'database' — full copy in MongoDB GridFS, independent of the mailbox (needs a paid tier).
 * Swapping to Azure Blob/S3 later means adding a mode here; routes and ingestion don't change.
 */
export interface AttachmentStore {
  /** Records an attachment. `loadBytes` is only called when the bytes are being copied. */
  save(info: NewAttachment, loadBytes: () => Promise<Buffer>): Promise<AttachmentMeta>;
  getMeta(ids: Types.ObjectId[]): Promise<AttachmentMeta[]>;
  open(id: string): Promise<{ meta: AttachmentMeta; stream: Readable; length: number | null } | null>;
  /** Deletes the details and any database copy of the bytes. */
  remove(ids: Types.ObjectId[]): Promise<void>;
}

function bucket() {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Database is not connected');
  return new mongo.GridFSBucket(db, { bucketName: 'attachments' });
}

function toMeta(
  a: Pick<AttachmentDoc, '_id' | 'filename' | 'contentType' | 'size' | 'ticketId' | 'contentId' | 'isInline'>,
): AttachmentMeta {
  return {
    id: a._id.toString(),
    filename: a.filename,
    contentType: a.contentType,
    size: a.size,
    ticketId: a.ticketId ? a.ticketId.toString() : null,
    contentId: a.contentId ?? null,
    isInline: a.isInline,
  };
}

class ConfiguredAttachmentStore implements AttachmentStore {
  constructor(private readonly mode: AttachmentStorage) {}

  async save(info: NewAttachment, loadBytes: () => Promise<Buffer>): Promise<AttachmentMeta> {
    const keepInMailbox = this.mode === 'mailbox' && info.graphMessageId && info.graphAttachmentId;
    let blobId: Types.ObjectId | null = null;
    let size = info.size;

    if (!keepInMailbox) {
      const data = await loadBytes();
      size = data.length;
      const upload = bucket().openUploadStream(info.filename, { metadata: { contentType: info.contentType } });
      await new Promise<void>((resolve, reject) => {
        upload.once('finish', () => resolve());
        upload.once('error', reject);
        upload.end(data);
      });
      blobId = upload.id as Types.ObjectId;
    }

    const doc = await AttachmentModel.create({
      filename: info.filename,
      contentType: info.contentType,
      size,
      ticketId: info.ticketId,
      contentId: info.contentId ?? null,
      isInline: info.isInline ?? false,
      storage: keepInMailbox ? 'mailbox' : 'database',
      graphMessageId: info.graphMessageId ?? null,
      graphAttachmentId: info.graphAttachmentId ?? null,
      blobId,
    });
    return toMeta(doc);
  }

  async getMeta(ids: Types.ObjectId[]): Promise<AttachmentMeta[]> {
    if (ids.length === 0) return [];
    const docs = await AttachmentModel.find({ _id: { $in: ids } }).lean();
    const byId = new Map(docs.map((d) => [d._id.toString(), d]));
    // Keep the order the message lists them in.
    return ids.flatMap((id) => {
      const d = byId.get(id.toString());
      return d ? [toMeta(d)] : [];
    });
  }

  async open(id: string) {
    if (!Types.ObjectId.isValid(id)) return null;
    const doc = await AttachmentModel.findById(id).lean();
    if (!doc) return null;
    const meta = toMeta(doc);

    if (doc.storage === 'mailbox') {
      const graph = getGraph();
      if (!graph || !doc.graphMessageId || !doc.graphAttachmentId) return null;
      const data = await graph.getAttachmentContent(doc.graphMessageId, doc.graphAttachmentId);
      return { meta, stream: Readable.from(data), length: data.length };
    }

    if (!doc.blobId) return null;
    return { meta, stream: bucket().openDownloadStream(doc.blobId), length: doc.size };
  }

  async remove(ids: Types.ObjectId[]): Promise<void> {
    if (ids.length === 0) return;
    const docs = await AttachmentModel.find({ _id: { $in: ids } }, { blobId: 1 }).lean();
    for (const d of docs) {
      if (d.blobId)
        await bucket()
          .delete(d.blobId)
          .catch(() => undefined);
    }
    await AttachmentModel.deleteMany({ _id: { $in: ids } });
  }
}

export const attachmentStore: AttachmentStore = new ConfiguredAttachmentStore(env.ATTACHMENT_STORAGE);
