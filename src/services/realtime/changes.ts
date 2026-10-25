// Live list updates (BUILD_SPEC §6 Phase 6): enquiries announce that they changed, and browsers
// refresh what they show. Changes are batched briefly so a burst (mail sync importing a dozen
// emails, an SLA recalculation) becomes one message rather than hundreds.

export class ChangeBatcher {
  private pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly delayMs: number,
    private readonly flush: (ticketIds: string[]) => void,
  ) {}

  add(ticketId: string): void {
    this.pending.add(ticketId);
    this.timer ??= setTimeout(() => {
      const ids = [...this.pending];
      this.pending.clear();
      this.timer = null;
      this.flush(ids);
    }, this.delayMs);
  }
}

let batcher: ChangeBatcher | null = null;

/** Called once the Socket.IO server is up. Until then (and in scripts) changes go nowhere. */
export function setChangeSink(flush: (ticketIds: string[]) => void, delayMs = 300): void {
  batcher = new ChangeBatcher(delayMs, flush);
}

/** Announce that an enquiry changed. Safe to call from anywhere, including model hooks. */
export function notifyTicketChanged(ticketId: string): void {
  batcher?.add(ticketId);
}
