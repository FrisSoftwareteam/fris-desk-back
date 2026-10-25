// Brings attachments stored before the `attachments` collection existed (GridFS only) up to date,
// and — when ATTACHMENT_STORAGE=mailbox — frees database space by pointing each one at its original
// in the shared mailbox and deleting the GridFS copy. A copy is only deleted after its original is
// found in the mailbox (same email, file name and size); anything not found keeps its copy.
// Run with: npm run attachments:migrate   (add --dry-run to only report)

import mongoose, { mongo, Types } from 'mongoose';
import type { Attachment as GraphAttachment } from '@microsoft/microsoft-graph-types';
import { env } from '../src/config/env.ts';
import { AttachmentModel } from '../src/models/Attachment.ts';
import { MessageModel } from '../src/models/Message.ts';
import { getGraph } from '../src/services/graph/GraphService.ts';

const dryRun = process.argv.includes('--dry-run');
await mongoose.connect(env.MONGODB_URI);
const bucket = new mongo.GridFSBucket(mongoose.connection.db!, { bucketName: 'attachments' });

// 1. Record details for GridFS files that have none yet (same id, so messages keep pointing at them).
let recorded = 0;
for await (const file of bucket.find({})) {
  if (await AttachmentModel.exists({ $or: [{ _id: file._id }, { blobId: file._id }] })) continue;
  const meta = (file.metadata ?? {}) as {
    contentType?: string;
    ticketId?: Types.ObjectId;
    contentId?: string;
    isInline?: boolean;
  };
  recorded += 1;
  if (dryRun) continue;
  await AttachmentModel.create({
    _id: file._id,
    filename: file.filename,
    contentType: meta.contentType ?? 'application/octet-stream',
    size: file.length,
    ticketId: meta.ticketId ?? null,
    contentId: meta.contentId ?? null,
    isInline: meta.isInline ?? false,
    storage: 'database',
    blobId: file._id,
  });
}
console.log(`${dryRun ? 'Would record' : 'Recorded'} ${recorded} existing attachments`);

// 2. Move copies back to the mailbox.
if (env.ATTACHMENT_STORAGE !== 'mailbox') {
  console.log('ATTACHMENT_STORAGE=database — keeping all copies in the database.');
} else {
  const graph = getGraph();
  if (!graph) throw new Error('Graph is not configured, so originals in the mailbox cannot be checked');
  let moved = 0;
  let kept = 0;
  let freedBytes = 0;
  const listCache = new Map<string, GraphAttachment[]>();
  const usedIds = new Map<string, Set<string>>();
  // Originals already claimed by earlier runs can't be claimed again.
  for (const done of await AttachmentModel.find(
    { storage: 'mailbox' },
    { graphMessageId: 1, graphAttachmentId: 1 },
  ).lean()) {
    if (!done.graphMessageId || !done.graphAttachmentId) continue;
    const set = usedIds.get(done.graphMessageId) ?? new Set<string>();
    set.add(done.graphAttachmentId);
    usedIds.set(done.graphMessageId, set);
  }

  for await (const a of AttachmentModel.find({ storage: 'database' }).cursor()) {
    const message = await MessageModel.findOne({ attachmentIds: a._id, graphMessageId: { $ne: null } }).lean();
    if (!message?.graphMessageId) {
      kept += 1;
      continue;
    }
    let list = listCache.get(message.graphMessageId);
    if (!list) {
      list = await graph.listAttachments(message.graphMessageId).catch(() => []);
      listCache.set(message.graphMessageId, list);
    }
    // Graph reports the size including MIME encoding overhead (up to ~1.6x for images), so match on
    // file name, accept a Graph size between 1x and 1.7x ours, take the closest, and use each
    // original only once (one email can carry several files with the same name).
    const used = usedIds.get(message.graphMessageId) ?? new Set<string>();
    usedIds.set(message.graphMessageId, used);
    const original = list
      .filter(
        (g) =>
          g.id &&
          !used.has(g.id) &&
          (g.name?.trim() || 'attachment') === a.filename &&
          (g.size ?? 0) >= a.size &&
          (g.size ?? 0) <= a.size * 1.7 + 4096,
      )
      .sort((x, y) => (x.size ?? 0) - (y.size ?? 0))[0];
    if (original?.id) used.add(original.id);
    if (!original?.id) {
      kept += 1;
      continue;
    }
    moved += 1;
    freedBytes += a.size;
    if (dryRun) continue;
    const blobId = a.blobId;
    a.storage = 'mailbox';
    a.graphMessageId = message.graphMessageId;
    a.graphAttachmentId = original.id;
    a.blobId = null;
    await a.save();
    if (blobId) await bucket.delete(blobId).catch(() => undefined);
  }
  console.log(
    `${dryRun ? 'Would move' : 'Moved'} ${moved} attachments to mailbox storage (${Math.round(freedBytes / 1e6)} MB freed); ` +
      `kept ${kept} copies whose original couldn't be found`,
  );
}

await mongoose.disconnect();
