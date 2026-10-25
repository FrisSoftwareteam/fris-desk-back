import { logger } from '../../lib/logger.js';
import { audit } from '../../models/AuditLog.js';
import { TicketModel } from '../../models/Ticket.js';
import { notifyTicketChanged } from '../realtime/changes.js';
import { followUpsDueFilter } from './followUpRules.js';

/**
 * Cron job (GAP_ANALYSIS G-04.3): when a follow-up's time comes, the enquiry is marked unread so it
 * stands out again in its usual views (a snoozed one reappears there too). Each one is claimed with
 * a single conditional update, so it fires once even if two API processes run the job.
 */
export async function checkFollowUps(now = new Date()): Promise<number> {
  const due = await TicketModel.find(followUpsDueFilter(now), { _id: 1 }).limit(200).lean();
  let fired = 0;
  for (const { _id } of due) {
    const ticket = await TicketModel.findOneAndUpdate(
      { _id, ...followUpsDueFilter(now) },
      { $set: { 'followUp.dueAt': now, isUnread: true } },
      { returnDocument: 'after' },
    );
    if (!ticket?.followUp) continue;
    fired += 1;
    notifyTicketChanged(_id.toString());
    await audit({
      actorId: null,
      action: 'followup.due',
      ticketId: _id,
      meta: { at: ticket.followUp.at, note: ticket.followUp.note },
    });
  }
  if (fired) logger.info({ count: fired }, 'Follow-ups due');
  return fired;
}
