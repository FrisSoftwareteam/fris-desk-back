// Pure rules for follow-ups and stages (GAP_ANALYSIS G-04.3, G-04.7). No model imports, so tests
// can load this without a database or environment.

/**
 * Hides snoozed enquiries until their follow-up is due. Applied to every list except Follow-ups
 * and search, so a snoozed enquiry can always be found.
 */
export function snoozedHiddenFilter(now: Date) {
  return {
    $or: [{ followUp: null }, { 'followUp.hide': false }, { 'followUp.at': { $lte: now } }],
  };
}

/** Enquiries whose follow-up time has passed but haven't been brought back yet (the cron job). */
export function followUpsDueFilter(now: Date) {
  return { deletedAt: null, 'followUp.at': { $lte: now }, 'followUp.dueAt': null };
}

/** Whether a stored follow-up keeps the enquiry out of the usual lists right now. */
export function isSnoozed(followUp: { at: Date; hide: boolean } | null | undefined, now: Date): boolean {
  return Boolean(followUp?.hide && followUp.at.getTime() > now.getTime());
}

/**
 * A stage belongs to one status. When something else changes the status (new mail, escalation,
 * resolving, a plain status change) without choosing a stage, the old stage no longer applies.
 */
export function shouldClearStatusReason(statusChanged: boolean, reasonChanged: boolean): boolean {
  return statusChanged && !reasonChanged;
}

/** When an auto-resolve set now for `days` falls due (calendar days, not working time). */
export function autoResolveAt(now: Date, days: number): Date {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}

/** Enquiries still waiting on the shareholder whose auto-resolve time has passed (the cron job). */
export function autoResolvesDueFilter(now: Date) {
  return { deletedAt: null, status: 'awaiting_shareholder' as const, 'autoResolve.at': { $lte: now } };
}

/**
 * Auto-resolve only makes sense while we wait for the shareholder: any other status (their reply
 * reopening it, an officer resolving or picking it back up) cancels it.
 */
export function shouldClearAutoResolve(statusChanged: boolean, status: string): boolean {
  return statusChanged && status !== 'awaiting_shareholder';
}
