// Recomputes every ticket's list-pane preview from its newest message (e.g. after changing the
// external-sender banner patterns). Run with: npm run snippets:rebuild

import mongoose from 'mongoose';
import { env } from '../src/config/env.ts';
import { MessageModel } from '../src/models/Message.ts';
import { TicketModel } from '../src/models/Ticket.ts';
import { makeSnippet } from '../src/services/mail/sanitize.ts';

await mongoose.connect(env.MONGODB_URI);

let updated = 0;
for await (const ticket of TicketModel.find({ deletedAt: null }).cursor()) {
  const newest = await MessageModel.findOne({ ticketId: ticket._id, direction: { $ne: 'note' } }).sort({ sentAt: -1 });
  if (!newest) continue;
  const snippet = makeSnippet(newest.bodyText);
  if (snippet !== ticket.snippet) {
    await TicketModel.updateOne({ _id: ticket._id }, { $set: { snippet } });
    updated += 1;
  }
}
console.log(`Updated ${updated} previews`);
await mongoose.disconnect();
