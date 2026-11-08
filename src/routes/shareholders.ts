import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import type { ShareholderDto } from '../shared.js';
import { HttpError, escapeRegex, parseBody, parsePatch } from '../lib/http.js';
import { audit } from '../models/AuditLog.js';
import { ShareholderModel, type Shareholder } from '../models/Shareholder.js';
import { currentUser, requireAuth, requireRole } from '../middleware/auth.js';

// Saved shareholder records (GAP_ANALYSIS G-01.1). Every officer can add, edit and look up records;
// only admins delete. Audit entries carry the id and email only, to keep holdings out of the log.
export const shareholdersRouter = Router();

const objectId = z.string().refine((s) => Types.ObjectId.isValid(s), 'Invalid id');
const text = (max: number) => z.string().trim().max(max).default('');
const ShareholderBody = z.object({
  name: z.string().trim().min(1, 'Enter the shareholder’s name').max(200),
  email: z.union([z.literal(''), z.email('Enter a valid email address').max(320)]).default(''),
  phone: text(40),
  address: text(1000),
  holdings: z
    .array(z.object({ company: text(200), chn: text(40), cscsNumber: text(40) }))
    .max(100)
    .default([])
    // Rows the officer left completely blank are dropped.
    .transform((rows) => rows.filter((r) => r.company || r.chn || r.cscsNumber)),
});

/** Matches the text anywhere in the name, contact details or any holding. */
export function shareholderSearchFilter(q: string) {
  const re = new RegExp(escapeRegex(q.trim()), 'i');
  return {
    $or: ['name', 'email', 'phone', 'address', 'holdings.company', 'holdings.chn', 'holdings.cscsNumber'].map(
      (field) => ({ [field]: re }),
    ),
  };
}

function toDto(s: Shareholder & { _id: Types.ObjectId }): ShareholderDto {
  return {
    id: s._id.toString(),
    name: s.name,
    email: s.email,
    phone: s.phone,
    address: s.address,
    holdings: s.holdings.map((h) => ({ company: h.company, chn: h.chn, cscsNumber: h.cscsNumber })),
    updatedAt: s.updatedAt.toISOString(),
  };
}

function isDuplicate(err: unknown) {
  return (err as { code?: number }).code === 11000;
}
const DUPLICATE = 'A shareholder with this email is already saved — open the existing record';

// GET /shareholders?q= — newest first; up to 50.
shareholdersRouter.get('/shareholders', requireAuth, async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 200) : '';
  const list = await ShareholderModel.find(q.trim() ? shareholderSearchFilter(q) : {})
    .sort({ updatedAt: -1 })
    .limit(50)
    .lean();
  res.json(list.map(toDto));
});

// GET /shareholders/by-email/:email — the record for an enquiry's sender, or 404 if none is saved.
shareholdersRouter.get('/shareholders/by-email/:email', requireAuth, async (req, res) => {
  const email = String(req.params.email).trim().toLowerCase();
  const s = email ? await ShareholderModel.findOne({ email }).lean() : null;
  if (!s) throw new HttpError(404, 'No saved record for this email');
  res.json(toDto(s));
});

shareholdersRouter.post('/shareholders', requireAuth, async (req, res) => {
  const body = parseBody(ShareholderBody, req);
  const me = currentUser(req)._id;
  const s = await ShareholderModel.create({ ...body, createdById: me, updatedById: me }).catch((err) => {
    throw isDuplicate(err) ? new HttpError(409, DUPLICATE) : err;
  });
  await audit({ actorId: me, action: 'shareholder.created', meta: { shareholderId: s._id, email: s.email } });
  res.status(201).json(toDto(s.toObject()));
});

shareholdersRouter.patch('/shareholders/:id', requireAuth, async (req, res) => {
  const body = parsePatch(ShareholderBody.partial().strict(), req);
  const me = currentUser(req)._id;
  const s = await ShareholderModel.findByIdAndUpdate(
    objectId.parse(req.params.id),
    { ...body, updatedById: me },
    { returnDocument: 'after', runValidators: true },
  )
    .lean()
    .catch((err) => {
      throw isDuplicate(err) ? new HttpError(409, DUPLICATE) : err;
    });
  if (!s) throw new HttpError(404, 'Shareholder not found');
  await audit({
    actorId: me,
    action: 'shareholder.updated',
    meta: { shareholderId: s._id, email: s.email, fields: Object.keys(body) },
  });
  res.json(toDto(s));
});

shareholdersRouter.delete('/shareholders/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const s = await ShareholderModel.findByIdAndDelete(objectId.parse(req.params.id)).lean();
  if (!s) throw new HttpError(404, 'Shareholder not found');
  await audit({
    actorId: currentUser(req)._id,
    action: 'shareholder.deleted',
    meta: { shareholderId: s._id, email: s.email },
  });
  res.status(204).end();
});
