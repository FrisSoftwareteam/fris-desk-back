import { createServer } from 'node:http';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { connectDb, disconnectDb } from './lib/db.js';
import { createApp } from './app.js';
import { startJobs, stopJobs } from './jobs/index.js';
import { attachRealtime, closeRealtime } from './services/realtime/io.js';

const server = createServer(createApp());
attachRealtime(server);

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    logger.fatal(
      `Port ${env.PORT} is already in use — another copy of the backend is probably running. ` +
        'Stop it (or set a different PORT) and start again.',
    );
    process.exit(1);
  }
  throw err;
});

server.listen(env.PORT, () => {
  logger.info(`Registrar Desk API listening on ${env.APP_BASE_URL} (port ${env.PORT})`);
});

// Connect once the port is ours, so a duplicate copy exits before it can start syncing mail.
server.once('listening', () => void connectDb().then(startJobs));

/** Longest a shutdown may take before the process exits anyway (hosts stop waiting at ~30s). */
const SHUTDOWN_TIMEOUT_MS = 20_000;
let shuttingDown = false;

// Hosts (Azure App Service on every deploy or restart) send SIGTERM and expect a prompt exit.
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received, shutting down`);
  setTimeout(() => {
    logger.warn('Shutdown took too long; exiting');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();

  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      logger.error({ err }, `Shutdown: ${name} failed`);
    }
  };
  // Closes the HTTP server too, after disconnecting browsers' live connections.
  await step('closing connections', closeRealtime);
  // Waits for a mail sync in progress, so it doesn't fail against a closed database.
  await step('stopping jobs', stopJobs);
  await step('disconnecting the database', disconnectDb);
  process.exit(0);
}

// Last line of defence: a background job's unexpected failure is logged, not fatal to the API.
process.on('unhandledRejection', (err) => logger.error({ err }, 'Unhandled promise rejection'));

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
