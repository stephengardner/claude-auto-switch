import { z } from 'zod';

/**
 * A registered account (spec 6.2). `dir` is its CLAUDE_CONFIG_DIR. The name is
 * constrained to a filesystem-safe charset (no separators or `..`) because it is
 * used to build paths; this is defense in depth for a registry that may be
 * copied between machines. Length caps bound memory for hand-edited files.
 */
export const AccountSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._-]+$/, 'account name must be letters, digits, dot, dash, underscore'),
  dir: z.string().min(1).max(4096),
  plan: z.string().max(64).optional(),
  email: z.string().max(320).optional(),
  priority: z.number().int(),
  enabled: z.boolean().default(true),
  browserProfile: z.string().max(256).optional(),
});

export type Account = z.infer<typeof AccountSchema>;

export const RegistrySchema = z.object({
  accounts: z.array(AccountSchema).max(1000).default([]),
});

export type Registry = z.infer<typeof RegistrySchema>;
