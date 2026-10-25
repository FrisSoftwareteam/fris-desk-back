import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { createEntraVerifier } from '../src/services/auth/entraToken.ts';
import { createSessionTokens } from '../src/services/auth/sessionToken.ts';

const TENANT = '11111111-1111-1111-1111-111111111111';
const CLIENT = '22222222-2222-2222-2222-222222222222';

describe('Entra access token verification', () => {
  let sign: (
    claims: JWTPayload,
    opts?: { issuer?: string; audience?: string; expiresIn?: string | number },
  ) => Promise<string>;
  let verify: ReturnType<typeof createEntraVerifier>;
  let signWithOtherKey: typeof sign;

  before(async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const other = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' };
    verify = createEntraVerifier({ tenantId: TENANT, clientId: CLIENT, getKey: createLocalJWKSet({ keys: [jwk] }) });

    const make =
      (key: CryptoKey): typeof sign =>
      (claims, opts = {}) =>
        new SignJWT({
          tid: TENANT,
          oid: 'oid-1',
          scp: 'access_as_user',
          preferred_username: 'Ada@Example.com',
          name: 'Ada Obi',
          ...claims,
        })
          .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
          .setIssuer(opts.issuer ?? `https://login.microsoftonline.com/${TENANT}/v2.0`)
          .setAudience(opts.audience ?? CLIENT)
          .setIssuedAt()
          .setExpirationTime(opts.expiresIn ?? '1h')
          .sign(key);
    sign = make(privateKey);
    signWithOtherKey = make(other.privateKey);
  });

  it('accepts a valid v2 token and normalises the email', async () => {
    assert.deepEqual(await verify(await sign({})), {
      entraId: 'oid-1',
      email: 'ada@example.com',
      displayName: 'Ada Obi',
    });
  });

  it('accepts a v1 token (sts.windows.net issuer, api:// audience)', async () => {
    const token = await sign({}, { issuer: `https://sts.windows.net/${TENANT}/`, audience: `api://${CLIENT}` });
    assert.equal((await verify(token)).entraId, 'oid-1');
  });

  it('rejects a token signed by an unknown key', async () => {
    await assert.rejects(verify(await signWithOtherKey({})));
  });

  it('rejects a token for another audience (e.g. a Microsoft Graph token)', async () => {
    await assert.rejects(verify(await sign({}, { audience: 'https://graph.microsoft.com' })));
  });

  it('rejects a token from another tenant', async () => {
    await assert.rejects(verify(await sign({ tid: 'someone-else' })), /different tenant/);
  });

  it('rejects a token without the access_as_user scope', async () => {
    await assert.rejects(verify(await sign({ scp: 'User.Read' })), /scope/);
  });

  it('rejects an expired token', async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    await assert.rejects(verify(await sign({}, { expiresIn: past })), /exp/);
  });
});

describe('App session tokens', () => {
  const tokens = createSessionTokens('x'.repeat(32), 1);

  it('round-trips the user id', async () => {
    assert.equal(await tokens.verify(await tokens.sign('user-123')), 'user-123');
  });

  it('rejects a token signed with a different secret', async () => {
    const other = createSessionTokens('y'.repeat(32), 1);
    await assert.rejects(tokens.verify(await other.sign('user-123')));
  });

  it('rejects a tampered token', async () => {
    const token = await tokens.sign('user-123');
    const [h, , s] = token.split('.');
    const forged = `${h}.${Buffer.from(JSON.stringify({ sub: 'admin' })).toString('base64url')}.${s}`;
    await assert.rejects(tokens.verify(forged));
  });
});
