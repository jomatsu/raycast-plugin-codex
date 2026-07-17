import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/raycast-extension/test/**/*.test.ts',
      'packages/codex-raycast/test/**/*.test.ts',
      'test/contract/**/*.test.ts',
    ],
    // Contract tests exercise the hook's settle window with real subprocesses.
    testTimeout: 15_000,
  },
});
