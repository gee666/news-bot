import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node', include: ['src/**/*.test.ts', 'web/**/*.test.ts'],
    testTimeout: process.env.TEST_DATABASE_URL ? 60_000 : 15_000,
    // PostgreSQL advisory locks span schemas; integration suites share a test database.
    fileParallelism: !process.env.TEST_DATABASE_URL,
  },
});
