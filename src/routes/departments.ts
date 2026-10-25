import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { DEPARTMENT_TYPES, type DepartmentDto } from '../shared.js';
import { HttpError, parseBody, parsePatch } from '../lib/http.js';
import { audit } from '../models/AuditLog.js';
import { DepartmentModel, type Department } from '../models/Department.js';
import { MessageModel } from '../models/Message.js';
import { TicketModel } from '../models/Ticket.js';
import { currentUser, requireAuth, requireRole } from '../middleware/auth.js';
import { escalateTicket } from '../services/tickets/escalate.js';
import { toTicketDetail } from '../services/tickets/dto.js';

// Escalation directory (BUILD_SPEC §5 `departments`) and the Escalate action (§7 "Escalation flow").
// Everyone reads the active entries for the Escalate menu; admins maintain the list.
export const departmentsRouter = Router();

const objectId = z.string().refine((s) => Types.ObjectId.isValid(s), 'Invalid id');
const DepartmentBody = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.email('Enter a valid email address').max(320),
  type: z.enum(DEPARTMENT_TYPES).default('department'),
  description: z.string().trim().max(300).default(''),
  order: z.number().int().min(0).max(10_000).default(0),
  isActive: z.boolean().default(true),
});

function toDto(d: Department & { _id: Types.ObjectId }): DepartmentDto {
  return {
    id: d._id.toString(),
    name: d.name,
    email: d.email,
    type: d.type,
    description: d.description,
    order: d.order,
    isActive: d.isActive,
  };
}

// GET /departments — active entries in menu order; ?all=true (admins) includes inactive ones.
departmentsRouter.get('/departments', requireAuth, async (req, res) => {
  const all = req.query.all === 'true' && currentUser(req).role === 'admin';
  const list = await DepartmentModel.find(all ? {} : { isActive: true })
    .sort({ order: 1, name: 1 })
    .lean();
  res.json(list.map(toDto));
});

departmentsRouter.post('/departments', requireAuth, requireRole('admin'), async (req, res) => {
  const d = await DepartmentModel.create(parseBody(DepartmentBody, req));
  await audit({
    actorId: currentUser(req)._id,
    action: 'department.created',
    meta: { departmentId: d._id, name: d.name, email: d.email },
  });
  res.status(201).json(toDto(d.toObject()));
});

departmentsRouter.patch('/departments/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const body = parsePatch(DepartmentBody.partial().strict(), req);
  const d = await DepartmentModel.findByIdAndUpdate(objectId.parse(req.params.id), body, {
    returnDocument: 'after',
    runValidators: true,
  }).lean();
  if (!d) throw new HttpError(404, 'Department not found');
  await audit({
    actorId: currentUser(req)._id,
    action: 'department.updated',
    meta: { departmentId: d._id, changes: body },
  });
  res.json(toDto(d));
});

// Enquiries escalated here keep their history (the audit entry records the name and address).
departmentsRouter.delete('/departments/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const d = await DepartmentModel.findByIdAndDelete(objectId.parse(req.params.id)).lean();
  if (!d) throw new HttpError(404, 'Department not found');
  await audit({
    actorId: currentUser(req)._id,
    action: 'department.deleted',
    meta: { departmentId: d._id, name: d.name, email: d.email },
  });
  res.status(204).end();
});

const EscalateBody = z.object({
  departmentId: objectId,
  note: z.string().max(10_000).default(''),
});

// POST /tickets/:id/escalate — forward the thread to a department or person; mark it escalated.
departmentsRouter.post('/tickets/:id/escalate', requireAuth, async (req, res) => {
  const body = parseBody(EscalateBody, req);
  const ticket = await TicketModel.findOne({ _id: objectId.parse(req.params.id), deletedAt: null });
  if (!ticket) throw new HttpError(404, 'Enquiry not found');
  const department = await DepartmentModel.findOne({ _id: body.departmentId, isActive: true }).lean();
  if (!department) throw new HttpError(400, 'That team is no longer in the escalation list');

  await escalateTicket(ticket, currentUser(req), department, body.note);
  const messages = await MessageModel.find({ ticketId: ticket._id }).sort({ sentAt: -1 });
  res.json(await toTicketDetail(ticket, messages));
});
