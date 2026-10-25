// Extension point for the shareholder registry integration (xchange / ProjectT) — BUILD_SPEC §1, §9.
// Out of scope for the MVP: the stub always returns null. Swap in a real implementation later
// without touching routes or the UI.

export interface ShareholderHolding {
  company: string;
  units: number;
}

export interface ShareholderRecord {
  accountNumber: string;
  name: string;
  email: string;
  holdings: ShareholderHolding[];
  mandateStatus: 'active' | 'pending' | 'none' | 'unknown';
}

export interface ShareholderLookup {
  findByEmail(email: string): Promise<ShareholderRecord | null>;
}

export class StubShareholderLookup implements ShareholderLookup {
  async findByEmail(_email: string): Promise<ShareholderRecord | null> {
    return null;
  }
}

export const shareholderLookup: ShareholderLookup = new StubShareholderLookup();
