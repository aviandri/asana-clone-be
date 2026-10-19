import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';

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
  // Teardown: this run's attachment directory only (vitest.config.ts names it per run).
  return () => {
    const dir = process.env.TEST_STORAGE_DIR;
    if (dir && /asana-be-test-attachments-\d+-\d+$/.test(dir)) rmSync(dir, { recursive: true, force: true });
  };
}
