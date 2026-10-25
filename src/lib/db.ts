import mongoose from 'mongoose';
import type { HealthResponse } from '../shared.js';
import { env } from '../config/env.js';
import { logger } from './logger.js';

const RETRY_DELAY_MS = 5_000;

mongoose.set('strictQuery', true);

mongoose.connection.on('connected', () => logger.info('MongoDB connected'));
mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
mongoose.connection.on('error', (err) => logger.error({ err }, 'MongoDB connection error'));

/**
 * Connects to MongoDB, retrying the initial connection until it succeeds. The HTTP server starts
 * regardless so /api/health can report the database state instead of the process crashing.
 * After the first connection, the driver handles reconnects itself.
 */
export async function connectDb(): Promise<void> {
  for (;;) {
    try {
      await mongoose.connect(env.MONGODB_URI, {
        serverSelectionTimeoutMS: 10_000,
        maxPoolSize: 20,
        appName: 'registrar-desk',
      });
      return;
    } catch (err) {
      logger.error({ err }, `MongoDB initial connection failed; retrying in ${RETRY_DELAY_MS / 1000}s`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}

export function dbState(): HealthResponse['db'] {
  switch (mongoose.connection.readyState) {
    case mongoose.ConnectionStates.connected:
      return 'connected';
    case mongoose.ConnectionStates.connecting:
      return 'connecting';
    default:
      return 'disconnected';
  }
}
