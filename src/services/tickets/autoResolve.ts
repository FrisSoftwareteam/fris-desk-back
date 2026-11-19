import { logger } from '../../lib/logger.js';
import { audit } from '../../models/AuditLog.js';
import { TicketModel } from '../../models/Ticket.js';
import { markMailRead, sendResolutionEmail } from '../automation/autoAck.js';
import { applySla } from '../automation/sla.js';
import { autoResolvesDueFilter } from './followUpRules.js';

/**
 * Cron job: resolves enquiries an officer set to "resolve if no reply" once the time passes and the
 * shareholder still hasn't written (their reply moves it out of Awaiting shareholder, which cancels
 * it). Each one is claimed with a single conditional update, so it fires once even if two API
 * processes run the job; the shareholder then gets the auto-resolve email, if it's turned on.
 */
export async function checkAutoResolves(now = new Date()): Promise<number> {
  const due = await TicketModel.find(autoResolvesDueFilter(now), { _id: 1 }).limit(200).lean();
  let resolved = 0;
  for (const { _id } of due) {
    const before = await TicketModel.findOneAndUpdate(
      { _id, ...autoResolvesDueFilter(now) },
      { $set: { status: 'resolved', resolvedAt: now, isOverdue: false, autoResolve: null, statusReasonId: null } },
      { returnDocument: 'before', projection: { autoResolve: 1 } },
    ).lean();
    if (!before) continue;
    resolved += 1;
    const ticket = await TicketModel.findById(_id);
    if (!ticket) continue;
    try {
      // The SLA is paused while resolved; save() also tells open browsers.
      await applySla(ticket, { quiet: true });
      await ticket.save();
    } catch (err) {
      logger.error({ err, ticket: ticket.reference }, 'SLA update after auto-resolve failed');
    }
    await audit({
      actorId: null,
      action: 'ticket.auto_resolved',
      ticketId: _id,
      meta: { at: before.autoResolve?.at, setById: before.autoResolve?.setById ?? null },
    });
    markMailRead(ticket).catch((err: unknown) =>
      logger.error({ err, ticket: ticket.reference }, 'Mark mail read failed'),
    );
    sendResolutionEmail(ticket, 'autoResolveEmail').catch((err: unknown) =>
      logger.error({ err, ticket: ticket.reference }, 'Auto-resolve email failed'),
    );
  }
  if (resolved) logger.info({ count: resolved }, 'Enquiries auto-resolved');
  return resolved;
}
