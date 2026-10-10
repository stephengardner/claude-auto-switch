import { listAccounts, updateAccount } from '../accounts/registry.js';
import { getActive, setActive } from '../state/active.js';
import { requestMoves, type SwitchMode } from '../state/switch-request.js';
import { refreshUsage, readUsageSnapshot, type UsageSnapshot } from '../usage/usage-store.js';
import { probeAll, type ProbeResult } from '../health/prober.js';
import { loadLedger } from '../ledger/ledger.js';
import { signInFailureNotice } from '../dashboard/sign-in-failure.js';
import { renderDashboard, type DashboardAccount, type SettingsPanel } from '../dashboard/render.js';
import { toSnapshot } from '../dashboard/snapshot.js';
import { dispatchKey, dispatchSettingsKey, confirmKey } from '../dashboard/keys.js';
import {
  SETTINGS,
  appliesWords,
  defaultOf,
  editText,
  isTyped,
  parseSetting,
  sameValue,
  stepSetting,
  valueOf,
  type Setting,
} from '../dashboard/settings-catalog.js';
import {
  numberSessions,
  parseSessionChoice,
  sessionQuestion,
  type NumberedSession,
} from '../dashboard/session-choice.js';
import { liveLeases } from '../session/lease.js';
import { applySetting } from './settings.js';
import { openPrompt, promptKey, rejectPrompt, type PromptState } from '../dashboard/prompt.js';
import { loadConfig, loadConfigFile, saveConfig } from '../config/config.js';
import { desktopSummary } from '../desktop/summary.js';
import { nextHandoff, setHandoff, setMode, setPrompt, moveConversation } from './desktop.js';
import path from 'node:path';
import { configHome, profilesDir } from '../config/paths.js';
import { addAccount, getAccount } from '../accounts/registry.js';
import { renameAccount } from '../accounts/rename.js';
import { assertProfileName } from '../util/names.js';
import { secureMkdir } from '../util/secret-file.js';
import { appendEvent, readEvents, formatEvent } from '../events/log.js';
import { ccxVersion } from '../util/version.js';
import { toStatePayload, STATE_SCHEMA_VERSION } from '../dashboard/state-payload.js';
import { syncEditorPointerIfEnabled } from '../editor/junction.js';
import { loginCommand } from './login.js';
import { getClaude, type CliContext } from '../context.js';
import { claimRawTerminal } from '../ui/raw-terminal.js';
import { signedInAndNotRejected } from '../health/signed-in.js';
import { describeNextUp, describeWhenOut, type NextUpInput, type WhenOut } from '../dashboard/next-up.js';
import { inDisplayOrder, keepSelection } from '../dashboard/arrange.js';
import type { CapacityWindows } from '../usage/usable-capacity.js';
import { orderComparator } from '../selector/selector.js';
import { roomOfFromSnapshot } from '../usage/account-room.js';
import { standingOf, type RunwayWindows } from '../usage/runway.js';
import {
  modelPreferenceWords,
  nextModelPreference,
  nextOrder,
  orderWords,
  canRunChain,
  holdBackOf,
  modelUsageFor,
  numberPicks,
  pickAside,
  pickReason,
  rankAccounts,
  reorder,
  settingsWords,
} from '../dashboard/rotation-settings.js';
import { activeModelCaps, cappedNames } from '../ledger/ledger.js';
import { spentKey } from '../usage/rotation-plan.js';

export interface DashboardOptions {
  /** Print a single frame and exit (no live loop). */
  once?: boolean;
  /** Refresh interval in seconds. */
  interval?: string;
  /**
   * Emit the state as JSON instead of drawing it, and exit.
   *
   * Deliberately the same code path as the screen rather than a second one
   * beside it. Two surfaces assembling their own view of ccx would drift, and
   * they would drift on the thing that matters most: which account can
   * actually be used right now.
   */
  json?: boolean;
}

const HEALTH_REPROBE_MS = 20_000;
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
// Alternate screen + home-repaint = flicker-free. Repainting over the old frame
// (instead of clearing the whole screen each tick) is what removes the blink.
const ENTER_ALT = '\x1b[?1049h';
const EXIT_ALT = '\x1b[?1049l';
const HOME = '\x1b[H';
const CLEAR_LINE_END = '\x1b[K';
const CLEAR_BELOW = '\x1b[J';
const CLEAR_SCREEN = '\x1b[2J';

/**
 * The screen-entry and screen-exit sequences for a platform.
 *
 * The alternate screen buffer is a nicety: it restores whatever was on the
 * terminal before the dashboard when the dashboard exits. But LEAVING it
 * (`?1049l`) is a buffer swap, and on Windows that swap, landing at the moment
 * the process exits or hands the screen to a sign-in, races the pseudo-terminal
 * (ConPTY) being torn down and can crash the console host, which takes the
 * parent shell with it. That is the reported "pressing q closed my whole
 * terminal" and "starting a sign-in from the dashboard crashed the terminal",
 * and it was measured: the sign-in flow crashed the shell about half the time
 * with the alternate screen and not once without it.
 *
 * So on Windows the dashboard stays on the MAIN screen. It already repaints in
 * place from the top of the screen every frame, so nothing about the live view
 * changes; the only thing given up is the on-exit scrollback restore, a fair
 * price for not crashing the terminal. Every other platform keeps the alternate
 * screen and its restore.
 *
 * Pure and exported so both branches are testable without spoofing the host OS.
 *   - enter: what to write when taking the screen. The alternate screen
 *     elsewhere; a one-time clear-and-home on Windows, so the main-screen
 *     dashboard starts on a clean frame instead of over whatever was there.
 *   - epilogue: what the raw-terminal restore writes on the way out. The cursor
 *     is always shown again; the alternate screen is left ONLY where one was
 *     entered. On Windows there is deliberately no `?1049l`.
 */
export function screenSequences(platform: NodeJS.Platform): {
  usesAltScreen: boolean;
  enter: string;
  epilogue: string;
} {
  const usesAltScreen = platform !== 'win32';
  return {
    usesAltScreen,
    enter: usesAltScreen ? ENTER_ALT : CLEAR_SCREEN + HOME,
    epilogue: SHOW_CURSOR + (usesAltScreen ? EXIT_ALT : ''),
  };
}
const { enter: ENTER_SCREEN, epilogue: SCREEN_EPILOGUE } = screenSequences(process.platform);

/** Live account dashboard. `--once` prints a single frame (script/CI friendly). */
export async function dashboardCommand(
  context: CliContext,
  options: DashboardOptions = {},
): Promise<number> {
  const initial = listAccounts(context.ctx);
  if (initial.length === 0) {
    // A reader asking for JSON gets JSON, even when the answer is "nothing".
    // Prose here would be a parse error at the worst possible moment: first run.
    if (options.json) {
      context.out(
        JSON.stringify(
          {
            schemaVersion: STATE_SCHEMA_VERSION,
            ccxVersion: ccxVersion(),
            now: Date.now(),
            active: null,
            preferredModel: null,
            nextUp: null,
            accounts: [],
            events: [],
          },
          null,
          2,
        ),
      );
      return 0;
    }
    context.out('no accounts registered (run: ccx add <name>)');
    return 0;
  }

  const claude = getClaude(context);
  const home = configHome(context.ctx);
  const refreshMs = Math.max(1000, (Number(options.interval) || 3) * 1000);
  const color = process.stdout.isTTY === true;
  let healths: ProbeResult[] = await probeAll(initial, { claude });
  // Real per-account usage from the unified rate-limit signal, TTL-cached so the
  // network is touched at most once per account per window (about a token each).
  let usageSnap: UsageSnapshot = readUsageSnapshot(context.ctx);
  try {
    usageSnap = await refreshUsage(initial, context.ctx);
  } catch {
    /* cached (possibly empty) usage is fine */
  }
  // Dashboard actions go to the same shared log that `ccx run` writes to.
  const pushEvent = (m: string): void => appendEvent(home, m, Date.now());
  // A rotation setting changed here is saved to the FILE (never baking in a
  // temporary environment override) and applied to this screen at once.
  const saveRotation = (patch: Partial<CliContext['config']['rotation']>): void => {
    const onDisk = loadConfigFile(context.ctx);
    saveConfig({ ...onDisk, rotation: { ...onDisk.rotation, ...patch } }, context.ctx);
    context.config.rotation = { ...context.config.rotation, ...patch };
  };

  /**
   * The settings as they are on disk now. Read every tick, like the accounts,
   * so a change made elsewhere (`ccx config`, another dashboard) shows here
   * rather than this screen going on describing what it read at start. A file
   * that will not load keeps what was shown.
   */
  const refreshConfig = (): void => {
    try {
      Object.assign(context.config, loadConfig(context.ctx));
    } catch {
      /* keep the last good settings */
    }
  };

  // Re-read accounts + ledger + active every tick so interactive edits show live.
  const build = () => {
    refreshConfig();
    const accts = listAccounts(context.ctx);
    const loggedIn = signedInAndNotRejected(healths, accts, context.ctx);
    const liveEmail = new Map(healths.filter((h) => h.email).map((h) => [h.name, h.email!]));
    const livePlan = new Map(healths.filter((h) => h.plan).map((h) => [h.name, h.plan!]));
    const now = Date.now();
    const cappedUntil = new Map<string, number>();
    for (const c of loadLedger(context.ctx).caps) {
      if (c.capUntil && c.capUntil > now) cappedUntil.set(c.account, c.capUntil);
    }
    const usage = new Map(
      Object.entries(usageSnap.accounts).map(([name, u]) => [
        name,
        {
          fiveHour: u.fiveHour,
          sevenDay: u.sevenDay,
          fiveHourReset: u.fiveHourReset,
          sevenDayReset: u.sevenDayReset,
          ...(u.models ? { models: u.models } : {}),
          // The learned cost of a 5-hour window, so the pick column agrees with
          // rotation, which reads the whole entry.
          ...(typeof u.windowCost === 'number' ? { windowCost: u.windowCost } : {}),
        },
      ]),
    );
    return toSnapshot({
      accounts: accts.map((a) => ({
        name: a.name,
        ...(a.email !== undefined ? { email: a.email } : {}),
        ...(a.plan !== undefined ? { plan: a.plan } : {}),
        enabled: a.enabled,
        priority: a.priority,
      })),
      loggedIn,
      liveEmail,
      livePlan,
      cappedUntil,
      usage,
      active: getActive(context.ctx),
      // Marked against the build DRAWING the screen, so a line written by the
      // running ccx is unadorned and one left over from an older build says so.
      // The title already carries the current version.
      events: readEvents(home, 5).map((r) => formatEvent(r, ccxVersion())),
      version: ccxVersion(),
      now,
      refreshMs,
      // Eligible the way rotation decides it: a cap on one model (Fable) does
      // not stop the account, so it is not excluded here either.
      ...nextMove(context, accts, usage, cappedNames(loadLedger(context.ctx), now), loggedIn, now),
      desktop: desktopSummary(context, (name) => usage.get(name), now),
      settings: settingsWords(context.config.rotation),
      sessions: numberSessions(liveLeases(context.ctx)),
    });
  };

  /**
   * Run one of `ccx desktop`'s own commands and hand back what it said, as one
   * line for the footer. The same code the CLI runs, so the two cannot differ;
   * the config is reloaded after, so the Desktop line shows the new setting.
   */
  const desktopSays = async (run: (ctx: CliContext) => number | Promise<number>): Promise<{ ok: boolean; text: string }> => {
    const said: string[] = [];
    const code = await run({ ...context, out: (m: string) => said.push(m) });
    context.config.desktop = loadConfig(context.ctx).desktop;
    return { ok: code === 0, text: said.filter((l) => l.trim() !== '').join(' ') };
  };

  /**
   * The one line the table cannot show: what rotation does NEXT.
   *
   * Built from the same pieces the real thing uses (usable capacity, the
   * ledger's model caps, the operator's policy), so the dashboard predicts
   * what will happen rather than describing something adjacent to it.
   */
  function nextMove(
    ctx: CliContext,
    accounts: Array<{ name: string; enabled: boolean; priority: number }>,
    usage: Map<string, CapacityWindows & RunwayWindows>,
    capped: ReadonlySet<string>,
    loggedIn: Set<string>,
    at: number,
  ): {
    model?: string;
    nextUp?: string;
    whenOut?: WhenOut;
    picks: Map<string, NonNullable<DashboardAccount['pick']>>;
  } {
    const rotation = ctx.config.rotation;
    // With models switched off, rotation still MOVES BETWEEN ACCOUNTS, and
    // that is worth predicting. Returning nothing here hid the line entirely
    // for a setting that only turns off half of what it describes.
    const model = rotation.preferSameModel ? rotation.modelPreference[0] : null;
    const knownSpent = activeModelCaps(loadLedger(ctx.ctx), at);
    const holdBack = holdBackOf(rotation);
    const standing = (name: string) => standingOf(usage.get(name), at, model, holdBack);
    // Ordered the same way rotation actually chooses, so the "next up" line
    // and the pick column predict the real move.
    const ordered = rankAccounts(
      accounts.filter((a) => a.enabled && loggedIn.has(a.name) && !capped.has(a.name)),
      (name) => usage.get(name),
      rotation,
      model,
      at,
    );
    const candidates = ordered.map((a) => modelUsageFor(a.name, usage.get(a.name), knownSpent, at));
    const picks = numberPicks(candidates, rotation.modelPreference, model !== null, standing);
    const current = getActive(ctx.ctx);
    const move: NextUpInput = {
      candidates,
      current,
      modelInUse: model,
      preference: rotation.modelPreference,
      strategy: rotation.modelStrategy,
      // Whatever the current account has already used up counts, so the line
      // does not promise a model this account has just run out of.
      spentThisRun: new Set(
        current ? knownSpent.filter((c) => c.account === current).map((c) => spentKey(c.account, c.model)) : [],
      ),
    };
    // Why that account, in the terms the smart order decides by. One move,
    // worded once for other programs and once for the screen.
    const smart = rotation.accountOrder === 'smart';
    const nextUp = describeNextUp({
      ...move,
      ...(smart ? { reasonFor: (name: string) => pickReason(standing(name), at) } : {}),
    });
    const whenOut = describeWhenOut({
      ...move,
      ...(smart ? { reasonFor: (name: string) => pickAside(standing(name), at) } : {}),
    });
    return { ...(model ? { model } : {}), ...(nextUp ? { nextUp } : {}), ...(whenOut ? { whenOut } : {}), picks };
  }

  if (options.json) {
    context.out(JSON.stringify(toStatePayload(build()), null, 2));
    return 0;
  }

  if (options.once) {
    context.out(renderDashboard(build(), { color, width: process.stdout.columns }));
    return 0;
  }

  // The live loop's cursor counts rows, so it is handed the accounts in the
  // order the screen draws them. `ccx state` above keeps the order ccx stores.
  const drawn = (): ReturnType<typeof toSnapshot> => {
    const snapshot = build();
    return { ...snapshot, accounts: inDisplayOrder(snapshot.accounts, snapshot.model ?? null, snapshot.now) };
  };

  await runLiveLoop(drawn, {
    refreshMs,
    color,
    reprobe: async () => {
      healths = await probeAll(listAccounts(context.ctx), { claude });
      try {
        // TTL-guarded internally: refetches only entries older than the window.
        usageSnap = await refreshUsage(listAccounts(context.ctx), context.ctx);
      } catch {
        /* keep showing the cached usage */
      }
    },
    sessions: () => numberSessions(liveLeases(context.ctx)),
    onUse: (a, mode, chosen) => {
      // The account new sessions start on, and the editor's, whichever
      // sessions move; then each chosen session by its own request.
      setActive(a.name, context.ctx);
      syncEditorPointerIfEnabled(context);
      const moving = requestMoves(a.name, chosen, mode, context.ctx);
      const how = mode === 'restart' ? 'now, restarting' : 'in place, within ~30s';
      const said =
        moving.length > 0
          ? `moving ${moving.map((s) => s.where).join(', ')} to ${a.name} (${how}); new sessions start there too`
          : chosen.length > 0
            ? `already on ${a.name}; new sessions start there too`
            : `new sessions start on ${a.name}`;
      pushEvent(said);
      return said;
    },
    panel: (selected) => settingsPanel(context.config, selected),
    settingValue: (setting) => valueOf(context.config, setting.key),
    onSetting: async (setting, value) => {
      const said = await applySetting(context, setting, value);
      pushEvent(said);
      return `${said}. ${appliesWords(setting.applies)}`;
    },
    onToggle: (a) => {
      updateAccount(a.name, { enabled: !a.enabled }, context.ctx);
      pushEvent(`${a.enabled ? 'disabled' : 'enabled'} ${a.name}`);
    },
    onDesktop: async (action) => {
      const { mode } = context.config.desktop;
      if (action === 'handoff') {
        return (await desktopSays((ctx) => setHandoff(ctx, nextHandoff(context.config.desktop.handoff)))).text;
      }
      return (await desktopSays((ctx) => setMode(ctx, mode === 'fork' ? 'same' : 'fork'))).text;
    },
    desktopQuestion: (action) => {
      const { handoff, mode } = context.config.desktop;
      if (action === 'mode') {
        return mode === 'fork'
          ? 'Carry moved Desktop conversations on as the SAME conversation, not a copy? Desktop must then send nothing more to them.'
          : 'Carry moved Desktop conversations on as a copy, leaving the original in Desktop as it was?';
      }
      const next = nextHandoff(handoff);
      const what =
        next === 'off'
          ? 'Stop moving Desktop conversations by themselves'
          : next === 'limit'
            ? 'Move a Desktop conversation to a terminal when it hits a usage limit'
            : 'Also hold back Desktop messages once its account is past its plan, and carry them on in a terminal';
      return `${what}? This edits the hooks in ~/.claude/settings.json.`;
    },
    desktopPrompt: () => context.config.desktop.prompt,
    onModelPreference: () => {
      const current = context.config.rotation.modelPreference;
      const preference = nextModelPreference(current);
      if (!preference) {
        return `your model preference is your own (${current.join(', ')}); change it with ccx models`;
      }
      saveRotation({ modelPreference: preference });
      const said = `sessions prefer ${modelPreferenceWords(preference)}, from their next start or move`;
      pushEvent(said);
      return said;
    },
    onPickOrder: () => {
      const order = nextOrder(context.config.rotation.accountOrder);
      saveRotation({ accountOrder: order });
      const said = `the next account is picked by ${orderWords(order)}, from each session's next move`;
      pushEvent(said);
      return said;
    },
    onReorder: (account, direction) => {
      const changes = reorder(listAccounts(context.ctx), account.name, direction);
      if (changes.length === 0) return `"${account.name}" is already ${direction < 0 ? 'first' : 'last'} in your order`;
      for (const change of changes) updateAccount(change.name, { priority: change.priority }, context.ctx);
      return `"${account.name}" moved ${direction < 0 ? 'up' : 'down'} your order`;
    },
    onDesktopText: async (kind, text) => {
      if (kind === 'desktop-prompt') {
        const said = await desktopSays((ctx) => setPrompt(ctx, [text]));
        if (!said.ok) throw new Error(said.text);
        return said.text;
      }
      // From here the window waits for Desktop by itself, so a busy one is fine.
      const said = await desktopSays((ctx) => moveConversation(ctx, text, { wait: true }));
      if (!said.ok) throw new Error(said.text);
      pushEvent(said.text);
      return said.text;
    },
    onName: (kind, text, target) => {
      if (kind === 'add') {
        assertProfileName(text);
        // Checked before anything is created, so a name that is already taken
        // reports that plainly instead of failing on the folder underneath it.
        if (getAccount(text, context.ctx)) {
          throw new Error(`an account called "${text}" already exists`);
        }
        const dir = path.join(profilesDir(context.config, context.ctx), text);
        secureMkdir(dir);
        addAccount({ name: text, dir }, context.ctx);
        pushEvent(`added ${text}`);
        // The browser sign-in is deliberately not run from in here: it wants the
        // screen, and this screen is already taken. One command finishes it.
        return `added "${text}" - finish it with: ccx login ${text}`;
      }
      if (!target) return 'nothing selected to rename';
      const result = renameAccount(target.name, text, context.config, context.ctx);
      pushEvent(`renamed ${result.from} to ${result.to}`);
      return result.folderNote
        ? `renamed to "${result.to}" (${result.folderNote})`
        : `renamed "${result.from}" to "${result.to}"`;
    },
    onLogin: async (target) => {
      // Reuses the ordinary login command, so the dashboard gets the same
      // duplicate refusal and the same identity recording as `ccx login`. Its
      // output goes to the real screen, which the loop has handed back.
      const code = await loginCommand(context, target.name);
      pushEvent(code === 0 ? `signed in ${target.name}` : `sign-in for ${target.name} did not finish`);
      // Health is now stale for this account: re-probe so the row tells the truth.
      healths = await probeAll(listAccounts(context.ctx), { claude });
      return code === 0
        ? `signed "${target.name}" in again`
        : `"${target.name}" was not signed in; see the messages above`;
    },
    onRotate: () => {
      const active = getActive(context.ctx);
      const rotatable = listAccounts(context.ctx);
      const loggedIn = signedInAndNotRejected(healths, rotatable, context.ctx);
      const now = Date.now();
      // Account-wide caps only, as rotation decides: a cap on one model (Fable)
      // leaves the account for the rest of the chain, which chainRuns checks.
      const capped = cappedNames(loadLedger(context.ctx), now);
      // The SAME order the "next up" line predicts and rotation actually uses, so
      // pressing rotate goes to the account the dashboard just said it would.
      const rotation = context.config.rotation;
      const roomOf = roomOfFromSnapshot(
        context.ctx,
        now,
        rotation,
        rotation.preferSameModel ? rotation.modelPreference[0] : null,
      );
      // Only where the chain can run: an account spent on every preferred
      // model is not somewhere to rotate to, as rotation itself would skip it.
      const knownSpent = activeModelCaps(loadLedger(context.ctx), now);
      const chainRuns = (name: string): boolean =>
        !rotation.preferSameModel ||
        canRunChain(modelUsageFor(name, usageSnap.accounts[name], knownSpent, now), rotation.modelPreference);
      const next = rotatable
        .filter((a) => a.enabled && loggedIn.has(a.name) && !capped.has(a.name) && a.name !== active)
        .filter((a) => chainRuns(a.name))
        .sort(orderComparator(context.config.rotation.accountOrder, roomOf))[0];
      if (next) {
        setActive(next.name, context.ctx);
        syncEditorPointerIfEnabled(context);
        pushEvent(`rotated to ${next.name}`);
      } else {
        pushEvent('no other healthy account to rotate to');
      }
    },
  });
  return 0;
}

/** The settings panel for `config`, every setting in words, `selected` explained. */
function settingsPanel(config: CliContext['config'], selected: number): SettingsPanel {
  const chosen = SETTINGS[selected] ?? SETTINGS[0];
  return {
    rows: SETTINGS.map((s) => ({ group: s.group, label: s.label, value: s.words(valueOf(config, s.key)) })),
    selected,
    help: chosen?.help ?? '',
    applies: chosen ? appliesWords(chosen.applies) : '',
  };
}

/** Why a step left a setting as it was, said instead of doing nothing silently. */
function stepRefused(setting: Setting): string {
  if (setting.kind === 'text') return `${setting.label}: enter edits it`;
  if (setting.kind === 'models') {
    return 'that model chain is your own, so the arrows leave it alone; enter types a new one';
  }
  return `${setting.label} is already at that end`;
}

interface LoopDeps {
  refreshMs: number;
  color: boolean;
  reprobe: () => Promise<void>;
  /** The ccx sessions running now, numbered as the screen shows them. */
  sessions: () => NumberedSession[];
  /**
   * Make an account the one new sessions start on, and move the chosen running
   * sessions to it (in place, or by restarting). Returns what happened.
   */
  onUse: (a: DashboardAccount, mode: SwitchMode, chosen: NumberedSession[]) => string;
  /** The settings panel as it stands, with `selected` highlighted. */
  panel: (selected: number) => SettingsPanel;
  /** A setting's current value. */
  settingValue: (setting: Setting) => unknown;
  /** Change a setting; resolves to what it is now, rejects with why not. */
  onSetting: (setting: Setting, value: unknown) => Promise<string>;
  onToggle: (a: DashboardAccount) => void;
  onRotate: () => void;
  /**
   * Apply a typed name. Returns a message to show, or throws to reject the value
   * and keep the box open so it can be corrected without retyping everything.
   */
  onName: (kind: 'add' | 'rename', text: string, selected: DashboardAccount | undefined) => string;
  /** Cycle a Claude Desktop setting; returns what changed, in words. */
  onDesktop: (action: 'handoff' | 'mode') => Promise<string>;
  /** What cycling it would do, asked before it is done. */
  desktopQuestion: (action: 'handoff' | 'mode') => string;
  /** The text a moved Desktop conversation carries on with now, to edit. */
  desktopPrompt: () => string;
  /**
   * Apply what was typed for Desktop: the carry-on text, or which conversation
   * to move. Rejects to keep the box open with the reason, like onName.
   */
  onDesktopText: (kind: 'desktop-prompt' | 'desktop-move', text: string) => Promise<string>;
  /** Cycle the model preference; returns what it is now, in words. */
  onModelPreference: () => string;
  /** Cycle how the next account is picked; returns what it is now, in words. */
  onPickOrder: () => string;
  /** Move an account up (-1) or down (+1) the priority order; returns what happened. */
  onReorder: (account: DashboardAccount, direction: -1 | 1) => string;
  /**
   * Sign an account in again, as itself or as a different account. Async and
   * INTERACTIVE: it hands the screen to a browser sign-in, so the dashboard steps
   * out of the way while it runs. Returns a line to show afterwards.
   */
  onLogin: (account: DashboardAccount) => Promise<string>;
}

/** Clear-screen refresh loop with a selection cursor; quits on q / Ctrl-C / Ctrl-D. */
async function runLiveLoop(build: () => ReturnType<typeof toSnapshot>, deps: LoopDeps): Promise<void> {
  const out = process.stdout;
  const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: (v: boolean) => void };

  let running = true;
  let selected = 0;
  let snap = build();
  let wake: (() => void) | null = null;

  const clamp = (): void => {
    selected = Math.max(0, Math.min(selected, snap.accounts.length - 1));
  };
  /**
   * Read the state again and keep the cursor on the account it was on. The
   * rows follow the pick order, which moves as usage is read, and a key must
   * act on the account that was highlighted, not on whichever slid into its
   * row.
   */
  const rebuild = (): void => {
    const held = snap.accounts[selected]?.name;
    snap = build();
    selected = keepSelection(snap.accounts, held, selected);
  };
  const stop = (): void => {
    running = false;
    if (wake) wake();
  };
  // Shown in the footer instead of crashing the program. This handler runs on its
  // own stack, outside the loop below, so an exception escaping it would end the
  // process without restoring the terminal, which on Windows kills the shell.
  // Held in an object rather than as two plain variables: both are only ever
  // assigned inside the keypress handler, and the compiler treats a variable it
  // never sees change as still holding its initial value.
  const ui: {
    notice: string | null;
    prompt: PromptState | null;
    /**
     * An interactive job the loop should run with the terminal handed back.
     * Set from the keypress handler, which cannot await, and picked up by the
     * loop, which can.
     */
    pendingLogin: DashboardAccount | null;
    /**
     * The account the open box was opened FOR.
     *
     * Captured rather than re-read on submit: the rows are rebuilt every tick and
     * reindexed, so another `ccx` adding or removing an account between opening
     * the box and pressing Enter would otherwise rename whatever now sits at that
     * position, which is not the account the box names.
     */
    promptTarget: DashboardAccount | null;
    /**
     * A yes/no question waiting for an answer, and what a yes does. Signing in
     * gives the screen away to a browser, and a Desktop setting rewrites the
     * user's own Claude settings, and each sits one key from the movement
     * keys, so they ask first.
     */
    confirm: { question: string; yes: () => void } | null;
    /** The settings panel, while it is open, and which setting is highlighted. */
    panel: { selected: number } | null;
    /** The setting the open box is typing a value for. */
    promptSetting: Setting | null;
    /**
     * The sessions the open "move which" question listed, captured with it so
     * a number means the session the question showed, even if one has since
     * started or ended; and how they are to move.
     */
    promptSessions: NumberedSession[] | null;
    promptMode: SwitchMode;
  } = {
    notice: null,
    prompt: null,
    promptTarget: null,
    pendingLogin: null,
    confirm: null,
    panel: null,
    promptSetting: null,
    promptSessions: null,
    promptMode: 'seamless',
  };

  /**
   * Change a setting, asking first when it edits files outside ccx. Saving is
   * asynchronous (a Desktop setting runs `ccx desktop`), so the footer says
   * "saving" and then what it is now, or why it was refused.
   */
  const changeSetting = (setting: Setting, next: unknown): void => {
    const run = (): void => {
      ui.notice = 'saving...';
      void deps.onSetting(setting, next).then(
        (said) => {
          ui.notice = said;
          if (wake) wake();
        },
        (err: unknown) => {
          ui.notice = (err as Error).message;
          if (wake) wake();
        },
      );
    };
    if (setting.confirm) ui.confirm = { question: setting.confirm(next), yes: run };
    else run();
  };

  /** One key while the settings panel is open. */
  const panelKey = (text: string, byte0: number | undefined): void => {
    const panel = ui.panel;
    if (!panel) return;
    const r = dispatchSettingsKey(text, byte0, panel.selected, SETTINGS.length);
    panel.selected = r.selected;
    if (r.action === 'quit') return stop();
    if (r.action === 'close') {
      ui.panel = null;
      ui.notice = null;
      return;
    }
    if (r.action === 'none') return;
    if (r.action === 'move') {
      ui.notice = null;
      return;
    }
    const setting = SETTINGS[panel.selected];
    if (!setting) return;
    const current = deps.settingValue(setting);
    if (r.action === 'edit' && isTyped(setting)) {
      const unit = setting.unit ? ` (${setting.unit})` : '';
      ui.prompt = openPrompt('setting', `${setting.label}${unit}:`, editText(setting, current));
      ui.promptSetting = setting;
      return;
    }
    if (r.action === 'default') {
      const fallback = defaultOf(setting);
      if (sameValue(fallback, current)) {
        ui.notice = `${setting.label} is already the default`;
        return;
      }
      changeSetting(setting, fallback);
      return;
    }
    const next = stepSetting(setting, current, r.action === 'previous' ? -1 : 1);
    if (next === null) {
      ui.notice = stepRefused(setting);
      return;
    }
    changeSetting(setting, next);
  };

  /**
   * One keypress into the name box. Returns the box's next state, or null when it
   * is finished. Written as state-in/state-out so the flow stays readable.
   */
  const advancePrompt = (
    state: PromptState,
    text: string,
    byte0: number | undefined,
    target: DashboardAccount | null,
  ): PromptState | null => {
    const next = promptKey(state, text, byte0);
    if (next.status === 'cancel') {
      ui.promptSetting = null;
      ui.promptSessions = null;
      return null;
    }
    if (next.status !== 'submit') return next;
    if (next.kind === 'sessions') {
      // Answered before the empty check below: an empty answer here is a
      // real one (move none, only make it the account new sessions start on).
      let chosen: NumberedSession[];
      try {
        chosen = parseSessionChoice(next.text, ui.promptSessions ?? []);
      } catch (err) {
        return rejectPrompt(next, (err as Error).message);
      }
      if (target) ui.notice = deps.onUse(target, ui.promptMode, chosen);
      ui.promptSessions = null;
      return null;
    }
    const typed = next.text.trim();
    if (typed.length === 0) return null; // confirming an empty box just closes it
    if (next.kind === 'setting') {
      const setting = ui.promptSetting;
      if (!setting) return null;
      let value: unknown;
      try {
        value = parseSetting(setting, typed);
      } catch (err) {
        return rejectPrompt(next, (err as Error).message);
      }
      if (sameValue(value, deps.settingValue(setting))) {
        ui.promptSetting = null;
        ui.notice = `${setting.label} is unchanged`;
        return null;
      }
      ui.notice = 'saving...';
      // Reopened with the reason if the save is refused, like the Desktop box,
      // so a typo can be fixed without typing it all again.
      void deps.onSetting(setting, value).then(
        (said) => {
          ui.notice = said;
          ui.promptSetting = null;
          if (wake) wake();
        },
        (err: unknown) => {
          ui.notice = null;
          ui.prompt = rejectPrompt(next, (err as Error).message);
          if (wake) wake();
        },
      );
      return null;
    }
    if (next.kind === 'desktop-prompt' || next.kind === 'desktop-move') {
      // Async: answered when it is done, and reopened with the reason if refused.
      const kind = next.kind;
      ui.notice = kind === 'desktop-move' ? `moving "${typed}"...` : 'saving...';
      void deps.onDesktopText(kind, typed).then(
        (said) => {
          ui.notice = said;
          if (wake) wake();
        },
        (err: unknown) => {
          ui.notice = null;
          ui.prompt = rejectPrompt(next, (err as Error).message);
          if (wake) wake();
        },
      );
      return null;
    }
    try {
      ui.notice = deps.onName(next.kind, typed, target ?? undefined);
      return null;
    } catch (err) {
      // Kept open with the reason, so a clash or a bad name can be fixed without
      // retyping the whole thing.
      return rejectPrompt(next, (err as Error).message);
    }
  };

  const onKey = (d: Buffer): void => {
    try {
      const text = d.toString('utf8');
      // A pending question takes the next key, whatever it is, so the answer
      // cannot also trigger some other action.
      if (ui.confirm) {
        const asked = ui.confirm;
        ui.confirm = null;
        if (confirmKey(text, d[0]) === 'yes') asked.yes();
        if (wake) wake();
        return;
      }
      if (ui.prompt) {
        ui.prompt = advancePrompt(ui.prompt, text, d[0], ui.promptTarget);
        if (!ui.prompt) ui.promptTarget = null;
        if (wake) wake();
        return;
      }
      // The settings panel takes every key while it is open: the arrows and
      // space mean something different in there.
      if (ui.panel) {
        panelKey(text, d[0]);
        if (wake) wake();
        return;
      }
      const r = dispatchKey(text, d[0], selected, snap.accounts.length);
      selected = r.selected;
      if (r.action === 'quit') return stop();
      const target = snap.accounts[selected];
      if (r.action === 'settings') {
        ui.panel = { selected: 0 };
        ui.notice = null;
        if (wake) wake();
        return;
      }
      // Use (Enter) and now (f): with one session running it moves; with
      // several, the question says which, rather than whichever looks first.
      if ((r.action === 'use' || r.action === 'force') && target) {
        const mode: SwitchMode = r.action === 'use' ? 'seamless' : 'restart';
        const running = deps.sessions();
        if (running.length > 1) {
          ui.prompt = openPrompt('sessions', sessionQuestion(target.name, running));
          ui.promptTarget = target;
          ui.promptSessions = running;
          ui.promptMode = mode;
        } else {
          ui.notice = deps.onUse(target, mode, running);
        }
        if (wake) wake();
        return;
      }
      // The settings keys say what they changed, so they set the notice
      // themselves rather than have it cleared below.
      if (r.action === 'model-preference' || r.action === 'pick-order') {
        ui.notice = r.action === 'model-preference' ? deps.onModelPreference() : deps.onPickOrder();
        rebuild();
        if (wake) wake();
        return;
      }
      if ((r.action === 'move-up' || r.action === 'move-down') && target) {
        ui.notice = deps.onReorder(target, r.action === 'move-up' ? -1 : 1);
        // The cursor follows the account to wherever its row is now.
        snap = build();
        selected = Math.max(0, snap.accounts.findIndex((a) => a.name === target.name));
        if (wake) wake();
        return;
      }
      if (r.action === 'toggle' && target) deps.onToggle(target);
      else if (r.action === 'rotate') deps.onRotate();
      else if (r.action === 'login' && target) {
        ui.confirm = {
          question: `Sign in "${target.name}" again? The dashboard steps aside while you do.`,
          yes: () => {
            // Queued rather than run here: signing in is interactive and this
            // handler cannot wait. The loop runs it with the terminal handed back.
            ui.pendingLogin = target;
            ui.notice = `signing in "${target.name}"...`;
          },
        };
      }
      // Desktop's keys are only offered while its line is on screen; otherwise
      // they do nothing, rather than change settings nobody was shown.
      else if (r.action.startsWith('desktop-') && !snap.desktop) return;
      else if (r.action === 'add') {
        ui.prompt = openPrompt('add', 'name for the new account:');
        ui.promptTarget = null;
      } else if (r.action === 'rename') {
        if (!target) return;
        // Captured with the label, so the box acts on the account it names.
        ui.prompt = openPrompt('rename', `new name for "${target.name}":`, '');
        ui.promptTarget = target;
      } else if (r.action === 'desktop-handoff' || r.action === 'desktop-mode') {
        const action = r.action === 'desktop-handoff' ? 'handoff' : 'mode';
        ui.confirm = {
          question: deps.desktopQuestion(action),
          yes: () => {
            void deps.onDesktop(action).then(
              (said) => {
                ui.notice = said;
                if (wake) wake();
              },
              (err: unknown) => {
                ui.notice = (err as Error).message;
                if (wake) wake();
              },
            );
          },
        };
      } else if (r.action === 'desktop-prompt') {
        ui.prompt = openPrompt('desktop-prompt', 'carry on with:', deps.desktopPrompt());
        ui.promptTarget = null;
      } else if (r.action === 'desktop-move') {
        ui.prompt = openPrompt('desktop-move', 'move which Desktop conversation (number, or part of its name):');
        ui.promptTarget = null;
      } else if (r.action === 'none') return;
      ui.notice = null;
    } catch (err) {
      ui.notice = (err as Error).message;
    }
    if (wake) wake(); // re-render immediately on any handled key
  };

  // Claiming it this way registers the restore with the process, so every way out
  // (including a crash or Ctrl-C) hands the terminal back in one piece.
  const claimScreen = (): { restore: () => void } => {
    const handle = claimRawTerminal({
      epilogue: SCREEN_EPILOGUE,
      // A signal winds the loop down through its own exit path instead of
      // cutting the program off mid-frame, so the screen is always handed back
      // the same way whether you press q or the terminal sends a signal.
      onEnd: () => stop(),
    });
    stdin.on('data', onKey);
    out.write(ENTER_SCREEN + HIDE_CURSOR);
    return handle;
  };
  let terminal = claimScreen();

  /**
   * Hand the terminal back, run something interactive, then take it again.
   *
   * Signing in opens a browser and prints to the screen, which cannot happen
   * while the dashboard holds the terminal in raw mode on the alternate screen:
   * the output would be invisible and the keystrokes would be eaten by the key
   * handler. So the dashboard steps out entirely and comes back afterwards.
   */
  const withScreenHandedBack = async (lead: string, job: () => Promise<string>): Promise<string> => {
    stdin.off('data', onKey);
    terminal.restore();
    // Printed AFTER the screen is handed back, not as a dashboard notice: the
    // loop suspends before it would repaint, so a notice set here is never seen.
    // On the ordinary screen it also sits directly above the sign-in output,
    // which is where it makes sense.
    out.write(`\n${lead}\n`);
    // Keeps the process alive across the handoff. Handing the screen back pauses
    // stdin and the refresh timer has just been cleared, so for a moment the only
    // thing left is this pending promise, and a pending promise does NOT hold
    // Node open. The event loop could empty and the dashboard would vanish
    // mid-sign-in with no output at all, which is what "pressing l crashed the
    // terminal" actually was. Intermittent by nature: it only died when nothing
    // else happened to have a handle open.
    const keepAlive = setInterval(() => {}, 1 << 30);
    try {
      return await job();
    } finally {
      clearInterval(keepAlive);
      terminal = claimScreen();
    }
  };

  let lastProbe = Date.now();
  /**
   * Keeps the process alive for as long as the dashboard is running.
   *
   * Node exits the moment nothing is holding the event loop open, and this loop
   * spends most of its life holding nothing: handing the terminal back for a
   * sign-in pauses stdin, and every keypress clears the refresh timer. When both
   * gaps line up the process ends with no error and no output, which from the
   * outside is the dashboard vanishing back to the shell for no reason.
   *
   * This has been patched twice before, each time around the specific gap that
   * was found (the keypress handler, then the sign-in), and it came back both
   * times somewhere else. So the guard belongs here instead: the invariant is
   * not "cover the handoff", it is "while this loop runs, the process lives".
   */
  const stayAlive = setInterval(() => {}, 1 << 30);
  try {
    while (running) {
      if (Date.now() - lastProbe > HEALTH_REPROBE_MS) {
        // Same reasoning as the sign-in below: this spawns probes, and a throw
        // here would end the dashboard rather than one refresh of one row.
        try {
          await deps.reprobe();
        } catch {
          /* the rows keep their last known state until the next tick */
        }
        lastProbe = Date.now();
      }
      if (ui.pendingLogin) {
        const target = ui.pendingLogin;
        ui.pendingLogin = null;
        // Signing in is the one thing this loop runs that reaches outside the
        // process: a browser, a port, a network. Any of those can throw, and an
        // error escaping here ends the dashboard with a stack trace, which from
        // the outside looks like pressing "l" broke the terminal. The keypress
        // handler has been guarded for exactly this reason since it was written;
        // the loop body had been left unguarded.
        try {
          ui.notice = await withScreenHandedBack(
            `Signing in "${target.name}". To use a DIFFERENT account, sign out at claude.ai first.\n` +
              'The dashboard comes back when the sign-in finishes; Ctrl-C gives up and returns to your shell.',
            () => deps.onLogin(target),
          );
        } catch (err) {
          ui.notice = signInFailureNotice(target.name, err);
        }
      }
      rebuild();
      clamp();
      // Paint over the previous frame from the top: home, then each line clears
      // its own tail, then clear anything left below. No full-screen erase.
      const frame = renderDashboard(snap, {
        color: deps.color,
        interactive: true,
        selected,
        // Read every frame, not once at start: a window resized mid-session is
        // exactly when a fixed-width table starts wrapping.
        ...(process.stdout.columns ? { width: process.stdout.columns } : {}),
        ...(process.stdout.rows ? { height: process.stdout.rows } : {}),
        ...(ui.panel ? { panel: deps.panel(ui.panel.selected) } : {}),
        ...(ui.confirm ? { confirm: ui.confirm.question } : {}),
        ...(ui.notice ? { notice: ui.notice } : {}),
        ...(ui.prompt
          ? {
              prompt: {
                label: ui.prompt.label,
                text: ui.prompt.text,
                ...(ui.prompt.error ? { error: ui.prompt.error } : {}),
              },
            }
          : {}),
      });
      const painted = frame.split('\n').map((l) => l + CLEAR_LINE_END).join('\r\n');
      out.write(HOME + painted + '\r\n' + CLEAR_BELOW);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, deps.refreshMs);
        // Waking early (a keypress / quit) clears the pending refresh timer, so
        // quitting exits immediately instead of leaving a dangling timer that
        // keeps the process (and the terminal) hung for up to refreshMs.
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = null;
    }
  } finally {
    clearInterval(stayAlive);
    stdin.off('data', onKey);
    terminal.restore();
  }
}
