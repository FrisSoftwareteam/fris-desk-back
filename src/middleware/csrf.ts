import type { RequestHandler } from 'express';
import { CSRF_HEADER } from '../shared.js';
import { HttpError } from '../lib/http.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * State-changing requests must carry a custom header. Browsers only let a page send custom headers
 * cross-origin after a CORS preflight, which our CORS policy grants solely to FRONTEND_ORIGIN. Sessions
 * travel in an Authorization header (never sent automatically), so this mainly guards the routes that
 * take no token, such as developer sign-in.
 * `exemptPaths` are for server-to-server callers such as the Graph webhook (Phase 2).
 */
export function requireCsrfHeader(exemptPaths: string[] = []): RequestHandler {
  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method) || exemptPaths.includes(req.path)) return next();
    if (req.get(CSRF_HEADER) !== '1') throw new HttpError(403, 'Missing request header');
    next();
  };
}
