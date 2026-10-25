import { Schema, model } from 'mongoose';

// Atomic sequences, e.g. one per year for ticket references.
const counterSchema = new Schema({
  _id: { type: String, required: true },
  seq: { type: Number, required: true, default: 0 },
});

const CounterModel = model('Counter', counterSchema, 'counters');

export async function nextSequence(name: string): Promise<number> {
  const doc = await CounterModel.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' },
  );
  return doc.seq;
}

/** Human ticket reference, e.g. REG-2026-001042 (sequential per year). */
export async function nextTicketReference(now = new Date()): Promise<string> {
  const year = now.getUTCFullYear();
  const seq = await nextSequence(`ticket-${year}`);
  return `REG-${year}-${String(seq).padStart(6, '0')}`;
}
