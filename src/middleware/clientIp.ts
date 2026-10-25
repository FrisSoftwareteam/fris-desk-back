import { isIP } from 'node:net';

/**
 * The client's IP without a port. Azure App Service's front end can forward `X-Forwarded-For` as
 * `203.0.113.7:51234`; keyed as-is, every connection would get its own rate-limit bucket.
 * Handles `a.b.c.d:port`, `[v6]:port` and IPv4-mapped IPv6 (`::ffff:a.b.c.d`).
 */
export function clientIpKey(ip: string | undefined): string {
  if (!ip) return 'unknown';
  let value = ip.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracketed) value = bracketed[1]!;
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(value)) value = value.slice(0, value.lastIndexOf(':'));
  if (value.toLowerCase().startsWith('::ffff:') && isIP(value.slice(7)) === 4) value = value.slice(7);
  return isIP(value) ? value : 'unknown';
}
