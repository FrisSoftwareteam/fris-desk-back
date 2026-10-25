// Pure SLA decisions (no models, so tests can import this without the environment).

/**
 * The ticket's `isOverdue` after its due time was recalculated. Live changes never set it: the
 * `checkOverdue` job does, so every breach gets its note, supervisor email and audit entry (the job
 * only picks up tickets not yet flagged). `quiet` recalculations (an admin editing policies, the
 * maintenance scripts) flag past-due tickets directly, without alerts.
 */
export function overdueAfterRecalc(
  current: boolean,
  { paused, dueAt, now, quiet }: { paused: boolean; dueAt: Date | null; now: Date; quiet: boolean },
): boolean {
  const pastDue = !paused && dueAt !== null && dueAt.getTime() < now.getTime();
  if (!pastDue) return false;
  return quiet ? true : current;
}
