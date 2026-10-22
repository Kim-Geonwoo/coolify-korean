import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['pipeline/**/*.test.ts', 'scripts/**/*.test.ts', 'extension/**/*.test.ts'],
    passWithNoTests: false,
  },
});
