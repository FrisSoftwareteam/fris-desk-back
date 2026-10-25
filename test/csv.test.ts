import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { csvDateTime, csvFilename, hours, toCsv } from '../src/services/reports/csv.ts';
import { ageBand } from '../src/services/reports/metrics.ts';

describe('toCsv', () => {
  it('starts with a byte-order mark and uses CRLF line ends', () => {
    assert.equal(toCsv(['A', 'B'], [[1, 'x']]), '﻿A,B\r\n1,x\r\n');
  });
  it('quotes commas, quotes and line breaks', () => {
    const csv = toCsv(['Subject'], [['Dividend, 2025'], ['He said "hi"'], ['line 1\nline 2']]);
    assert.equal(csv, '﻿Subject\r\n"Dividend, 2025"\r\n"He said ""hi"""\r\n"line 1\nline 2"\r\n');
  });
  it('leaves empty, null and non-finite cells blank', () => {
    assert.equal(toCsv(['a', 'b', 'c', 'd'], [['', null, undefined, Number.NaN]]), '﻿a,b,c,d\r\n,,,\r\n');
  });
  it('stops text from outside emails running as a spreadsheet formula', () => {
    const csv = toCsv(['x'], [['=HYPERLINK("http://evil","click")'], ['+234 803'], ['-1+1'], ['@SUM(A1)'], ['\tx']]);
    const cells = csv.slice(1).split('\r\n').slice(1, -1);
    assert.deepEqual(cells, ['"\'=HYPERLINK(""http://evil"",""click"")"', "'+234 803", "'-1+1", "'@SUM(A1)", "'\tx"]);
  });
  it('keeps numbers (including negative ones) as numbers', () => {
    assert.equal(toCsv(['n'], [[-3], [12.5]]), '﻿n\r\n-3\r\n12.5\r\n');
  });
});

describe('csv helpers', () => {
  it('formats dates in the business time zone', () => {
    assert.equal(csvDateTime(new Date('2026-10-19T23:30Z'), 'Africa/Lagos'), '2026-10-20 00:30');
    assert.equal(csvDateTime(null, 'Africa/Lagos'), '');
  });
  it('turns working minutes into hours to one decimal place', () => {
    assert.equal(hours(90), 1.5);
    assert.equal(hours(100), 1.7);
    assert.equal(hours(null), null);
  });
  it('names files after the report and the days shown', () => {
    assert.equal(
      csvFilename('By category', '2026-10-01', '2026-10-31'),
      'registrar-desk-by-category-2026-10-01-to-2026-10-31.csv',
    );
    assert.equal(csvFilename('officers', '2026-10-20', '2026-10-20'), 'registrar-desk-officers-2026-10-20.csv');
  });
});

describe('ageBand', () => {
  const now = new Date('2026-10-20T12:00Z');
  const ago = (days: number) => new Date(now.getTime() - days * 86_400_000);
  it('puts each open enquiry in one band by calendar time waiting', () => {
    assert.equal(ageBand(ago(0.5), now), 'Under 1 day');
    assert.equal(ageBand(ago(1), now), '1–3 days');
    assert.equal(ageBand(ago(2.9), now), '1–3 days');
    assert.equal(ageBand(ago(3), now), '3–7 days');
    assert.equal(ageBand(ago(13), now), '7–14 days');
    assert.equal(ageBand(ago(29), now), '14–30 days');
    assert.equal(ageBand(ago(400), now), '30+ days');
    // A clock slightly ahead of the server still counts as new.
    assert.equal(ageBand(ago(-0.01), now), 'Under 1 day');
  });
});
