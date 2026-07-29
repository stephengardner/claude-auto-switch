import { z } from 'zod';

/**
 * User configuration (spec section 7). Every key is optional in the file; the
 * schema fills defaults so `loadConfig` always returns a fully-populated object.
 */
export const ConfigSchema = z.object({
  profilesDir: z.string().optional(),
  priorityOrder: z.array(z.string()).default([]),
  browser: z
    .object({
      debugPort: z.number().int().positive().default(9222),
      channel: z.string().default('chrome'),
    })
    .default({}),
  rotation: z
    .object({
      autoRotateHeadless: z.boolean().default(true),
      autoRelaunchInteractive: z.boolean().default(true),
      defaultBackoffMinutes: z.number().int().positive().default(300),
      capThresholdPercent: z.number().int().min(1).max(100).default(95),
      /** Move off an account once its binding window hits this percent (0 = off). */
      proactivePercent: z.number().int().min(0).max(100).default(90),
      /** Require this many points more headroom on the target (anti-flap). */
      proactiveHysteresisPercent: z.number().int().min(0).max(100).default(10),
      /** How often a running session checks its own usage. */
      usageCheckSeconds: z.number().int().positive().default(300),
    })
    .default({}),
  realClaudePath: z.string().nullable().default(null),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Deep-partial shape for file input, env overrides, and saveConfig. */
export interface PartialConfig {
  profilesDir?: string;
  priorityOrder?: string[];
  browser?: { debugPort?: number; channel?: string };
  rotation?: {
    autoRotateHeadless?: boolean;
    autoRelaunchInteractive?: boolean;
    defaultBackoffMinutes?: number;
    capThresholdPercent?: number;
    proactivePercent?: number;
    proactiveHysteresisPercent?: number;
    usageCheckSeconds?: number;
  };
  realClaudePath?: string | null;
}
