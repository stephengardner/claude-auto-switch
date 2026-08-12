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
      /**
       * Move off an account once its binding window hits this percent.
       * OFF by default (0): moving a live session is something the operator
       * opts into, not a surprise. Turn it on with `ccx proactive on`.
       */
      proactivePercent: z.number().int().min(0).max(100).default(0),
      /** Require this many points more headroom on the target (anti-flap). */
      proactiveHysteresisPercent: z.number().int().min(0).max(100).default(10),
      /** How often a running session checks its own usage. */
      usageCheckSeconds: z.number().int().positive().default(300),
      /**
       * Which model to move to when the one in use runs out everywhere.
       *
       * A per-model limit stops that model, not the account, so rotation looks
       * for another account with room on the SAME model first. Only when none
       * has any is the model changed, and then it follows this order rather than
       * whatever happens to be free.
       */
      modelPreference: z
        .array(z.string().min(1))
        .nonempty('modelPreference needs at least one model')
        .default(['fable', 'opus']),
      /**
       * Which runs out first: the model, or the account.
       *
       * model-first uses up the CURRENT MODEL everywhere before changing
       * model, so a session stays on Fable across every account and only then
       * falls back to Opus. account-first uses up each ACCOUNT across the
       * whole chain before moving to the next one.
       *
       * A one-model chain (`modelPreference: ['fable']`) means never fall
       * back at all, under either strategy.
       */
      modelStrategy: z.enum(['model-first', 'account-first']).default('model-first'),
      /**
       * Set false to ignore models entirely and rotate on account limits alone,
       * which is how ccx behaved before this existed.
       */
      preferSameModel: z.boolean().default(true),
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
    modelPreference?: string[];
    modelStrategy?: 'model-first' | 'account-first';
    preferSameModel?: boolean;
  };
  realClaudePath?: string | null;
}
