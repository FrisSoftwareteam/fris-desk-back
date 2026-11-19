import { Types } from 'mongoose';
import { z } from 'zod';
import { AUTO_RESOLVE_DAYS, NOT_ENQUIRY_REASONS, TICKET_PRIORITIES, TICKET_STATUSES } from '../../shared.js';

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
  autoResolveDays: z
    .number()
    .refine((n) => (AUTO_RESOLVE_DAYS as readonly number[]).includes(n), 'Choose one of the offered periods')
    .nullable(),
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

const notEnquiryFields = {
  reason: z.enum(NOT_ENQUIRY_REASONS),
  note: z.string().trim().max(500).default(''),
};
const noteForOther = (b: { reason: string; note: string }) => b.reason !== 'other' || b.note.length > 0;
const noteMessage = { message: 'Say why it is not an enquiry', path: ['note'] };

export const NotEnquiryBody = z.object(notEnquiryFields).strict().refine(noteForOther, noteMessage);
export const BulkNotEnquiryBody = z
  .object({ ids: BulkIdsBody.shape.ids, ...notEnquiryFields })
  .strict()
  .refine(noteForOther, noteMessage);

export type TicketPatch = z.infer<typeof PatchBody>;
export type BulkPatch = z.infer<typeof BulkBody>['patch'];

/** A bulk patch's categories, applied to one enquiry's current ones (order kept, no duplicates). */
export function nextCategoryIds(current: string[], add: string[] = [], remove: string[] = []): string[] {
  const removed = new Set(remove);
  return [...new Set([...current, ...add])].filter((id) => !removed.has(id));
}
