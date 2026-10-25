import { z } from 'zod';

// All configuration comes from the environment (backend/.env, see .env.example and BUILD_SPEC §8.1).
// Azure/Graph values are optional in Phase 0 so the server can boot without them; the phases that
// need them (1: auth, 2: Graph) call `requireEnv` to fail loudly when they are missing.
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4848),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  MONGODB_URI: z
    .string({ error: 'MONGODB_URI is required — set it in backend/.env' })
    .regex(/^mongodb(\+srv)?:\/\//, 'MONGODB_URI must start with mongodb:// or mongodb+srv://'),

  APP_BASE_URL: z.url().default('http://localhost:4848'),
  // The web app's origin(s), comma-separated (e.g. the production site plus a fixed preview alias).
  // Only these may call the API from a browser or open the live connection.
  FRONTEND_ORIGIN: z
    .string()
    .default('http://localhost:3000')
    .transform((s, ctx) => {
      const origins: string[] = [];
      for (const part of s.split(',').map((p) => p.trim()).filter(Boolean)) {
        try {
          // Browsers send the bare origin (no path or trailing slash), so normalise to that.
          origins.push(new URL(part).origin);
        } catch {
          ctx.addIssue({ code: 'custom', message: `FRONTEND_ORIGIN: "${part}" is not a URL` });
        }
      }
      return origins;
    }),

  AZURE_TENANT_ID: z.string().optional(),
  AZURE_CLIENT_ID: z.string().optional(),
  // Audience of the staff sign-in token. Defaults to api://<AZURE_CLIENT_ID> (see README, "Expose an API").
  AZURE_API_AUDIENCE: z.string().optional(),
  AZURE_CLIENT_SECRET: z.string().optional(),
  GRAPH_SHARED_MAILBOX: z.email().optional(),
  GRAPH_WEBHOOK_URL: z.url().startsWith('https://', 'GRAPH_WEBHOOK_URL must be a public https:// URL').optional(),
  GRAPH_WEBHOOK_SECRET: z.string().min(16, 'GRAPH_WEBHOOK_SECRET must be at least 16 characters').optional(),
  // How often to check the mailbox for new mail (Graph delta). Push notifications, when configured,
  // make mail arrive sooner; polling still runs as the safety net for missed notifications.
  GRAPH_POLL_INTERVAL_SECONDS: z.coerce.number().int().min(15).max(3600).default(60),
  // On the very first sync, import Inbox mail received in the last N days (older mail is ignored).
  GRAPH_INITIAL_SYNC_DAYS: z.coerce.number().int().min(0).max(90).default(2),
  // Outgoing mail safety net. When set, email may ONLY be sent to these addresses (comma-separated);
  // anything else is refused. Outside production an empty list means nothing is sent at all, so a
  // development copy can never email a real shareholder by accident.
  MAIL_SEND_ALLOWLIST: z
    .string()
    .default('')
    .transform((s) =>
      s
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    ),
  // Where email attachments are kept: 'mailbox' fetches them from the shared mailbox when opened
  // (almost no database space; fine on a free Atlas tier); 'database' copies them into GridFS.
  ATTACHMENT_STORAGE: z.enum(['mailbox', 'database']).default('mailbox'),
  // Turn mailbox syncing off (e.g. on a second developer machine sharing the same database).
  GRAPH_SYNC_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  JWT_SECRET: z
    .string({ error: 'JWT_SECRET is required — generate one (see .env.example)' })
    .min(32, 'JWT_SECRET must be at least 32 characters'),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(10),
  // Comma-separated emails that are made admins on first sign-in (bootstraps the first admin).
  BOOTSTRAP_ADMIN_EMAILS: z
    .string()
    .default('')
    .transform((s) =>
      s
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    ),
  // Developer sign-in without Microsoft (local development only — refused in production).
  AUTH_DEV_LOGIN: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  // Treat empty strings from .env (e.g. `AZURE_CLIENT_ID=`) as unset.
  const raw = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => value !== undefined && value !== ''),
  );
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    console.error(`Invalid backend environment:\n${issues}`);
    process.exit(1);
  }
  if (parsed.data.NODE_ENV === 'production' && parsed.data.AUTH_DEV_LOGIN) {
    console.error('AUTH_DEV_LOGIN=true is not allowed when NODE_ENV=production');
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();

/** True when the Entra ID values needed to validate Microsoft sign-in tokens are configured. */
export const microsoftSignInConfigured = Boolean(env.AZURE_TENANT_ID && env.AZURE_CLIENT_ID);

/** True when the app-only Graph credentials and shared mailbox are configured. */
export const graphConfigured = Boolean(
  env.AZURE_TENANT_ID && env.AZURE_CLIENT_ID && env.AZURE_CLIENT_SECRET && env.GRAPH_SHARED_MAILBOX,
);

/** Push notifications need a public URL and a secret to verify them. */
export const graphWebhookConfigured = Boolean(graphConfigured && env.GRAPH_WEBHOOK_URL && env.GRAPH_WEBHOOK_SECRET);

/** Returns a config value that a later phase depends on, or throws with a clear message. */
export function requireEnv<K extends keyof Env>(key: K): NonNullable<Env[K]> {
  const value = env[key];
  if (value === undefined || value === null) {
    throw new Error(`${String(key)} is not set — add it to backend/.env (see .env.example)`);
  }
  return value as NonNullable<Env[K]>;
}
