import type { Server as HttpServer } from 'node:http';
import { Types } from 'mongoose';
import { Server } from 'socket.io';
import type { ClientToServerEvents, PresenceViewerDto, ServerToClientEvents } from '../../shared.js';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { sessionTokens } from '../auth/index.js';
import { getUserById } from '../auth/userCache.js';
import { setChangeSink } from './changes.js';
import { setNotificationSink } from '../notifications/notify.js';
import { PresenceTracker } from './presence.js';

// Socket.IO (BUILD_SPEC §7 "Collision detection"): presence per enquiry and live list updates.
// Connections authenticate with the same session token as the REST API (handshake `auth.token`).

type IO = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, { userId: string }>;

const STAFF_ROOM = 'staff';
const ticketRoom = (id: string) => `ticket:${id}`;
const userRoom = (id: string) => `user:${id}`;
const presence = new PresenceTracker();
let io: IO | null = null;

/** Who is viewing an enquiry right now (also served at GET /tickets/:id/presence). */
export function currentViewers(ticketId: string): PresenceViewerDto[] {
  return presence.viewers(ticketId);
}

export function attachRealtime(server: HttpServer): void {
  io = new Server(server, {
    path: '/socket.io',
    cors: { origin: env.FRONTEND_ORIGIN },
    // Browsers always send Origin on WebSocket upgrades; refusing other sites stops a page
    // elsewhere from connecting to the live feed (cross-site WebSocket hijacking).
    allowRequest: (req, callback) => callback(null, env.FRONTEND_ORIGIN.includes(req.headers.origin ?? '')),
  });

  io.use(async (socket, next) => {
    const raw: unknown = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
    const token = typeof raw === 'string' && raw ? raw : undefined;
    try {
      if (!token) throw new Error('no session');
      const user = await getUserById(await sessionTokens.verify(token));
      if (!user?.isActive) throw new Error('inactive');
      socket.data.userId = user.id;
      presence.connect(socket.id, { userId: user.id, displayName: user.displayName });
      next();
    } catch {
      next(new Error('Sign in required'));
    }
  });

  const broadcastPresence = (ticketId: string) =>
    io?.to(ticketRoom(ticketId)).emit('presence', { ticketId, viewers: presence.viewers(ticketId) });
  const valid = (id: unknown): id is string => typeof id === 'string' && Types.ObjectId.isValid(id);

  io.on('connection', (socket) => {
    void socket.join(STAFF_ROOM);
    void socket.join(userRoom(socket.data.userId));

    socket.on('ticket:join', (ticketId) => {
      if (!valid(ticketId) || !presence.join(socket.id, ticketId)) return;
      void socket.join(ticketRoom(ticketId));
      broadcastPresence(ticketId);
    });

    socket.on('ticket:leave', (ticketId) => {
      if (!valid(ticketId) || !presence.leave(socket.id, ticketId)) return;
      void socket.leave(ticketRoom(ticketId));
      broadcastPresence(ticketId);
    });

    socket.on('ticket:replying', (p) => {
      if (!valid(p?.ticketId) || typeof p.replying !== 'boolean') return;
      if (presence.setReplying(socket.id, p.ticketId, p.replying)) broadcastPresence(p.ticketId);
    });

    socket.on('disconnect', () => {
      for (const ticketId of presence.disconnect(socket.id)) broadcastPresence(ticketId);
    });
  });

  setChangeSink((ticketIds) => io?.to(STAFF_ROOM).emit('tickets:changed', { ticketIds }));
  setNotificationSink((userId, n) => io?.to(userRoom(userId)).emit('notification', n));
  logger.info('Real-time updates ready (Socket.IO)');
}

/** Drops a user's live connections, e.g. when an admin disables their account. */
export function disconnectUser(userId: string): void {
  if (!io) return;
  for (const socket of io.sockets.sockets.values()) {
    if (socket.data.userId === userId) socket.disconnect(true);
  }
}

export async function closeRealtime(): Promise<void> {
  await io?.close();
  io = null;
}
