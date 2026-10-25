import { localDayAndHour } from '../automation/businessHours.js';
import { AGE_BANDS, type AgeBand } from '../../shared.js';

// Pure helpers for reports, kept free of server config so they can be unit-tested.

/** Every local calendar day from `from` up to (not including) `to`, as YYYY-MM-DD. */
export function listDays(from: Date, to: Date, tz: string): string[] {
  const days: string[] = [];
  // Six-hour steps can't skip a day in any time zone (days are at least 23 hours long).
  for (let t = from.getTime(); t < to.getTime(); t += 6 * 3_600_000) {
    const { day } = localDayAndHour(new Date(t), tz);
    if (days.at(-1) !== day) days.push(day);
  }
  const last = localDayAndHour(new Date(to.getTime() - 1), tz).day;
  if (to > from && days.at(-1) !== last) days.push(last);
  return days;
}

export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

export function percent(part: number, whole: number): number | null {
  return whole === 0 ? null : Math.round((part / whole) * 1000) / 10;
}

/** Resolved by the SLA due time; enquiries with no SLA don't count either way. */
export function slaOutcome(t: { resolvedAt?: Date | null; slaDueAt?: Date | null }): 'met' | 'missed' | null {
  if (!t.resolvedAt || !t.slaDueAt) return null;
  return t.resolvedAt.getTime() <= t.slaDueAt.getTime() ? 'met' : 'missed';
}

/** Upper bound (exclusive, in days) of each AGE_BANDS entry. */
const AGE_BAND_LIMITS = [1, 3, 7, 14, 30, Infinity];

/** Which ageing band an open enquiry falls in: calendar time since it started waiting. */
export function ageBand(start: Date, now: Date): AgeBand {
  const days = (now.getTime() - start.getTime()) / 86_400_000;
  return AGE_BANDS[AGE_BAND_LIMITS.findIndex((limit) => days < limit)]!;
}
