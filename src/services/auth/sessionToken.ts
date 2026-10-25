import { jwtVerify, SignJWT } from 'jose';

const ISSUER = 'registrar-desk';
const AUDIENCE = 'registrar-desk-web';

/** The app's own session token (HS256), issued after a successful sign-in. Holds only the user id. */
export function createSessionTokens(secret: string, ttlHours: number) {
  const key = new TextEncoder().encode(secret);

  return {
    ttlMs: ttlHours * 60 * 60 * 1000,

    sign(userId: string): Promise<string> {
      return new SignJWT({})
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(userId)
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setIssuedAt()
        .setExpirationTime(`${ttlHours}h`)
        .sign(key);
    },

    /** Returns the user id, or throws if the token is invalid or expired. */
    async verify(token: string): Promise<string> {
      const { payload } = await jwtVerify(token, key, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ['HS256'],
      });
      if (!payload.sub) throw new Error('Session token has no subject');
      return payload.sub;
    },
  };
}
