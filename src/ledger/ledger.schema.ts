import { z } from 'zod';

/** One rate-limit record. `capUntil` is epoch ms, or null for an indefinite cap. */
export const CapRecordSchema = z.object({
  account: z.string(),
  capUntil: z.number().nullable(),
  reason: z.string(),
  at: z.number(),
  /**
   * The model this limit applies to, when only one model is out (for example
   * Fable's weekly window). Absent means the whole account is out.
   *
   * This distinction is the difference between "you cannot work" and "you cannot
   * work on this model", and getting it wrong stops you from starting a session
   * on a model that is perfectly available.
   */
  model: z.string().max(64).optional(),
});

export type CapRecord = z.infer<typeof CapRecordSchema>;

export const LedgerSchema = z.object({
  caps: z.array(CapRecordSchema).default([]),
});

export type Ledger = z.infer<typeof LedgerSchema>;
