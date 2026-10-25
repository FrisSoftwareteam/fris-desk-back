import { UserModel, type UserDoc } from '../../models/User.js';

// Users change rarely, but every API request needs the signed-in user and most lists need officer
// names. Caching them briefly saves a database round trip per request (Atlas can be ~250ms away).
// Anything that changes a user calls `invalidateUsers()`; otherwise entries expire after TTL_MS,
// so a disabled account loses access within a minute even if it was changed directly in the DB.

const TTL_MS = 60_000;

const byId = new Map<string, { user: UserDoc; expires: number }>();
let names: { map: Map<string, string>; expires: number } | null = null;

export async function getUserById(id: string): Promise<UserDoc | null> {
  const hit = byId.get(id);
  if (hit && hit.expires > Date.now()) return hit.user;
  const user = await UserModel.findById(id);
  if (user) byId.set(id, { user, expires: Date.now() + TTL_MS });
  else byId.delete(id);
  return user;
}

/** Display names of all users (including inactive, so old assignments still show a name). */
export async function getUserNames(): Promise<Map<string, string>> {
  if (names && names.expires > Date.now()) return names.map;
  const users = await UserModel.find({}, { displayName: 1 }).lean();
  names = { map: new Map(users.map((u) => [u._id.toString(), u.displayName])), expires: Date.now() + TTL_MS };
  return names.map;
}

export function invalidateUsers(): void {
  byId.clear();
  names = null;
}
