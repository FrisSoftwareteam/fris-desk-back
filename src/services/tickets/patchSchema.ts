import { Types } from 'mongoose';
import { z } from 'zod';
import { TICKET_PRIORITIES, TICKET_STATUSES } from '../../shared.js';

// Request shapes for changing enquiries, one at a time (PATCH /tickets/:id) or several at once
// (POST /tickets/bulk, GAP_ANALYSIS G-04.2). Kept free of models so tests can import them.

export const MAX_BULK = 200;

const objectId = z.string().refine((s) => Types.ObjectId.isValid(s), 'Invalid id');

const FollowUpBody = z
  .object({
    at: z.iso.datetime({ offset: true }),
    note: z.string().trim().max(500).default(''),
    hide: z.boolean().default(false),
  })
  .strict();

const fields = {
  isUnread: z.boolean(),
  status: z.enum(TICKET_STATUSES),
  statusReasonId: objectId.nullable(),
  assigneeId: objectId.nullable(),
  folderId: objectId.nullable(),
  priority: z.enum(TICKET_PRIORITIES),
  followUp: FollowUpBody.nullable(),
};

export const PatchBody = z
  .object({ ...fields, categoryIds: z.array(objectId).max(20) })
  .partial()
  .strict();

export const BulkBody = z
  .object({
    ids: z.array(objectId).min(1).max(MAX_BULK, `Select at most ${MAX_BULK} enquiries at a time`),
    patch: z
      .object({ ...fields, addCategoryIds: z.array(objectId).max(20), removeCategoryIds: z.array(objectId).max(20) })
      .partial()
      .strict()
      .refine((p) => Object.keys(p).length > 0, 'Nothing to change'),
  })
  .strict();

export const BulkIdsBody = z.object({ ids: z.array(objectId).min(1).max(MAX_BULK) }).strict();

export type TicketPatch = z.infer<typeof PatchBody>;
export type BulkPatch = z.infer<typeof BulkBody>['patch'];

/** A bulk patch's categories, applied to one enquiry's current ones (order kept, no duplicates). */
export function nextCategoryIds(current: string[], add: string[] = [], remove: string[] = []): string[] {
  const removed = new Set(remove);
  return [...new Set([...current, ...add])].filter((id) => !removed.has(id));
}
