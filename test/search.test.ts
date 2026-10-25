import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Imported lazily: the route module loads server config, which tests don't need for this pure helper.
describe('textSearchExpression', async () => {
  process.env.MONGODB_URI ??= 'mongodb://localhost/test';
  process.env.JWT_SECRET ??= 'x'.repeat(32);
  const { textSearchExpression } = await import('../src/routes/tickets.ts');

  it('keeps a single word unquoted so word forms match', () => {
    assert.equal(textSearchExpression('dividends'), 'dividends');
  });
  it('requires every word of a phrase', () => {
    assert.equal(textSearchExpression('election  form'), '"election" "form"');
  });
  it('matches references and codes exactly', () => {
    assert.equal(textSearchExpression('REG-2026-000630'), '"REG-2026-000630"');
    assert.equal(textSearchExpression('0800 000'), '"0800" "000"');
  });
  it('strips quotes typed by the user', () => {
    assert.equal(textSearchExpression('say "hi"'), '"say" "hi"');
  });
});
