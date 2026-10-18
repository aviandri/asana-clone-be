// Usage: npm run create-admin -- --email you@company.com --name "Your Name" --password '…'
// Creates a user, or reactivates an existing one (then --name/--password are optional), and makes
// them ADMIN of the default workspace (DEFAULT_WORKSPACE_NAME, default "Mekari"), creating it if needed.
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
  const { user, created, workspace } = await upsertAdmin(db, {
    email: values.email,
    name: values.name,
    password: values.password,
    workspaceName: process.env.DEFAULT_WORKSPACE_NAME || undefined,
  });
  console.log(`${created ? 'Created' : 'Promoted'} admin ${user.email} (${user.id}) of workspace "${workspace.name}"`);
} catch (err) {
  console.error(err instanceof ZodError ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n') : String(err));
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
