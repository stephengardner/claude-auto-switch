import { z } from 'zod';

/** One rate-limit record. `capUntil` is epoch ms, or null for an indefinite cap. */
export const CapRecordSchema = z.object({
  account: z.string(),
  capUntil: z.number().nullable(),
  reason: z.string(),
  at: z.number(),
});

export type CapRecord = z.infer<typeof CapRecordSchema>;

export const LedgerSchema = z.object({
  caps: z.array(CapRecordSchema).default([]),
});

export type Ledger = z.infer<typeof LedgerSchema>;
