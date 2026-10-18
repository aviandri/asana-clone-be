import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import { prisma } from './helpers.js';

// Replays the real migration SQL in a scratch schema of asana_test, so v1.1 data can be inserted
// at the old shape and checked after the §12 workspaces migration.
const SCHEMA = 'migration_test';
const DIR = new URL('../prisma/migrations/', import.meta.url);
const WORKSPACES = '20261018090000_workspaces';

/** A migration's statements (no DO blocks or functions in ours, so `;` at line end splits them). */
function statements(name: string) {
  const sql = readFileSync(new URL(`${name}/migration.sql`, DIR), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
  return sql.split(/;\s*$/m).map((s) => s.trim()).filter(Boolean);
}

async function run(tx: Prisma.TransactionClient, name: string) {
  for (const sql of statements(name)) await tx.$executeRawUnsafe(sql);
}

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await prisma.$disconnect();
});

describe('workspaces migration (SPEC §12)', () => {
  it('moves v1 roles into Mekari memberships and keeps globally inactive users inactive', async () => {
    const before = readdirSync(DIR).filter((d) => /^\d+_/.test(d) && d < WORKSPACES).sort();
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await prisma.$executeRawUnsafe(`CREATE SCHEMA "${SCHEMA}"`);

    const result = await prisma.$transaction(
      async (tx) => {
        // One connection for the whole transaction, so the search path holds for every statement.
        await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${SCHEMA}"`);
        for (const name of before) await run(tx, name);
        await tx.$executeRawUnsafe(`
          INSERT INTO "User" ("id", "email", "name", "passwordHash", "role", "isActive", "avatarColor") VALUES
            ('00000000-0000-4000-8000-000000000001', 'admin@example.com', 'Admin', 'x', 'ADMIN', true, '#000000'),
            ('00000000-0000-4000-8000-000000000002', 'gone@example.com', 'Gone', 'x', 'MEMBER', false, '#000000')`);
        await tx.$executeRawUnsafe(`INSERT INTO "Team" ("id", "name") VALUES ('00000000-0000-4000-8000-0000000000aa', 'Old team')`);
        await run(tx, WORKSPACES);

        return {
          workspaces: await tx.$queryRawUnsafe<{ id: string; name: string }[]>(`SELECT "id"::text, "name" FROM "Workspace"`),
          users: await tx.$queryRawUnsafe<{ email: string; isActive: boolean; lastWorkspaceId: string }[]>(
            `SELECT "email", "isActive", "lastWorkspaceId"::text FROM "User" ORDER BY "email"`,
          ),
          members: await tx.$queryRawUnsafe<{ email: string; role: string; isActive: boolean }[]>(
            `SELECT u."email", m."role"::text, m."isActive" FROM "WorkspaceMember" m JOIN "User" u ON u."id" = m."userId" ORDER BY u."email"`,
          ),
          teams: await tx.$queryRawUnsafe<{ workspaceId: string }[]>(`SELECT "workspaceId"::text FROM "Team"`),
        };
      },
      { timeout: 60_000 },
    );

    expect(result.workspaces.map((w) => w.name)).toEqual(['Mekari']);
    const wsId = result.workspaces[0]!.id;
    expect(result.members).toEqual([
      { email: 'admin@example.com', role: 'ADMIN', isActive: true },
      { email: 'gone@example.com', role: 'MEMBER', isActive: false },
    ]);
    // The global flag survives: a deactivated user must not be able to log in again.
    expect(result.users).toEqual([
      { email: 'admin@example.com', isActive: true, lastWorkspaceId: wsId },
      { email: 'gone@example.com', isActive: false, lastWorkspaceId: wsId },
    ]);
    expect(result.teams).toEqual([{ workspaceId: wsId }]);
  });
});
