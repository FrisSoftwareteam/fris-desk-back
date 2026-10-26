import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { ROLES, type AdminUserDto } from '../shared.js';
import { HttpError, parseBody, parsePatch } from '../lib/http.js';
import { audit } from '../models/AuditLog.js';
import { AssignmentRuleModel } from '../models/AssignmentRule.js';
import { SettingsModel } from '../models/Settings.js';
import { SlaPolicyModel } from '../models/SlaPolicy.js';
import { TicketModel } from '../models/Ticket.js';
import { UserModel, type User } from '../models/User.js';
import { currentUser, requireAuth, requireRole } from '../middleware/auth.js';
import { PENDING_ENTRA_PREFIX } from '../services/auth/index.js';
import { invalidateUsers } from '../services/auth/userCache.js';
import { disconnectUser } from '../services/realtime/io.js';

// Admin → Users (BUILD_SPEC §8.4): staff appear here after their first sign-in, or earlier if an
// admin adds them (with a role) ahead of time; their first Microsoft sign-in then links to that
// entry by email. Admins set roles and can disable an account. Accounts that have signed in are
// never deleted, so their history keeps a name; a pending entry can be removed (e.g. a typo).
export const usersRouter = Router();

const objectId = z.string().refine((s) => Types.ObjectId.isValid(s), 'Invalid id');
const admins = [requireAuth, requireRole('admin')];

type UserRow = User & { _id: Types.ObjectId; createdAt: Date };

const isPending = (u: Pick<User, 'entraId' | 'lastSignInAt'>) =>
  !u.lastSignInAt && u.entraId.startsWith(PENDING_ENTRA_PREFIX);

function toDto(u: UserRow): AdminUserDto {
  return {
    id: u._id.toString(),
    email: u.email,
    displayName: u.displayName,
    role: u.role,
    isActive: u.isActive,
    lastSignInAt: u.lastSignInAt ? u.lastSignInAt.toISOString() : null,
    createdAt: u.createdAt.toISOString(),
    pending: isPending(u),
  };
}

async function assertEmailFree(email: string, exceptId?: string): Promise<void> {
  const taken = await UserModel.exists({ email, ...(exceptId ? { _id: { $ne: exceptId } } : {}) });
  if (taken) throw new HttpError(409, 'Someone with that email is already on the list');
}

usersRouter.get('/admin/users', ...admins, async (_req, res) => {
  const users = await UserModel.find().sort({ isActive: -1, displayName: 1 }).lean();
  res.json(users.map((u) => toDto(u as UserRow)));
});

const email = z.string().trim().toLowerCase().pipe(z.email().max(254));
const displayName = z.string().trim().min(1).max(100);

const CreateBody = z.object({ email, displayName, role: z.enum(ROLES) }).strict();

usersRouter.post('/admin/users', ...admins, async (req, res) => {
  const body = parseBody(CreateBody, req);
  await assertEmailFree(body.email);

  const user = await UserModel.create({
    ...body,
    entraId: PENDING_ENTRA_PREFIX + body.email,
    isActive: true,
    lastSignInAt: null,
  });
  invalidateUsers();

  await audit({
    actorId: currentUser(req)._id,
    action: 'user.created',
    meta: { userId: user._id, email: user.email, role: user.role },
  });
  res.status(201).json(toDto(user.toObject()));
});

const PatchBody = z
  .object({ role: z.enum(ROLES), isActive: z.boolean(), email, displayName })
  .partial()
  .strict();

usersRouter.patch('/admin/users/:id', ...admins, async (req, res) => {
  const id = objectId.parse(req.params.id);
  const body = parsePatch(PatchBody, req);
  const me = currentUser(req);
  if (id === me.id && (body.role !== undefined || body.isActive !== undefined)) {
    // Stops an admin locking themselves (and possibly everyone) out.
    throw new HttpError(400, 'You can’t change your own role or disable your own account');
  }

  const user = await UserModel.findById(id);
  if (!user) throw new HttpError(404, 'User not found');
  if ((body.email !== undefined || body.displayName !== undefined) && !isPending(user)) {
    // After sign-in, the name and email come from their Microsoft account.
    throw new HttpError(400, 'Name and email can only be changed before the person first signs in');
  }
  if (body.email !== undefined && body.email !== user.email) await assertEmailFree(body.email, id);

  const before = { role: user.role, isActive: user.isActive, email: user.email, displayName: user.displayName };
  if (body.role) user.role = body.role;
  if (body.isActive !== undefined) user.isActive = body.isActive;
  if (body.displayName !== undefined) user.displayName = body.displayName;
  if (body.email !== undefined) {
    user.email = body.email;
    user.entraId = PENDING_ENTRA_PREFIX + body.email;
  }
  await user.save();
  invalidateUsers();
  // A disabled account loses its live connection now; its next request is refused anyway.
  if (!user.isActive) disconnectUser(user.id);

  await audit({
    actorId: me._id,
    action: 'user.updated',
    meta: {
      userId: user._id,
      email: user.email,
      before,
      after: { role: user.role, isActive: user.isActive, email: user.email, displayName: user.displayName },
    },
  });
  res.json(toDto(user.toObject()));
});

usersRouter.delete('/admin/users/:id', ...admins, async (req, res) => {
  const id = objectId.parse(req.params.id);
  const user = await UserModel.findById(id);
  if (!user) throw new HttpError(404, 'User not found');
  if (!isPending(user)) {
    throw new HttpError(400, 'Only people who haven’t signed in yet can be removed. Disable the account instead.');
  }

  const [assigned, inPool, inDefaultPool, slaContact] = await Promise.all([
    TicketModel.exists({ assigneeId: user._id }),
    AssignmentRuleModel.exists({ roundRobinPool: user._id }),
    SettingsModel.exists({ _id: 'app', defaultPool: user._id }),
    SlaPolicyModel.exists({ escalateToUserId: user._id }),
  ]);
  if (assigned || inPool || inDefaultPool || slaContact) {
    const where = [
      assigned && 'enquiries are assigned to them',
      inPool && 'they are in an assignment rule',
      inDefaultPool && 'they are in the default officer pool in Settings',
      slaContact && 'an SLA policy escalates to them',
    ].filter(Boolean);
    throw new HttpError(409, `Can’t remove: ${where.join(', ')}. Change those first, or disable the account instead.`);
  }

  await user.deleteOne();
  invalidateUsers();
  await audit({
    actorId: currentUser(req)._id,
    action: 'user.removed',
    meta: { userId: user._id, email: user.email },
  });
  res.status(204).end();
});
