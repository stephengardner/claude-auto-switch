/**
 * Tests must never reach the developer's real Claude folders.
 *
 * Run from inside a Claude Code or ccx session, the environment says which
 * config folder that session uses (`CLAUDE_CONFIG_DIR`), that it is a Claude
 * process (`CLAUDECODE`) and more. A fake `claude` a test started without
 * setting its own folder inherited the live session's, and wrote its records
 * into it. Every test starts from an environment with none of them; a test
 * that needs one sets it itself.
 */
for (const name of Object.keys(process.env)) {
  if (/^CLAUDE/i.test(name)) delete process.env[name];
}
