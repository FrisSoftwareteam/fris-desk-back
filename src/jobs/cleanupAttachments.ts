import mongoose, { mongo } from 'mongoose';
import { logger } from '../lib/logger.js';
import { AttachmentModel } from '../models/Attachment.js';
import { DraftModel } from '../models/Draft.js';
import { MessageModel } from '../models/Message.js';
import { TemplateModel } from '../models/Template.js';
import { PendingReplyModel } from '../models/PendingReply.js';

const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Deletes files officers uploaded in the composer but never sent (removed from the reply, or left
 * in a discarded draft). Only files that no message, draft, template or held reply refers to, and that are over
 * a day old, are removed. Template form files have no enquiry and are never sent themselves.
 */
export async function cleanupAbandonedUploads(): Promise<number> {
  const cutoff = new Date(Date.now() - ABANDONED_AFTER_MS);
  const candidates = await AttachmentModel.find(
    { storage: 'database', graphMessageId: null, createdAt: { $lt: cutoff } },
    { _id: 1, blobId: 1 },
  ).lean();
  if (candidates.length === 0) return 0;

  const ids = candidates.map((c) => c._id);
  const [inMessages, inDrafts, inTemplates, inPending] = await Promise.all([
    MessageModel.distinct('attachmentIds', { attachmentIds: { $in: ids } }),
    DraftModel.distinct('attachmentIds', { attachmentIds: { $in: ids } }),
    TemplateModel.distinct('attachmentIds', { attachmentIds: { $in: ids } }),
    // Replies waiting for (or returned from) supervisor approval still need their files.
    PendingReplyModel.distinct('attachmentIds', { attachmentIds: { $in: ids }, status: { $ne: 'approved' } }),
  ]);
  const referenced = new Set([...inMessages, ...inDrafts, ...inTemplates, ...inPending].map(String));
  const abandoned = candidates.filter((c) => !referenced.has(c._id.toString()));
  if (abandoned.length === 0) return 0;

  const bucket = new mongo.GridFSBucket(mongoose.connection.db!, { bucketName: 'attachments' });
  for (const a of abandoned) {
    if (a.blobId) await bucket.delete(a.blobId).catch(() => undefined);
  }
  await AttachmentModel.deleteMany({ _id: { $in: abandoned.map((a) => a._id) } });
  logger.info({ count: abandoned.length }, 'Removed abandoned composer uploads');
  return abandoned.length;
}
