// Recalculates every enquiry's SLA policy and due time, including resolved ones (saving a policy in
// Admin → SLA already does this for unresolved enquiries). Quiet: enquiries already past due are
// flagged overdue without notes or supervisor emails (escalation is only for breaches as they happen).
// Run with: npm run sla:recalculate

import mongoose from 'mongoose';
import { env } from '../src/config/env.ts';
import { recalculateSla } from '../src/services/automation/sla.ts';

await mongoose.connect(env.MONGODB_URI);
const { updated, overdue } = await recalculateSla({ includeResolved: true });
console.log(`Recalculated ${updated} enquiries; ${overdue} are currently overdue`);
await mongoose.disconnect();
