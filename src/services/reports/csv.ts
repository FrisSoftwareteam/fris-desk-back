// CSV for report and list exports (GAP_ANALYSIS G-06.2). Pure, so it can be unit-tested.
// Files open straight in Excel: UTF-8 with a byte-order mark (else Excel guesses the encoding and
// mangles ₦ and accented names), CRLF line ends, RFC 4180 quoting.

export type CsvCell = string | number | boolean | Date | null | undefined;

const BOM = '﻿';

// Subjects and names come from outside emails, so a cell such as `=HYPERLINK(...)` must not run as
// a formula when the file is opened. A leading apostrophe makes Excel treat it as text.
const FORMULA_START = /^[=+\-@\t\r]/;

function cell(value: CsvCell): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  let s = String(value);
  if (FORMULA_START.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: CsvCell[][]): string {
  return BOM + [headers, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** `YYYY-MM-DD HH:mm` in the business time zone (Excel reads it as a date), or '' for none. */
export function csvDateTime(date: Date | null | undefined, tz: string): string {
  if (!date) return '';
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** Working minutes as hours to one decimal place (easier to total in a spreadsheet), or null. */
export function hours(mins: number | null | undefined): number | null {
  return mins === null || mins === undefined ? null : Math.round(mins / 6) / 10;
}

/** e.g. `registrar-desk-officers-2026-10-01-to-2026-10-31.csv`; `lastDay` is the last day shown. */
export function csvFilename(name: string, firstDay?: string, lastDay?: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const span = firstDay ? (lastDay && lastDay !== firstDay ? `-${firstDay}-to-${lastDay}` : `-${firstDay}`) : '';
  return `registrar-desk-${slug}${span}.csv`;
}
