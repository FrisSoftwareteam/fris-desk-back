import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { directoryFilter, keepDomain } from '../src/services/graph/directory.ts';

describe('directory suggestions', () => {
  it('escapes quotes in the search text', () => {
    assert.equal(directoryFilter("o'b").split(' or ')[0], "startswith(displayName,'o''b')");
  });
  it('keeps only the firm domain, case-insensitively', () => {
    const out = keepDomain(
      [
        { displayName: 'Ada', mail: 'Ada@FirstRegistrarsNigeria.com' },
        { displayName: 'Ext', mail: 'x@gmail.com' },
        { displayName: 'Spoof', mail: 'y@evilfirstregistrarsnigeria.com' },
        { displayName: 'No mail', mail: null },
      ],
      'firstregistrarsnigeria.com',
    );
    assert.deepEqual(out, [{ name: 'Ada', email: 'Ada@FirstRegistrarsNigeria.com' }]);
  });
});
