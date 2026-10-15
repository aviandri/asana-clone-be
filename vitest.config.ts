import { defineConfig } from 'vitest/config';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://postgres:postgres@127.0.0.1:5433/asana_test?connection_limit=3';
// `test.env` below only reaches test workers; globalSetup (migrations) runs in this process.
process.env.TEST_DATABASE_URL = TEST_DATABASE_URL;

export default defineConfig({
  test: {
    // Integration tests share one database and the box is short on RAM: one worker, files in sequence.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    globalSetup: ['./test/global-setup.ts'],
    testTimeout: 20_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: TEST_DATABASE_URL,
      TEST_DATABASE_URL,
      JWT_SECRET: 'test-secret-test-secret-test-secret',
      APP_URL: 'http://localhost:5173',
      // Tests log in many times from one IP; the limiter has its own test with a low max.
      AUTH_RATE_LIMIT_MAX: '10000',
    },
  },
});
