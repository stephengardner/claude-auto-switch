// Mutation proof for issue 157, run in CI on a throwaway branch with no pull
// request. Each mutant breaks one part of the change, runs the specs that must
// catch it, and puts the file back. Every edit must match exactly once, and the
// file must really change, or the run stops: a mutant that changed nothing
// proves nothing.
//
// A spec counts as having killed a mutant only when vitest's JSON report lists
// a test that failed on an assertion and every file in it loaded. A crash, a
// file that would not load, or a test that failed only by throwing something
// else is a setup fault, not a kill.
//
// `--check` only confirms every edit applies exactly once.
// `--old <ref>` puts the source files this change touched back as they were at
// <ref>, removes the ones it added, runs the new specs, and lists every test:
// each must fail on an assertion there, except the pins, which must pass.
//
// Exit 0 when every mutant was killed (or, with --old, as due), 1 when not, 2
// when the setup is wrong.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const FOLDER = 'src/editor/folder.ts';
const LOGIN = 'src/editor/folder-login.ts';
const CF = 'src/session/claude-folder.ts';
const WB = 'src/session/write-back.ts';
const SR = 'src/session/shared-root.ts';
const OR = 'src/usage/oauth-refresh.ts';
const SL = 'src/accounts/shared-login.ts';
const US = 'src/usage/usage-store.ts';
const SESSION = 'src/commands/session.ts';
const ED = 'src/commands/editor.ts';

/** The sources this change touched, put back for --old; ADDED are removed. */
const TOUCHED = [
  'src/accounts/credential-vault.ts',
  'src/accounts/removal.ts',
  SL,
  'src/commands/auto.ts',
  'src/commands/dashboard.ts',
  'src/commands/doctor.ts',
  ED,
  'src/commands/rotate.ts',
  SESSION,
  'src/commands/swap.ts',
  'src/commands/use.ts',
  SR,
  WB,
  'src/state/active-sync.ts',
  OR,
  'src/usage/token-expiry.ts',
  US,
  'src/editor/junction.ts',
];
const ADDED = [CF, FOLDER, LOGIN];

const FT_SPEC = 'src/editor/folder.test.ts';
const IS_SPEC = 'test/integration/editor-folder-session.test.ts';
const FS_SPEC = 'src/session/folder-sync.test.ts';
const FT = (filter) => ({ file: FT_SPEC, filter });
const IS = (filter) => ({ file: IS_SPEC, filter });
const FS = { file: FS_SPEC };
const AR = (filter) => ({ file: 'test/integration/artifact-routing.test.ts', filter });
const TS = (filter) => ({ file: 'test/integration/thin-session.test.ts', filter });
/** Tests that pin what this change must not alter: they pass at the old ref too. */
const PINS = ['runs a terminal session in a folder of its own', 'runs a worker in a folder of its own'];

const MUTANTS = [
  {
    name: 'E1 ccx editor on gives the editor no folder',
    file: FOLDER,
    edits: [["    if (kind === 'missing' && !createEditorFolder(c)) return;\n", "    if (kind === 'missing') return;\n"]],
    specs: [FT("is the user's own Claude but for the login")],
  },
  {
    name: "E2 a switch never moves the editor folder's login",
    file: FOLDER,
    edits: [['      if (how.move) moveEditorLogin(c);\n', '\n']],
    specs: [FT('takes the next login in the same folder on a switch')],
  },
  {
    name: 'E3 a login renewed in the folder is not saved home as the editor moves off it',
    file: FOLDER,
    edits: [['      if (leaving) saveEditorLoginHome(leaving, accounts, login, c);\n', '\n']],
    specs: [FT('takes a login its Claude renewed home on a switch while whose it is cannot be asked')],
  },
  {
    name: 'E4 the login goes into the file, never the Keychain item',
    file: LOGIN,
    edits: [
      [
        '    if (readKeychainCredential(spelling) !== null) writeKeychainCredential(spelling, text);\n',
        "    if (spelling === '') writeKeychainCredential(spelling, text);\n",
      ],
    ],
    specs: [FT('writes the Keychain item its Claude saved a login in')],
  },
  {
    name: "E5 the Keychain item is named after ccx's own path, not the setting's text",
    file: LOGIN,
    edits: [['  return found.size > 0 ? [...found] : [folder];\n', '  return [folder];\n']],
    specs: [FT("writes the item named after the editor setting's text")],
  },
  {
    name: "E6 the setting's text in another case is not the folder on macOS",
    file: LOGIN,
    edits: [
      [
        "    return platform === 'win32' || platform === 'darwin' ? resolved.toLowerCase() : resolved;\n",
        '    return resolved;\n',
      ],
    ],
    specs: [FT("writes the item named after the setting's text in another case")],
  },
  {
    name: 'E7 a folder never shares the user projects',
    file: CF,
    edits: [
      ['  ensureSharedProjects(dir, c);\n  // And everything else', '  // And everything else'],
      ['  ensureSharedProjects(dir, c);\n  linkSharedDirs(dir, c);', '  linkSharedDirs(dir, c);'],
    ],
    specs: [FT("keeps a chat its Claude writes in the user's own history"), IS('runs a terminal session in a folder of its own')],
  },
  {
    name: 'E8 a folder is built without the user settings',
    file: CF,
    edits: [['  copyUserSettings(dir, c);\n', '\n']],
    specs: [IS('runs a terminal session in a folder of its own'), TS('saves a model picked in the session')],
  },
  {
    name: 'E9 a folder is built without the rest of ~/.claude',
    file: CF,
    edits: [['  ensureSharedUserConfig(dir, c);\n', '\n']],
    specs: [IS('runs a terminal session in a folder of its own'), IS('runs a worker in a folder of its own')],
  },
  {
    name: 'E10 a failed move leaves the new login in',
    file: CF,
    edits: [['      store.rollback();\n', '\n']],
    specs: [AR('refuses a call, moved or not, when Claude cannot be made to read the login')],
  },
  {
    name: 'E11 a failed move leaves the new identity in',
    file: CF,
    edits: [['      restoreFolderIdentity(dir, identityBefore);\n', '\n']],
    specs: [AR('undoing a move for one call puts back who the session is signed in as')],
  },
  {
    name: 'W1 a setting changed in the editor never goes to your file',
    file: WB,
    edits: [["    if (handBackSettings(base ?? {}, going, userFile, c, clashes) === 'failed') return 'failed';\n", '\n']],
    specs: [FT('takes a setting changed in the editor to your settings.json')],
  },
  {
    name: 'W2 a setting you changed never comes into the editor',
    file: WB,
    edits: [['    writeFileAtomic(own, `${JSON.stringify(into(user), null, 2)}\\n`);\n', '\n']],
    specs: [FT('brings a setting you changed into the editor')],
  },
  {
    name: "W3 a clash does not keep the editor's file aside",
    file: WB,
    edits: [["    if (clashes.length > 0 && !keptAside(dir, 'settings.json', ownText ?? '', clashes, c)) return 'failed';\n", '\n']],
    specs: [FT('keeps yours where both changed one setting')],
  },
  {
    name: 'W4 the base never moves once both agree',
    file: WB,
    edits: [['    writeFileAtomic(baseFile, `${JSON.stringify(user, null, 2)}\\n`);\n', '\n']],
    specs: [FT('brings two changes of yours in a row in, calling neither a clash')],
  },
  {
    name: "W5 the editor's .claude.json choices never go to yours",
    file: WB,
    edits: [["    if (handBackState(base, ours, userFile, c, clashes) === 'failed') return 'failed';\n", '\n']],
    specs: [FT('takes MCP servers and preferences in .claude.json both ways')],
  },
  {
    name: "W6 your .claude.json choices never come into the editor's",
    file: WB,
    edits: [['    const next = withChoices(ours, stateChoices(user));\n', '    const next = ours;\n']],
    specs: [FT('takes MCP servers and preferences in .claude.json both ways')],
  },
  {
    name: "W7 the editor's .claude.json is written without Claude's lock",
    file: WB,
    edits: [
      [
        '  const lock = acquireLockDir(`${own}.lock`, { waitMs: 500 });\n',
        '  const lock = acquireLockDir(`${own}.ccx-unlocked`, { waitMs: 500 });\n',
      ],
    ],
    specs: [FT("waits for the editor's Claude to finish writing its .claude.json")],
  },
  {
    name: 'S1 a memory the editor saved as a new file never goes to yours',
    file: SR,
    edits: [['    return plan.write === null ? null : { text: plan.write };\n', '    return null;\n']],
    specs: [FT('takes a memory the editor saved as a new file to your CLAUDE.md')],
  },
  {
    name: "S2 the folder's copy is not made one file with yours again",
    file: SR,
    edits: [['      linkSync(theirs, mine);\n', '      copyFileSync(theirs, mine);\n']],
    specs: [FT('takes a memory the editor saved as a new file to your CLAUDE.md')],
  },
  {
    name: "S3 an account folder's own files are not kept aside on the move",
    file: SR,
    edits: [['      rescue(own, `${label}-${name}`, c);\n', '\n']],
    specs: [FT('moves at the first switch, at the same path')],
  },
  {
    name: 'L1 two refreshes of the folder can run at once',
    file: FOLDER,
    edits: [['  if (!lock.held) return { ran: false };\n', '\n']],
    specs: [FT('waits for another refresh to end rather than run beside it')],
  },
  {
    name: "R1 a renewal of the login the editor holds does not take the editor folder's lock",
    file: OR,
    edits: [
      [
        '    return editor ? renewWithEditor(accountDir, options, editor, login) : renewUnderLock(accountDir, options);\n',
        '    return renewUnderLock(accountDir, options);\n',
      ],
    ],
    specs: [FT("renews under the editor folder's lock"), FT("sends nothing while the editor's Claude is renewing")],
  },
  {
    name: "R2 the renewal is not written into the editor's folder",
    file: OR,
    edits: [['        replaceFolderLogin(editor, retired, readCredential(credentialPath(accountDir)));\n', '\n']],
    specs: [FT("renews under the editor folder's lock")],
  },
  {
    name: "R3 a renewal goes out while the editor's Claude holds its lock",
    file: OR,
    edits: [["  if (!lock.held) return { status: 'busy', detail: 'your editor is renewing this login' };\n", '\n']],
    specs: [FT("sends nothing while the editor's Claude is renewing")],
  },
  {
    name: 'R4 the token request is not bounded by the hold',
    file: OR,
    edits: [
      [
        '      { ...options, requestTimeoutMs: Math.min(options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS, left) },\n',
        '      options,\n',
      ],
    ],
    specs: [FT('cuts the request off well inside the time Claude waits')],
  },
  {
    name: "R5 a session's mirror does not carry a renewal into the editor's folder",
    file: SESSION,
    edits: [['        { alsoInto: carryIntoEditor(context.ctx) },\n', '\n']],
    specs: [IS("carries a renewal a terminal session's Claude made into the editor's folder")],
  },
  {
    name: 'R6 propagateRenewal never gives the other holder the renewal',
    file: SL,
    edits: [['      deps.alsoInto?.(retired, snapshot);\n', '\n']],
    specs: [IS("carries a renewal a terminal session's Claude made into the editor's folder")],
  },
  {
    name: "R7 a renewal the editor's Claude made never goes home",
    file: FOLDER,
    edits: [
      [
        "    return installFromText(account, accounts, text, c, 'the editor renewed this login; saved home') ? 'taken' : 'none';\n",
        "    return 'none';\n",
      ],
    ],
    specs: [FT("takes home a renewal the editor's Claude made before ccx renews that account"), IS('takes home, at a worker start')],
  },
  {
    name: 'R8 a newer copy whose owner cannot be asked does not hold a renewal back',
    file: US,
    edits: [["        : editorCopy === 'unconfirmed'\n", "        : editorCopy === ('never' as string)\n"]],
    specs: [FT('does not renew that account while whose that renewal is cannot be asked')],
  },
  {
    name: "R9 a terminal session never takes up the editor's renewal while both run",
    file: SESSION,
    edits: [
      [
        '    if (!lookingAtEditor && now - lastEditorLook >= (context.editorTakeUpMs ?? EDITOR_TAKE_UP_MS)) {\n',
        '    if (lookingAtEditor && now - lastEditorLook >= (context.editorTakeUpMs ?? EDITOR_TAKE_UP_MS)) {\n',
      ],
    ],
    specs: [IS('takes up, in a terminal session on the account the editor is on')],
  },
  {
    name: "R10 a session start does not take the editor's renewal home first",
    file: SESSION,
    edits: [
      [
        '      const editorCopy = await takeUpEditorRenewal(context.ctx, {\n',
        "      const editorCopy = 'none' as string;\n      void Promise.resolve({\n",
      ],
    ],
    specs: [IS('takes home, at a worker start')],
  },
  {
    name: 'R11 a terminal session start does not bring the editor into step',
    file: SESSION,
    edits: [
      [
        '        setActive(account.name, context.ctx);\n        void moveEditorToActive(context);\n      }\n      nextStartTargeted = false;',
        '        setActive(account.name, context.ctx);\n      }\n      nextStartTargeted = false;',
      ],
    ],
    specs: [IS('brings the editor folder into step with your files at a terminal session start')],
  },
  {
    name: 'M1 an install on the old link is never moved',
    file: FOLDER,
    edits: [['      const moved = await moveIntoFolder(context);\n', "      const moved = 'deferred';\n"]],
    specs: [FT('moves at the first switch, at the same path'), FT('moves with a chat file held open')],
  },
  {
    name: "M2 the account folders' chats are not merged on the move",
    file: FOLDER,
    edits: [['    adoptFolderHistory(a.dir, a.name, c, writer, true);\n', '\n']],
    specs: [FT('moves at the first switch, at the same path')],
  },
  {
    name: "M3 a login kept in the editor's own Keychain item does not go home",
    file: FOLDER,
    edits: [['    if (account && newerThanStored(item, account)) {\n', "    if (account && newerThanStored(item, account) && item === '') {\n"]],
    specs: [FT("gives back, as it moves, the login file its Claude's first save took")],
  },
  {
    name: 'M4 the move does not wait for an open editor chat',
    file: FOLDER,
    edits: [["  if (chatsOpen && !waitedLongEnough(c)) return 'deferred';\n", '\n']],
    specs: [FT('waits while an editor chat started through the link is open')],
  },
  {
    name: "M5 the move's wait never ends",
    file: FOLDER,
    edits: [
      [
        "    if (typeof since === 'number') return Date.now() - since >= EDITOR_MOVE_WAIT_MS;\n",
        "    if (typeof since === 'number') return false;\n",
      ],
    ],
    specs: [FT('waits while an editor chat started through the link is open')],
  },
  {
    name: 'O1 retiring the folder does not save its login home',
    file: FOLDER,
    edits: [['    if (account) saveEditorLoginHome(account, accounts, login, c);\n', '\n']],
    specs: [FT('retires the folder losing nothing')],
  },
  {
    name: 'O2 retiring the folder hands nothing back',
    file: FOLDER,
    edits: [
      [
        '    const synced = refreshClaudeFolder(dir, c);\n',
        "    const synced = { settings: 'synced', state: 'synced', files: true };\n",
      ],
    ],
    specs: [FT('retires the folder losing nothing')],
  },
  {
    name: "O3 retiring the folder leaves its Keychain items",
    file: FOLDER,
    edits: [['    try {\n      removeFolderLogin(login);\n    } catch {\n      return false;\n    }\n', '']],
    specs: [FT('leaves no login behind in the Keychain item')],
  },
  {
    name: 'O4 ccx editor off forgets how the setting spelled the folder',
    file: ED,
    edits: [
      [
        '  if (editorsOnFolder(context.ctx).length === 0 && !retireEditor(context, spellings)) {\n',
        '  if (editorsOnFolder(context.ctx).length === 0 && !retireEditor(context)) {\n',
      ],
    ],
    specs: [FT('leaves no login behind in the Keychain item')],
  },
  {
    name: 'O5 ccx editor off retires the folder while another editor uses it',
    file: ED,
    edits: [
      [
        '  if (editorsOnFolder(context.ctx).length === 0 && !retireEditor(context, spellings)) {\n',
        '  if (!retireEditor(context, spellings)) {\n',
      ],
    ],
    specs: [FT('keeps the folder while another editor is still set to it')],
  },
  {
    name: 'O6 ccx editor on rewrites a setting that already names the folder',
    file: ED,
    edits: [['  if (now === null || !namesEditorFolder(now, context.ctx)) {\n', '  if (true) {\n']],
    specs: [FT('leaves an editor setting that names the folder another way as it is')],
  },
  // CodeRabbit's findings on 2af0601.
  {
    name: "F1 a running session looks for the editor's renewal at every pull",
    file: SESSION,
    edits: [
      [
        '    if (!lookingAtEditor && now - lastEditorLook >= (context.editorTakeUpMs ?? EDITOR_TAKE_UP_MS)) {\n',
        '    if (!lookingAtEditor) {\n',
      ],
    ],
    specs: [IS('looks for a renewal the editor made at most once a minute while a session runs')],
  },
  {
    name: "F2 a start renews though the editor's newer login cannot be confirmed",
    file: SESSION,
    edits: [
      [
        '          renewalDue: () => !editorHoldsNewer && renewalIsDue(account.dir),\n',
        '          renewalDue: () => renewalIsDue(account.dir),\n',
      ],
    ],
    specs: [IS("starts on the login it has, neither renewing nor asking about it")],
  },
  {
    name: "F3 a start asks about its login though the editor's newer one cannot be confirmed",
    file: SESSION,
    edits: [['            if (editorHoldsNewer) return null;\n', '\n']],
    specs: [IS("starts on the login it has, neither renewing nor asking about it")],
  },
  // CodeRabbit's finding on a430149.
  {
    name: 'G1 a move with an editor chat open leaves no note for one more merge',
    file: FOLDER,
    edits: [['  if (chatsOpen || !merged) {\n', '  if (false) {\n']],
    specs: [FT('merges once more, after the editor chat open at the move closes')],
  },
  {
    name: 'G2 the merge after the chat closes merges nothing',
    file: FOLDER,
    edits: [['      if (!adoptFolderHistory(a.dir, a.name, c, writer, false)) merged = false;\n', '\n']],
    specs: [FT('merges once more, after the editor chat open at the move closes')],
  },
  // CodeRabbit's findings on 36df767.
  {
    name: 'H1 the note goes though the later merge failed',
    file: FOLDER,
    edits: [['    if (merged) rmSync(lateMergeFile(c), { force: true });\n', '    rmSync(lateMergeFile(c), { force: true });\n']],
    specs: [FT("tries the account folders' history again at a later refresh")],
  },
  {
    name: "H2 a move whose merge failed leaves no note to try again",
    file: FOLDER,
    edits: [['  if (chatsOpen || !merged) {\n', '  if (chatsOpen) {\n']],
    specs: [FT("tries the account folders' history again at a later refresh")],
  },
  {
    name: 'H3 a history that could not be merged reads as merged',
    file: SR,
    edits: [["    if (outcome === 'failed') merged = false;\n", '\n']],
    specs: [FT("tries the account folders' history again at a later refresh")],
  },
  // CodeRabbit's findings on e40fa05.
  {
    name: 'K1 a failure inside a tree reads as merged',
    file: SR,
    edits: [['      if (lstatOrNull(from)) merged = false; // one gone since it was listed has nothing to merge\n', '\n']],
    specs: [FT('tries a chat again at a later refresh')],
  },
  {
    name: 'K2 a failure deeper in a tree is not passed up',
    file: SR,
    edits: [['        if (!mergeTree(from, to, clash, rel)) merged = false;\n', '        mergeTree(from, to, clash, rel);\n']],
    specs: [FT('tries a chat again at a later refresh')],
  },
  {
    name: 'K3 the adoption drops what its trees report',
    file: SR,
    edits: [
      [
        '      if (!mergeTree(own, path.join(root, name), adoptClash(`${label}-${name}`, c))) merged = false;\n',
        '      mergeTree(own, path.join(root, name), adoptClash(`${label}-${name}`, c));\n',
      ],
    ],
    specs: [FT('tries a chat again at a later refresh')],
  },
  {
    name: 'K4 a chat that ran on in the account folder is not added to',
    file: SR,
    edits: [['          appendFileSync(to, readRange(from, yours.size, theirs.size));\n', '\n']],
    specs: [FT('adds to a chat you already have')],
  },
  {
    name: 'K5 the whole account copy is added, not the rest of it',
    file: SR,
    edits: [['readRange(from, yours.size, theirs.size)', 'readRange(from, 0n, theirs.size)']],
    specs: [FT('adds to a chat you already have')],
  },
  {
    name: 'K6 an account copy that differs is added to yours',
    file: SR,
    edits: [
      [
        '        if (theirs.size > yours.size && !isLink(to) && sameStart(from, to, yours.size)) {\n',
        '        if (theirs.size > yours.size && !isLink(to)) {\n',
      ],
    ],
    specs: [FT('keeps aside, once, an account copy')],
  },
  {
    name: 'K7 an account copy that differs is not kept aside',
    file: SR,
    edits: [["      return keepFileAside(from, path.join(configHome(c), 'rescued', label, relative));\n", '      return true;\n']],
    specs: [FT('keeps aside, once, an account copy')],
  },
  {
    name: 'K8 a copy kept aside is kept again at every pass',
    file: SR,
    edits: [
      [
        '    if (sameFile(from, at) || (there?.isFile() && there.size === size && sameStart(from, at, size))) return true;\n',
        '\n',
      ],
    ],
    specs: [FT('keeps aside, once, an account copy')],
  },
  {
    name: "K9 yours holding all of the account's copy reads as a difference",
    file: SR,
    edits: [['        if (theirs.size <= yours.size && sameStart(from, to, theirs.size)) return true;\n', '\n']],
    specs: [FT('keeps aside, once, an account copy')],
  },
  {
    name: 'G3 the merge after the move does not wait for the chat to close',
    file: FOLDER,
    edits: [["  if (typeof target === 'string' && editorChatsOpen(target)) return;\n", '\n']],
    specs: [FT('merges once more, after the editor chat open at the move closes')],
  },
  {
    name: "P1 ccx's own settings entries go out to your file",
    file: WB,
    edits: [
      [
        '    const going = base === null ? pick(out(ours), LEGACY_SETTINGS) : out(ours);\n',
        '    const going = base === null ? pick(ours, LEGACY_SETTINGS) : ours;\n',
      ],
    ],
    specs: [FS],
  },
  {
    name: "P2 ccx's own settings entries are not put back in",
    file: WB,
    edits: [
      [
        '    writeFileAtomic(own, `${JSON.stringify(into(user), null, 2)}\\n`);\n',
        '    writeFileAtomic(own, `${JSON.stringify(user, null, 2)}\\n`);\n',
      ],
    ],
    specs: [FS],
  },
];

const onlyAt = process.argv.indexOf('--only');
const only = onlyAt === -1 ? null : (process.argv[onlyAt + 1] ?? '').split(',').filter(Boolean);
const chosenMutants = only === null ? MUTANTS : MUTANTS.filter((m) => only.some((p) => m.name.startsWith(`${p} `)));

/** The specs every mutant's are checked against first, whole. */
const BASELINE = [
  { file: FT_SPEC },
  { file: IS_SPEC },
  FS,
  { file: 'test/integration/artifact-routing.test.ts' },
  { file: 'test/integration/thin-session.test.ts' },
];

const label = (spec) => (spec.filter ? `${spec.file} -t "${spec.filter}"` : spec.file);

if (process.argv.includes('--check')) {
  let bad = 0;
  for (const mutant of MUTANTS) {
    let text = readFileSync(mutant.file, 'utf8');
    for (const [find, replace] of mutant.edits) {
      const count = text.split(find).length - 1;
      if (count !== 1) bad++;
      console.log(`${count === 1 ? 'ok ' : 'BAD'}  ${count} match  ${mutant.name}`);
      text = text.replace(find, () => replace);
    }
  }
  process.exit(bad === 0 ? 0 : 2);
}

const OUT = mkdtempSync(path.join(tmpdir(), 'mutants-157-'));
let runs = 0;

/** The first line of a failure, which names the error. */
const firstLine = (message) => String(message ?? '').split('\n')[0];
const onAnAssertion = (test) => (test.failureMessages ?? []).some((m) => firstLine(m).startsWith('AssertionError'));

/** One vitest run of `spec`, read from its JSON report. */
function vitest(spec) {
  const outputFile = path.join(OUT, `run-${runs++}.json`);
  const args = ['vitest', 'run', '--reporter=json', `--outputFile=${outputFile}`, spec.file];
  if (spec.filter) args.push('-t', spec.filter);
  const result = spawnSync('npx', args, {
    stdio: ['ignore', 'ignore', 'inherit'],
    shell: process.platform === 'win32',
  });
  let report;
  try {
    report = JSON.parse(readFileSync(outputFile, 'utf8'));
  } catch {
    return { verdict: 'broken', why: `no report (exit ${result.status})`, tests: [] };
  }
  const files = report.testResults ?? [];
  const tests = files.flatMap((f) => f.assertionResults ?? []);
  const unloaded = files.filter((f) => f.status === 'failed' && (f.assertionResults ?? []).length === 0);
  if (unloaded.length > 0) {
    return { verdict: 'broken', why: `did not load: ${unloaded.map((f) => f.name).join(', ')}`, tests };
  }
  const failed = tests.filter((t) => t.status === 'failed');
  if (result.status === 0 && failed.length === 0 && tests.some((t) => t.status === 'passed')) {
    return { verdict: 'passed', tests };
  }
  if (result.status === 1 && failed.some(onAnAssertion)) return { verdict: 'failed', tests };
  return {
    verdict: 'broken',
    why: `exit ${result.status}, ${failed.length} failing, none on an assertion: ${failed
      .map((t) => firstLine(t.failureMessages?.[0]))
      .join(' | ')}`,
    tests,
  };
}

const oldAt = process.argv.indexOf('--old');
if (oldAt !== -1) {
  const ref = process.argv[oldAt + 1];
  if (!ref) {
    console.error('--old needs a ref');
    process.exit(2);
  }
  // The touched sources go back and the added ones go; the tests and the fake claude stay.
  const restored = spawnSync('git', ['checkout', ref, '--', ...TOUCHED], { stdio: 'inherit' });
  if (restored.status !== 0) {
    console.error(`could not put the touched sources back as at ${ref}`);
    process.exit(2);
  }
  for (const file of ADDED) rmSync(file, { force: true });
  let wrong = 0;
  console.log(`\n==== the new tests against ${ref} ====`);
  for (const spec of [{ file: FT_SPEC }, { file: IS_SPEC }]) {
    const run = vitest(spec);
    if (run.verdict === 'broken' && run.tests.length === 0) {
      console.log(`BROKEN  ${label(spec)}: ${run.why}`);
      wrong++;
      continue;
    }
    for (const test of run.tests) {
      if (test.status === 'skipped' || test.status === 'pending' || test.status === 'todo') continue;
      const pin = PINS.some((start) => test.title.startsWith(start));
      const ok = pin ? test.status === 'passed' : test.status === 'failed' && onAnAssertion(test);
      if (!ok) wrong++;
      const said = test.status === 'failed' ? `  ::  ${firstLine(test.failureMessages?.[0]).slice(0, 200)}` : '';
      console.log(`${ok ? 'as due' : 'WRONG '}  ${pin ? 'pin' : 'new'}  ${test.status}  ${test.fullName}${said}`);
    }
  }
  process.exit(wrong === 0 ? 0 : 1);
}

const baseline = BASELINE.map((spec) => ({ spec, ...vitest(spec) }));
for (const b of baseline) console.log(`baseline ${b.verdict}  ${label(b.spec)}  (${b.tests.length} tests)`);
const red = baseline.filter((b) => b.verdict !== 'passed');
if (red.length > 0) {
  for (const b of red) {
    const failing = b.tests
      .filter((t) => t.status === 'failed')
      .map((t) => `${t.fullName}: ${firstLine(t.failureMessages?.[0])}`);
    console.error(`BASELINE not green: ${label(b.spec)} (${b.why ?? failing.join('; ')})`);
  }
  process.exit(2);
}

const report = [];
for (const mutant of chosenMutants) {
  const original = readFileSync(mutant.file, 'utf8');
  let mutated = original;
  for (const [find, replace] of mutant.edits) {
    const count = mutated.split(find).length - 1;
    if (count !== 1) {
      console.error(`${mutant.name}: expected one match in ${mutant.file}, found ${count}`);
      process.exit(2);
    }
    mutated = mutated.replace(find, () => replace);
  }
  writeFileSync(mutant.file, mutated);
  if (readFileSync(mutant.file, 'utf8') === original) {
    console.error(`${mutant.name}: the file did not change`);
    process.exit(2);
  }
  try {
    for (const spec of mutant.specs) report.push({ mutant: mutant.name, spec: label(spec), ...vitest(spec) });
  } finally {
    writeFileSync(mutant.file, original);
  }
}

console.log('\n==== mutation report ====');
const word = { failed: 'killed  ', passed: 'SURVIVED', broken: 'BROKEN  ' };
for (const r of report) {
  console.log(`${word[r.verdict]}  ${r.mutant}  ::  ${r.spec}`);
  if (r.verdict === 'failed') {
    for (const t of r.tests.filter((x) => x.status === 'failed' && onAnAssertion(x)).slice(0, 3)) {
      console.log(`            red: ${t.fullName}  ::  ${firstLine(t.failureMessages?.[0]).slice(0, 160)}`);
    }
  }
  if (r.verdict === 'broken') console.log(`            ${r.why}`);
}
const killed = report.filter((r) => r.verdict === 'failed').length;
console.log(`\n${killed} of ${report.length} mutant and spec pairs killed, ${chosenMutants.length} mutants`);
if (report.some((r) => r.verdict === 'broken')) process.exit(2);
process.exit(report.every((r) => r.verdict === 'failed') ? 0 : 1);
