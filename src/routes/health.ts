import { Router } from 'express';
import mongoose from 'mongoose';
import type { HealthResponse } from '../shared.js';
import { dbState } from '../lib/db.js';

const VERSION = process.env.npm_package_version ?? '0.1.0';

export const healthRouter = Router();

// Public, unauthenticated. Returns 503 when the database is unreachable so load balancers and
// uptime checks treat the instance as unhealthy.
healthRouter.get('/health', async (_req, res) => {
  let db = dbState();
  if (db === 'connected') {
    try {
      await mongoose.connection.db?.admin().ping();
    } catch {
      db = 'disconnected';
    }
  }

  const body: HealthResponse = {
    status: db === 'connected' ? 'ok' : 'degraded',
    db,
    uptimeSeconds: Math.round(process.uptime()),
    version: VERSION,
    timestamp: new Date().toISOString(),
  };
  res.status(db === 'connected' ? 200 : 503).json(body);
});
