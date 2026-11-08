import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Imported lazily: the route module loads server config, which tests don't need for this pure helper.
describe('shareholderSearchFilter', async () => {
  process.env.MONGODB_URI ??= 'mongodb://localhost/test';
  process.env.JWT_SECRET ??= 'x'.repeat(32);
  const { shareholderSearchFilter } = await import('../src/routes/shareholders.ts');
  const res = (q: string) => (shareholderSearchFilter(q).$or[0] as { name: RegExp }).name;

  it('searches every field including holdings', () => {
    const fields = shareholderSearchFilter('x').$or.map((c) => Object.keys(c)[0]);
    assert.deepEqual(fields, [
      'name',
      'email',
      'phone',
      'address',
      'holdings.company',
      'holdings.chn',
      'holdings.cscsNumber',
    ]);
  });
  it('matches partial text, ignoring case and surrounding spaces', () => {
    assert.ok(res('  ade ').test('Adebisi Okafor'));
  });
  it('treats regex characters literally', () => {
    assert.ok(res('C1234.5(').test('c1234.5('));
    assert.ok(!res('a.c').test('abc'));
  });
});
