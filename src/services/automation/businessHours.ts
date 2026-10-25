// Business-hours arithmetic for SLA deadlines (BUILD_SPEC §5 `slaPolicies.businessHours`).
// Works in the policy's IANA time zone (default Africa/Lagos) using Intl, so no date library.

export interface BusinessHours {
  tz: string;
  /** ISO weekdays that are working days: 1 = Monday … 7 = Sunday. */
  days: number[];
  /** "HH:MM", local time. */
  start: string;
  end: string;
}

export const DEFAULT_BUSINESS_HOURS: BusinessHours = {
  tz: 'Africa/Lagos',
  days: [1, 2, 3, 4, 5],
  start: '08:00',
  end: '17:00',
};

const MINUTE = 60_000;

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

// Building an Intl.DateTimeFormat is slow, and reports call localParts thousands of times.
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Local calendar date, ISO weekday and minute-of-day of an instant in a time zone. */
function localParts(at: Date, tz: string) {
  const parts = Object.fromEntries(
    formatterFor(tz)
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday!) + 1;
  return {
    y: Number(parts.year),
    mo: Number(parts.month),
    d: Number(parts.day),
    weekday,
    minute: Number(parts.hour) * 60 + Number(parts.minute) + Number(parts.second) / 60,
  };
}

/** The instant for a local date + minute-of-day in a time zone (handles any fixed or DST offset). */
function zonedInstant(y: number, mo: number, d: number, minuteOfDay: number, tz: string): Date {
  const guess = Date.UTC(y, mo - 1, d, 0, 0) + minuteOfDay * MINUTE;
  // Correct by the zone's offset at that moment (twice, to settle across an offset change).
  let t = guess;
  for (let i = 0; i < 2; i++) {
    const p = localParts(new Date(t), tz);
    const asUtc = Date.UTC(p.y, p.mo - 1, p.d) + p.minute * MINUTE;
    t += guess - asUtc;
  }
  return new Date(t);
}

/**
 * The deadline `minutes` working minutes after `from`. Time outside business hours (nights,
 * weekends) doesn't count, so 60 minutes from Friday 16:30 lands at Monday 08:30.
 */
export function addBusinessMinutes(from: Date, minutes: number, hours: BusinessHours = DEFAULT_BUSINESS_HOURS): Date {
  const open = minutesOf(hours.start);
  const close = minutesOf(hours.end);
  if (close <= open || hours.days.length === 0) return new Date(from.getTime() + minutes * MINUTE);

  let remaining = minutes;
  let cursor = from;
  // Walk forward a working day at a time (bounded, in case of odd configurations).
  for (let guard = 0; guard < 3660; guard++) {
    const p = localParts(cursor, hours.tz);
    if (hours.days.includes(p.weekday) && p.minute < close) {
      const startMinute = Math.max(p.minute, open);
      const available = close - startMinute;
      if (remaining <= available) return zonedInstant(p.y, p.mo, p.d, startMinute + remaining, hours.tz);
      remaining -= available;
    }
    // Jump to the start of the next local day.
    const nextDay = new Date(Date.UTC(p.y, p.mo - 1, p.d + 1));
    cursor = zonedInstant(nextDay.getUTCFullYear(), nextDay.getUTCMonth() + 1, nextDay.getUTCDate(), 0, hours.tz);
  }
  return new Date(from.getTime() + minutes * MINUTE);
}

/**
 * Working minutes between two instants (0 if `to` is not after `from`): the inverse of
 * addBusinessMinutes, used for response and resolution times in reports.
 */
export function businessMinutesBetween(from: Date, to: Date, hours: BusinessHours = DEFAULT_BUSINESS_HOURS): number {
  if (to.getTime() <= from.getTime()) return 0;
  const open = minutesOf(hours.start);
  const close = minutesOf(hours.end);
  if (close <= open || hours.days.length === 0) return (to.getTime() - from.getTime()) / MINUTE;

  let total = 0;
  let cursor = from;
  for (let guard = 0; guard < 3660 && cursor < to; guard++) {
    const p = localParts(cursor, hours.tz);
    const nextDay = new Date(Date.UTC(p.y, p.mo - 1, p.d + 1));
    const dayEnd = zonedInstant(nextDay.getUTCFullYear(), nextDay.getUTCMonth() + 1, nextDay.getUTCDate(), 0, hours.tz);
    if (hours.days.includes(p.weekday)) {
      const startMinute = Math.max(p.minute, open);
      const endMinute = to < dayEnd ? Math.min(localParts(to, hours.tz).minute, close) : close;
      total += Math.max(0, endMinute - startMinute);
    }
    cursor = dayEnd;
  }
  return total;
}

/** Local calendar day ("YYYY-MM-DD") and hour (0–23) of an instant in a time zone, for reports. */
export function localDayAndHour(at: Date, tz: string): { day: string; hour: number } {
  const p = localParts(at, tz);
  const pad = (n: number) => String(n).padStart(2, '0');
  return { day: `${p.y}-${pad(p.mo)}-${pad(p.d)}`, hour: Math.floor(p.minute / 60) };
}
