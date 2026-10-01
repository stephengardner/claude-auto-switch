/**
 * The program Claude runs for ccx's Desktop hooks: `node hook-entry.js limit|prompt`.
 *
 * Claude runs it in every session on the machine, not only Claude Desktop's,
 * and waits for it before going on, so it decides first and cheaply: anything
 * that is not Desktop is gone before a module of ccx is loaded. See hooks.ts.
 */
if (process.env.CLAUDE_CODE_ENTRYPOINT === 'claude-desktop') {
  const [{ buildContext }, { desktopHookCommand }] = await Promise.all([
    import('../context.js'),
    import('../commands/desktop.js'),
  ]);
  process.exitCode = await desktopHookCommand(buildContext({ quiet: true }), process.argv[2]);
}

export {};
