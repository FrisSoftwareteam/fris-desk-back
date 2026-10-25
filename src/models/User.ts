import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { ROLES, type UserDto } from '../shared.js';

// `users` — staff who sign in (BUILD_SPEC §5).
const userSchema = new Schema(
  {
    // Entra object id (`oid` claim). Developer sign-ins use `dev:<email>`.
    entraId: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    displayName: { type: String, required: true, trim: true },
    role: { type: String, enum: ROLES, required: true, default: 'agent' },
    isActive: { type: Boolean, required: true, default: true },
    lastSignInAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export type User = InferSchemaType<typeof userSchema>;
export type UserDoc = HydratedDocument<User>;

export const UserModel = model('User', userSchema, 'users');

export function toUserDto(user: UserDoc): UserDto {
  return {
    id: user._id.toString(),
    email: user.email,
    displayName: user.displayName,
    role: user.role,
  };
}
