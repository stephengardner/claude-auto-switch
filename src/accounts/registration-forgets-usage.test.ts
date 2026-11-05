import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every place that registers a new account also drops what is stored under
 * its name (usage/usage-store forgetUsage). The cleanup cannot live in
 * `addAccount` itself, since the usage store already depends on the registry,
 * so this keeps a new registration path from skipping it: the dashboard's
 * `a` once did, and an account added there could start from another
 * account's numbers, a recorded "no 5-hour limit" included.
 */
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [full] : [];
  });
}

describe('registering an account', () => {
  it('drops stored usage under the new name, wherever it is done', () => {
    const callers = sources(SRC).filter(
      (file) => !file.endsWith(path.join('accounts', 'registry.ts')) && /\baddAccount\(/.test(readFileSync(file, 'utf8')),
    );
    expect(callers.length).toBeGreaterThanOrEqual(2);
    for (const file of callers) {
      expect(readFileSync(file, 'utf8'), path.relative(SRC, file)).toMatch(/\bforgetUsage\(/);
    }
  });
});
