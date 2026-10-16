import { execFileSync } from 'node:child_process';

// Bring asana_test up to the latest migration once per `vitest run`.
export default function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || !/_test\b/.test(url)) {
    // Tests TRUNCATE every table; refuse to run against anything but a *_test database.
    throw new Error(`TEST_DATABASE_URL must point at a *_test database, got: ${url ?? '(unset)'}`);
  }
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: url },
  });
}
