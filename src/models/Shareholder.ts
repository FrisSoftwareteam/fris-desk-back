import { Schema, model, type InferSchemaType } from 'mongoose';

// `shareholders` — details officers save about a shareholder (GAP_ANALYSIS G-01.1).
// One record per person; a person can hold shares in several companies.
const holdingSchema = new Schema(
  {
    company: { type: String, trim: true, default: '' },
    chn: { type: String, trim: true, default: '' },
    cscsNumber: { type: String, trim: true, default: '' },
  },
  { _id: false },
);

const shareholderSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    // Empty for phone / walk-in shareholders with no email.
    email: { type: String, lowercase: true, trim: true, default: '' },
    phone: { type: String, trim: true, default: '' },
    address: { type: String, trim: true, default: '' },
    holdings: { type: [holdingSchema], default: [] },
    createdById: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    updatedById: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

// One record per email address; records without an email aren't constrained.
shareholderSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { email: { $gt: '' } } });
shareholderSchema.index({ 'holdings.chn': 1 });
shareholderSchema.index({ 'holdings.cscsNumber': 1 });
shareholderSchema.index({ updatedAt: -1 });

export type Shareholder = InferSchemaType<typeof shareholderSchema>;
export const ShareholderModel = model('Shareholder', shareholderSchema, 'shareholders');
