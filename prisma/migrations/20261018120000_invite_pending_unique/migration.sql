-- SPEC §12: at most one pending (not yet accepted) invite per (workspace, email). Re-inviting
-- replaces the pending one, so existing data already satisfies this. Prisma can't express a
-- partial index, so it lives only here.
CREATE UNIQUE INDEX "Invite_workspaceId_email_pending_key" ON "Invite"("workspaceId", "email") WHERE "acceptedAt" IS NULL;
