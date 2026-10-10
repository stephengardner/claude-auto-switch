import { z } from 'zod';

/** What `resume.prompt` is until somebody sets it. */
export const DEFAULT_RESUME_PROMPT =
  'This session was restarted. If you were in the middle of something, carry on exactly where you stopped. If your work was already finished, say so in one line and wait.';

/**
 * User configuration (spec section 7). Every key is optional in the file; the
 * schema fills defaults so `loadConfig` always returns a fully-populated object.
 */
export const ConfigSchema = z.object({
  profilesDir: z.string().optional(),
  browser: z
    .object({
      debugPort: z.number().int().positive().default(9222),
      channel: z.string().default('chrome'),
    })
    .default({}),
  rotation: z
    .object({
      autoRotateHeadless: z.boolean().default(true),
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
        .default(['opus', 'fable']),
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
      /**
       * Which account rotation reaches for first.
       * - `smart` (default): the account with the longest runway, the most of a
       *   5-hour window's work it can do before any window stops it, with
       *   weekly room converted through what a 5-hour window costs that week
       *   (see usage/runway.ts). Between accounts that can run about as long,
       *   the one whose leftover weekly budget would go unused soonest first.
       * - `most-room`: the least-used account, the one with the most
       *   headroom left on its binding window (5-hour or weekly, whichever is
       *   tighter). Spreads work across accounts and delays hitting any limit.
       * - `priority`: the classic order, lowest `priority` number first.
       * Either way a manually pinned account (`ccx use`) still wins, and priority
       * is the tiebreak when two accounts are equally roomy.
       */
      accountOrder: z.enum(['smart', 'most-room', 'priority']).default('smart'),
      /**
       * Under `smart`, an account whose week (or the model's own week) is at
       * least this full goes after every healthy account that can run half a
       * 5-hour window, and competes on runway with the rest (see
       * usage/runway.ts). 100 turns it off.
       */
      holdBackAtPercent: z.number().int().min(50).max(100).default(80),
    })
    .default({}),
  /**
   * Claude Desktop. Its chat sessions run on the account the Desktop app itself
   * is signed into, which it hands each session as a token of its own, so ccx
   * cannot switch them. What it can do is carry a conversation that hits a
   * limit there on to a terminal it does control.
   */
  desktop: z
    .object({
      /**
       * When a Desktop conversation moves to a terminal by itself:
       * - `off` (default): never; move one by hand (`ccx desktop move`).
       * - `limit`: when a Desktop turn fails on a usage limit.
       * - `credits`: that, and before Desktop spends usage credits: once its
       *   account is past its plan limits, the next message sent there is
       *   held and continues in a terminal instead.
       * Opt-in: it opens a window and spends another account.
       */
      handoff: z.enum(['off', 'limit', 'credits']).default('off'),
      /**
       * - `fork` (default): continue in a copy. The Desktop conversation stays
       *   exactly as it was, so nothing can ever write into it twice.
       * - `same`: continue the conversation itself, so reopening it in Desktop
       *   later shows the work. Typing in Desktop's copy while the terminal
       *   carries on writes a second thread into the same conversation.
       */
      mode: z.enum(['fork', 'same']).default('fork'),
      /** Submitted when the conversation continues, so the work picks itself up. */
      prompt: z.string().min(1).default('Carry on where you stopped.'),
    })
    .default({}),
  /**
   * What a session says to itself when ccx restarts it, usually on another
   * account. Without it the restarted session waits at its prompt for someone
   * to come back, which for an unattended session means it just stops.
   */
  resume: z
    .object({
      /** On by default. A session can opt out alone: `ccx resume-prompt --clear`. */
      auto: z.boolean().default(true),
      /**
       * Worded for both cases, since a restart can find the work finished as
       * easily as half done. A prompt a session armed itself wins over this.
       */
      prompt: z.string().min(1).default(DEFAULT_RESUME_PROMPT),
    })
    .default({}),
  /** What a running session does when a newer ccx is installed under it. */
  update: z
    .object({
      /**
       * Move to it by itself (default): when Claude is being relaunched anyway,
       * or once it has been idle a little while, never mid-turn. The same
       * conversation, on the same account, in the same terminal.
       */
      follow: z.boolean().default(true),
    })
    .default({}),
  /**
   * Which account the pages Claude's Artifact tool publishes belong to. A page
   * is private to the account that published it, so with several accounts
   * they scatter, and a session on one account cannot update a page another
   * published. Both are off by default, and with both off ccx installs
   * nothing for this.
   */
  artifacts: z
    .object({
      /** Publish every new page as this account, whatever account the session is on. Null is off. */
      home: z.string().min(1).nullable().default(null),
      /** `owner`: send an update to a page as the account that owns it. */
      updates: z.enum(['off', 'owner']).default('off'),
    })
    .default({}),
  realClaudePath: z.string().nullable().default(null),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Deep-partial shape for file input, env overrides, and saveConfig. */
export interface PartialConfig {
  profilesDir?: string;
  browser?: { debugPort?: number; channel?: string };
  rotation?: {
    autoRotateHeadless?: boolean;
    defaultBackoffMinutes?: number;
    capThresholdPercent?: number;
    proactivePercent?: number;
    proactiveHysteresisPercent?: number;
    usageCheckSeconds?: number;
    modelPreference?: string[];
    modelStrategy?: 'model-first' | 'account-first';
    preferSameModel?: boolean;
    accountOrder?: 'smart' | 'most-room' | 'priority';
    holdBackAtPercent?: number;
  };
  desktop?: {
    handoff?: 'off' | 'limit' | 'credits';
    mode?: 'fork' | 'same';
    prompt?: string;
  };
  resume?: {
    auto?: boolean;
    prompt?: string;
  };
  update?: {
    follow?: boolean;
  };
  artifacts?: {
    home?: string | null;
    updates?: 'off' | 'owner';
  };
  realClaudePath?: string | null;
}
