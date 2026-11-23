// Run by deploy/docker-entrypoint.sh after migrations when BOOTSTRAP_ADMIN_EMAIL is set: creates the
// first admin from BOOTSTRAP_ADMIN_EMAIL / _NAME / _PASSWORD, only while the database has no users.
// For platforms with no shell to run `npm run create-admin` in (e.g. Mekari OneDeploy).
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { ZodError } from 'zod';
import { bootstrapFirstAdmin } from '../lib/bootstrap.js';

const { BOOTSTRAP_ADMIN_EMAIL: email, BOOTSTRAP_ADMIN_NAME: name, BOOTSTRAP_ADMIN_PASSWORD: password } = process.env;

if (!email || !name || !password) {
  console.error('bootstrap-admin: BOOTSTRAP_ADMIN_EMAIL, BOOTSTRAP_ADMIN_NAME and BOOTSTRAP_ADMIN_PASSWORD are all required');
  process.exit(2);
}

const db = new PrismaClient();
try {
  const result = await bootstrapFirstAdmin(db, {
    email,
    name,
    password,
    workspaceName: process.env.DEFAULT_WORKSPACE_NAME || undefined,
  });
  console.log(
    result.status === 'created'
      ? `bootstrap-admin: created admin ${result.user.email} of workspace "${result.workspace.name}"; you can now remove BOOTSTRAP_ADMIN_PASSWORD`
      : 'bootstrap-admin: users already exist, nothing to do',
  );
} catch (err) {
  console.error(
    'bootstrap-admin: FAILED: ' + (err instanceof ZodError ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : String(err)),
  );
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
