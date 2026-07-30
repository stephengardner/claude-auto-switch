import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // scripts/ is included because the merge gate lives there, and a test file
    // outside these paths does not run at all: it reports nothing and looks like
    // coverage that exists. The gate's tests were silently skipped that way once.
    include: ['src/**/*.test.ts', 'test/**/*.test.ts', 'scripts/**/*.test.ts'],
    environment: 'node',
    // Several tests spawn real `node`/fake-claude child processes; cold starts
    // under CI load can exceed the 5s default, so give them headroom.
    testTimeout: 20000,
    hookTimeout: 20000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/cli.ts'],
    },
  },
});
