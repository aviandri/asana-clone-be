// Usage: npm run seed            (only seeds an empty database)
//        npm run seed -- --reset (DELETES ALL DATA first; with NODE_ENV=production it also needs
//                                 --force-production)
//        npm run seed -- --goals-only (non-destructive: adds the demo goal cascade to an already
//                                 seeded database that has no goals yet)
import { parseArgs } from 'node:util';
import { PrismaClient } from '@prisma/client';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { SEED_PASSWORD, databaseIsEmpty, resetDatabase, resetRefusal, seed, seedGoalsOnly } from '../lib/seed.js';

const { values } = parseArgs({
  options: {
    reset: { type: 'boolean', default: false },
    'force-production': { type: 'boolean', default: false },
    'goals-only': { type: 'boolean', default: false },
  },
});

const config = loadConfig();
// Checked before anything connects to the database.
const refusal = values.reset ? resetRefusal(config.NODE_ENV, values['force-production']) : null;
if (refusal) {
  console.error(refusal);
  process.exit(1);
}
const prisma = new PrismaClient();
const app = await buildApp({ config: { ...config, AUTH_RATE_LIMIT_MAX: 1000 }, prisma, logger: false });

try {
  if (values['goals-only']) {
    if (values.reset) throw new Error('--goals-only never resets; drop --reset');
    const result = await seedGoalsOnly(app);
    console.log('goals' in result ? `Seeded ${result.goals} goals.` : `Skipped goal seeding: ${result.skipped}.`);
  } else if (values.reset) {
    await resetDatabase(prisma);
    console.log('Database reset.');
  } else if (!(await databaseIsEmpty(prisma))) {
    console.error('Database already has users; not seeding. Use `npm run seed -- --reset` to wipe it first.');
    process.exitCode = 1;
  }
  if (!values['goals-only'] && process.exitCode !== 1) {
    const counts = await seed(app);
    console.log(
      `Seeded ${counts.users} users, ${counts.teams} teams, ${counts.projects} projects, ${counts.tasks} tasks, ${counts.goals} goals.`,
    );
    console.log(`Log in as admin@example.com / alice@example.com / bob@example.com with password "${SEED_PASSWORD}".`);
  }
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await app.close();
  await prisma.$disconnect();
}
