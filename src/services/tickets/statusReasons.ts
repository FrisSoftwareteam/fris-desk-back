import { StatusReasonModel } from '../../models/StatusReason.js';
import type { StatusReasonDto } from '../../shared.js';

// Stages are read on every list, so they're cached briefly like officer names. Admin edits call
// invalidateStatusReasons().

const TTL_MS = 60_000;
let cache: { list: StatusReasonDto[]; byId: Map<string, StatusReasonDto>; expires: number } | null = null;

/** Every stage, active or not (an enquiry keeps showing a stage that has since been retired). */
export async function getStatusReasons(): Promise<Map<string, StatusReasonDto>> {
  if (cache && cache.expires > Date.now()) return cache.byId;
  const docs = await StatusReasonModel.find().sort({ baseStatus: 1, order: 1, name: 1 }).lean();
  const list: StatusReasonDto[] = docs.map((d) => ({
    id: d._id.toString(),
    name: d.name,
    baseStatus: d.baseStatus,
    order: d.order,
    isActive: d.isActive,
  }));
  cache = { list, byId: new Map(list.map((r) => [r.id, r])), expires: Date.now() + TTL_MS };
  return cache.byId;
}

export async function listStatusReasons(): Promise<StatusReasonDto[]> {
  await getStatusReasons();
  return cache!.list;
}

export function invalidateStatusReasons(): void {
  cache = null;
}
