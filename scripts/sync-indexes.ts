// Makes each collection's indexes match the models: builds new ones and drops ones the models no
// longer declare (the app only ever adds indexes on startup). Run after upgrading:
//   npm run indexes:sync           — show what would change
//   npm run indexes:sync -- --apply

import mongoose from 'mongoose';
import { env } from '../src/config/env.ts';
import { DraftModel } from '../src/models/Draft.ts';
import { MessageModel } from '../src/models/Message.ts';
import { TicketModel } from '../src/models/Ticket.ts';
import { UserModel } from '../src/models/User.ts';

const apply = process.argv.includes('--apply');
await mongoose.connect(env.MONGODB_URI);

for (const model of [TicketModel, MessageModel, DraftModel, UserModel] as mongoose.Model<unknown>[]) {
  const diff = await model.diffIndexes();
  const name = model.collection.collectionName;
  if (!diff.toCreate.length && !diff.toDrop.length) {
    console.log(`${name}: up to date`);
    continue;
  }
  console.log(`${name}: create ${JSON.stringify(diff.toCreate)}; drop ${JSON.stringify(diff.toDrop)}`);
  if (apply) await model.syncIndexes();
}
if (!apply) console.log('\nNothing changed. Re-run with --apply to make these changes.');
await mongoose.disconnect();
