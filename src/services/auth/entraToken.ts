import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

/** Delegated scope the web app requests for this API (Entra → Expose an API). */
export const API_SCOPE_NAME = 'access_as_user';

export interface EntraIdentity {
  entraId: string;
  email: string;
  displayName: string;
}

export interface EntraVerifierOptions {
  tenantId: string;
  clientId: string;
  /** Defaults to api://<clientId>. */
  audience?: string;
  /** Injected in tests; defaults to the tenant's published signing keys. */
  getKey?: JWTVerifyGetKey;
}

/**
 * Builds a validator for access tokens that MSAL issued to the web app for *this* API.
 * Accepts both v1 and v2 token formats, since which one Entra issues depends on the app manifest.
 * Throws if the signature, issuer, audience, tenant, expiry or scope is wrong.
 */
export function createEntraVerifier(options: EntraVerifierOptions) {
  const { tenantId, clientId } = options;
  const getKey =
    options.getKey ?? createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`));
  const audience = [options.audience ?? `api://${clientId}`, clientId];
  const issuer = [`https://login.microsoftonline.com/${tenantId}/v2.0`, `https://sts.windows.net/${tenantId}/`];

  return async function verifyEntraAccessToken(token: string): Promise<EntraIdentity> {
    const { payload } = await jwtVerify(token, getKey, {
      issuer,
      audience,
      algorithms: ['RS256'],
      clockTolerance: 60,
    });

    if (payload.tid !== tenantId) throw new Error('Token is from a different tenant');

    const scopes = typeof payload.scp === 'string' ? payload.scp.split(' ') : [];
    if (!scopes.includes(API_SCOPE_NAME)) throw new Error(`Token is missing the ${API_SCOPE_NAME} scope`);

    const entraId = payload.oid;
    const email = payload.preferred_username ?? payload.upn ?? payload.email;
    if (typeof entraId !== 'string' || typeof email !== 'string') {
      throw new Error('Token is missing the oid or username claim');
    }
    const name = typeof payload.name === 'string' && payload.name.trim() ? payload.name : email;

    return { entraId, email: email.toLowerCase(), displayName: name };
  };
}
