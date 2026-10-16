// Usage: npm run seed            (only seeds an empty database)
//        npm run seed -- --reset (DELETES ALL DATA first; with NODE_ENV=production it also needs
//                                 --force-production)
import { parseArgs } from 'node:util';
import { PrismaClient } from '@prisma/client';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { SEED_PASSWORD, databaseIsEmpty, resetDatabase, resetRefusal, seed } from '../lib/seed.js';

const { values } = parseArgs({
  options: {
    reset: { type: 'boolean', default: false },
    'force-production': { type: 'boolean', default: false },
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
  if (values.reset) {
    await resetDatabase(prisma);
    console.log('Database reset.');
  } else if (!(await databaseIsEmpty(prisma))) {
    console.error('Database already has users; not seeding. Use `npm run seed -- --reset` to wipe it first.');
    process.exitCode = 1;
  }
  if (process.exitCode !== 1) {
    const counts = await seed(app);
    console.log(`Seeded ${counts.users} users, ${counts.teams} teams, ${counts.projects} projects, ${counts.tasks} tasks.`);
    console.log(`Log in as admin@example.com / alice@example.com / bob@example.com with password "${SEED_PASSWORD}".`);
  }
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await app.close();
  await prisma.$disconnect();
}
