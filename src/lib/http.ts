import type { Request } from 'express';
import type { z } from 'zod';

/** Throw from a route to send `{ error }` with the given status (handled in app.ts). */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Validates `req.body` with a Zod schema; a failure becomes a 400 via the error handler. */
export function parseBody<S extends z.ZodType>(schema: S, req: Request): z.infer<S> {
  return schema.parse(req.body);
}

/**
 * Validates a partial update: like `parseBody`, but keeps only the fields the client sent, so a
 * schema's `.default()` values (which Zod applies even under `.partial()`) never overwrite stored data.
 */
export function parsePatch<S extends z.ZodType>(schema: S, req: Request): Partial<z.infer<S>> {
  const parsed = schema.parse(req.body) as Record<string, unknown>;
  const sent = new Set(Object.keys((req.body ?? {}) as object));
  return Object.fromEntries(Object.entries(parsed).filter(([k]) => sent.has(k))) as Partial<z.infer<S>>;
}
