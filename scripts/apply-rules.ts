// Files existing open, unfiled enquiries using the routing rules' folder and category actions —
// useful after creating or changing rules. It never assigns, redirects or sends email (those only
// happen as new mail arrives). Run with: npm run rules:apply   (add --dry-run to only report)

import mongoose, { Types } from 'mongoose';
import { env } from '../src/config/env.ts';
import { audit } from '../src/models/AuditLog.ts';
import { AssignmentRuleModel } from '../src/models/AssignmentRule.ts';
import { MessageModel } from '../src/models/Message.ts';
import { TicketModel } from '../src/models/Ticket.ts';
import { decideRouting, type RuleLike } from '../src/services/automation/rules.ts';
import { applySla } from '../src/services/automation/sla.ts';

const dryRun = process.argv.includes('--dry-run');
await mongoose.connect(env.MONGODB_URI);

const rules: RuleLike[] = (await AssignmentRuleModel.find({ isActive: true }).lean()).map((r) => ({
  id: r._id.toString(),
  name: r.name,
  priority: r.priority,
  isActive: r.isActive,
  conditions: r.conditions.map((c) => ({ field: c.field, op: c.op, value: c.value })),
  // Filing only.
  action: {
    setFolderId: r.action?.setFolderId?.toString() ?? null,
    addCategoryIds: (r.action?.addCategoryIds ?? []).map(String),
  },
}));

let filed = 0;
const byRule = new Map<string, number>();
for await (const t of TicketModel.find({ deletedAt: null, folderId: null, status: { $ne: 'resolved' } }).cursor()) {
  const first = await MessageModel.findOne({ ticketId: t._id }).sort({ sentAt: 1 }).lean();
  const decision = decideRouting(rules, {
    subject: t.subject,
    fromEmail: t.contact.email ?? '',
    bodyText: first?.bodyText ?? '',
  });
  if (!decision.folderId && decision.categoryIds.length === 0) continue;
  filed += 1;
  const names = rules.filter((r) => decision.matchedRuleIds.includes(r.id)).map((r) => r.name);
  for (const n of names) byRule.set(n, (byRule.get(n) ?? 0) + 1);
  if (dryRun) continue;
  if (decision.folderId) t.folderId = new Types.ObjectId(decision.folderId);
  for (const c of decision.categoryIds)
    if (!t.categoryIds.some((x) => x.toString() === c)) t.categoryIds.push(new Types.ObjectId(c));
  await applySla(t, { quiet: true });
  await t.save();
  await audit({
    actorId: null,
    action: 'ticket.routed',
    ticketId: t._id,
    meta: {
      rules: names,
      folderId: decision.folderId ?? null,
      categoryIds: decision.categoryIds,
      assigneeId: null,
      assignedBy: null,
    },
  });
}
console.log(`${dryRun ? 'Would file' : 'Filed'} ${filed} enquiries:`, Object.fromEntries(byRule));
await mongoose.disconnect();
