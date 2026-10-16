// Usage: npm run create-admin -- --email you@company.com --name "Your Name" --password '…'
// Creates an ADMIN, or promotes an existing user (then --name/--password are optional).
import 'dotenv/config';
import { parseArgs } from 'node:util';
import { PrismaClient } from '@prisma/client';
import { ZodError } from 'zod';
import { upsertAdmin } from '../lib/bootstrap.js';

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    password: { type: 'string' },
  },
});

if (!values.email) {
  console.error('Usage: npm run create-admin -- --email <email> [--name <name>] [--password <password>]');
  process.exit(2);
}

const db = new PrismaClient();
try {
  const { user, created } = await upsertAdmin(db, {
    email: values.email,
    name: values.name,
    password: values.password,
  });
  console.log(`${created ? 'Created' : 'Promoted'} admin ${user.email} (${user.id})`);
} catch (err) {
  console.error(err instanceof ZodError ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n') : String(err));
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
