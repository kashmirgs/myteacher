import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.test.ts'],
    restoreMocks: true,
    benchmark: {
      include: ['src/**/*.bench.ts'],
    },
  },
});
