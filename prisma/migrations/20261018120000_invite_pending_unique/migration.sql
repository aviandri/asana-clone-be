-- SPEC §12: at most one pending (not yet accepted) invite per (workspace, email). Prisma can't
-- express a partial index, so it lives only here.

-- Re-inviting replaced the pending invite, but v1's delete-then-create could race and leave two
-- (expired ones count too). Keep only the newest pending invite per pair; superseded ones carry
-- nothing worth keeping.
DELETE FROM "Invite" i
USING "Invite" newer
WHERE i."acceptedAt" IS NULL
  AND newer."acceptedAt" IS NULL
  AND newer."workspaceId" = i."workspaceId"
  AND newer."email" = i."email"
  AND (newer."createdAt", newer."id") > (i."createdAt", i."id");

CREATE UNIQUE INDEX "Invite_workspaceId_email_pending_key" ON "Invite"("workspaceId", "email") WHERE "acceptedAt" IS NULL;
