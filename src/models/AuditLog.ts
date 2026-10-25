import { Schema, model, type Types } from 'mongoose';
import { logger } from '../lib/logger.js';

// `auditLogs` — append-only record of every action (BUILD_SPEC §5, §10).
const auditLogSchema = new Schema({
  // A user id, or null for actions taken by the system (mail sync, cron jobs).
  actorId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  actorType: { type: String, enum: ['user', 'system'], required: true },
  action: { type: String, required: true },
  ticketId: { type: Schema.Types.ObjectId, ref: 'Ticket', default: null, index: true },
  meta: { type: Schema.Types.Mixed, default: {} },
  at: { type: Date, required: true, default: () => new Date(), index: true },
});

export const AuditLogModel = model('AuditLog', auditLogSchema, 'auditLogs');

export async function audit(entry: {
  actorId: Types.ObjectId | null;
  action: string;
  ticketId?: Types.ObjectId | null;
  meta?: Record<string, unknown>;
}): Promise<void> {
  try {
    await AuditLogModel.create({
      actorId: entry.actorId,
      actorType: entry.actorId ? 'user' : 'system',
      action: entry.action,
      ticketId: entry.ticketId ?? null,
      meta: entry.meta ?? {},
    });
  } catch (err) {
    // Auditing must never be silently lost; log loudly so it shows up in monitoring.
    logger.error({ err, entry }, 'Failed to write audit log');
  }
}
