import type { PresenceViewerDto } from '../../shared.js';

// Who has which enquiry open, per browser connection (BUILD_SPEC §7 "Collision detection").
// In memory: fine for one API process. Running several behind a load balancer would need the
// Socket.IO Redis adapter and a shared store here.

interface Connection {
  userId: string;
  displayName: string;
  /** Ticket ids open in this connection → whether they're replying there. */
  tickets: Map<string, boolean>;
}

export class PresenceTracker {
  private connections = new Map<string, Connection>();

  connect(connectionId: string, user: { userId: string; displayName: string }): void {
    this.connections.set(connectionId, { ...user, tickets: new Map() });
  }

  /** Forgets the connection; returns the tickets whose viewer list changed. */
  disconnect(connectionId: string): string[] {
    const c = this.connections.get(connectionId);
    this.connections.delete(connectionId);
    return c ? [...c.tickets.keys()] : [];
  }

  /** Returns false if the connection is unknown. */
  join(connectionId: string, ticketId: string): boolean {
    const c = this.connections.get(connectionId);
    if (!c) return false;
    if (!c.tickets.has(ticketId)) c.tickets.set(ticketId, false);
    return true;
  }

  leave(connectionId: string, ticketId: string): boolean {
    return this.connections.get(connectionId)?.tickets.delete(ticketId) ?? false;
  }

  /** Only for a ticket the connection has joined; returns whether anything changed. */
  setReplying(connectionId: string, ticketId: string, replying: boolean): boolean {
    const c = this.connections.get(connectionId);
    if (!c?.tickets.has(ticketId) || c.tickets.get(ticketId) === replying) return false;
    c.tickets.set(ticketId, replying);
    return true;
  }

  /** One entry per officer viewing the ticket; replying if they are in any of their tabs. */
  viewers(ticketId: string): PresenceViewerDto[] {
    const byUser = new Map<string, PresenceViewerDto>();
    for (const c of this.connections.values()) {
      if (!c.tickets.has(ticketId)) continue;
      const replying = c.tickets.get(ticketId)!;
      const seen = byUser.get(c.userId);
      if (seen) seen.replying ||= replying;
      else byUser.set(c.userId, { userId: c.userId, displayName: c.displayName, replying });
    }
    return [...byUser.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
  }
}
