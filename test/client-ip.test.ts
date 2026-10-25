import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { clientIpKey } from '../src/middleware/clientIp.ts';

describe('clientIpKey (rate-limit key behind Azure App Service)', () => {
  it('strips the port Azure can add to X-Forwarded-For', () => {
    assert.equal(clientIpKey('203.0.113.7:51234'), '203.0.113.7');
    assert.equal(clientIpKey('[2001:db8::1]:443'), '2001:db8::1');
  });
  it('leaves plain addresses alone', () => {
    assert.equal(clientIpKey('203.0.113.7'), '203.0.113.7');
    assert.equal(clientIpKey('2001:db8::1'), '2001:db8::1');
  });
  it('unwraps IPv4-mapped IPv6', () => {
    assert.equal(clientIpKey('::ffff:203.0.113.7'), '203.0.113.7');
  });
  it('folds missing or junk values into one bucket', () => {
    assert.equal(clientIpKey(undefined), 'unknown');
    assert.equal(clientIpKey('not-an-ip'), 'unknown');
  });
});
