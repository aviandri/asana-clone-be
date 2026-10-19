#!/usr/bin/env bash
# Upgrade check, run by the `upgrade` CI job from each earlier release (v1.1, v1.2).
#
#   upgrade-check.sh snapshot   # after migrating + seeding at the earlier release
#   upgrade-check.sh verify     # after `prisma migrate deploy` on this commit
#
# `snapshot` records row counts (and, from v1.1, each user's old role) in a side schema
# (`upgrade_check`) that Prisma ignores. From a pre-v1.2 schema it first adds the edge cases the
# seed lacks (an inactive user, two pending invites to the same email, a subtask of a personal task).
# `verify` checks nothing was lost, then per feature the upgrade crossed:
# - §12 (only when the snapshot had no Workspace table): one default workspace, a membership per
#   user with their old role and active flag, lastWorkspaceId set, workspaceId filled everywhere
#   (subtasks with their parent), and User.role gone;
# - §13 (once the Attachment table exists): the table and its new enums are there, empty, and
#   ActivityType gained ATTACHMENT_ADDED / ATTACHMENT_REMOVED.
set -euo pipefail

: "${DATABASE_URL:?}"
DB="${DATABASE_URL%%\?*}"   # psql rejects Prisma's ?schema=… parameter
EXPECTED_NAME="${DEFAULT_WORKSPACE_NAME:-Mekari}"

q() { psql "$DB" -v ON_ERROR_STOP=1 -XAtq -c "$1"; }
fail=0
check() { # check <description> <sql returning 't' when OK>
  if [ "$(q "$2")" = "t" ]; then echo "ok   - $1"; else echo "FAIL - $1"; fail=1; fi
}

case "${1:-}" in
snapshot)
  pre_v12=$(q "SELECT to_regclass('public.\"Workspace\"') IS NULL")
  if [ "$pre_v12" = t ]; then
  psql "$DB" -v ON_ERROR_STOP=1 -Xq <<'SQL'
-- Edge cases: an inactive member must stay inactive; a pending invite must get a workspace.
INSERT INTO "User" (id, email, name, "passwordHash", role, "isActive", "avatarColor")
VALUES (gen_random_uuid(), 'inactive@example.com', 'Ina Active', 'x', 'MEMBER', false, '#999999');
INSERT INTO "Invite" (id, email, role, token, "invitedById", "expiresAt")
SELECT gen_random_uuid(), 'pending@example.com', 'MEMBER', 'upgrade-check-token', id, now() + interval '7 days'
FROM "User" WHERE role = 'ADMIN' ORDER BY "createdAt" LIMIT 1;
-- v1 allowed a second pending invite to the same email; the v1.2 partial unique index on pending
-- ("workspaceId", email) needs the migration to dedupe these first.
INSERT INTO "Invite" (id, email, role, token, "invitedById", "expiresAt", "createdAt")
SELECT gen_random_uuid(), 'pending@example.com', 'MEMBER', 'upgrade-check-token-2', id, now() + interval '7 days', now() + interval '1 minute'
FROM "User" WHERE role = 'ADMIN' ORDER BY "createdAt" LIMIT 1;
-- A subtask of a personal (project-less) task must land in its parent's workspace.
INSERT INTO "Task" (id, title, "creatorId", "parentId", "updatedAt")
SELECT gen_random_uuid(), 'Upgrade-check personal subtask', t."creatorId", t.id, now()
FROM "Task" t WHERE t."projectId" IS NULL AND t."parentId" IS NULL ORDER BY t."createdAt" LIMIT 1;

DROP SCHEMA IF EXISTS upgrade_check CASCADE;
CREATE SCHEMA upgrade_check;
CREATE TABLE upgrade_check.users AS SELECT id, role::text AS role, "isActive" AS active FROM "User";
SQL
  else
    q "DROP SCHEMA IF EXISTS upgrade_check CASCADE; CREATE SCHEMA upgrade_check;"
  fi
  psql "$DB" -v ON_ERROR_STOP=1 -Xq <<'SQL'
CREATE TABLE upgrade_check.counts (tbl text PRIMARY KEY, n bigint);
-- Pending invites beyond the first per email: what a dedupe is expected to remove.
CREATE TABLE upgrade_check.pending_dupes AS
SELECT count(*) - count(DISTINCT email) AS extra FROM "Invite" WHERE "acceptedAt" IS NULL;
DO $$
DECLARE t text; c bigint;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', t) INTO c;
    INSERT INTO upgrade_check.counts VALUES (t, c);
  END LOOP;
END $$;
SQL
  q "SELECT tbl || '=' || n FROM upgrade_check.counts ORDER BY tbl" | paste -sd' '
  ;;

verify)
  check "every migration finished (none failed or half-applied)" \
    "SELECT NOT EXISTS (SELECT 1 FROM _prisma_migrations WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)"
  # Nothing lost: every pre-upgrade table still exists with the same number of rows, except that
  # once the pending-invite unique index exists, duplicate pending invites must have been deduped.
  # (Only when this upgrade crosses v1.2: from v1.2 on, the index already existed at snapshot time.)
  dedupe=$(q "SELECT to_regclass('public.\"Invite_workspaceId_email_pending_key\"') IS NOT NULL AND to_regclass('upgrade_check.users') IS NOT NULL")
  while IFS='|' read -r tbl n; do
    if [ "$tbl" = Invite ] && [ "$dedupe" = t ]; then n=$((n - $(q "SELECT extra FROM upgrade_check.pending_dupes"))); fi
    check "$tbl keeps its $n rows" \
      "SELECT to_regclass('public.\"$tbl\"') IS NOT NULL AND (SELECT count(*) FROM public.\"$tbl\") = $n"
  done < <(q "SELECT tbl, n FROM upgrade_check.counts ORDER BY tbl")

  if [ "$(q "SELECT to_regclass('public.\"Attachment\"') IS NOT NULL")" = "t" ]; then
    check "§13 Attachment table exists and is empty (no data invented by the migration)" \
      "SELECT count(*) = 0 FROM \"Attachment\""
    check "§13 enums AttachmentKind (FILE, LINK) and LinkPreviewStatus exist" \
      "SELECT (SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'AttachmentKind') = ARRAY['FILE','LINK']
          AND to_regtype('\"LinkPreviewStatus\"') IS NOT NULL"
    check "§13 ActivityType gained ATTACHMENT_ADDED and ATTACHMENT_REMOVED" \
      "SELECT count(*) = 2 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'ActivityType' AND e.enumlabel IN ('ATTACHMENT_ADDED', 'ATTACHMENT_REMOVED')"
  else
    echo "note - no \"Attachment\" table (pre-v1.3 schema); skipping the §13 checks"
  fi

  if [ "$(q "SELECT to_regclass('public.\"Workspace\"') IS NOT NULL")" != "t" ]; then
    echo "note - no \"Workspace\" table yet (pre-v1.2 schema); skipping the §12 backfill checks"
    exit "$fail"
  fi
  if [ "$(q "SELECT to_regclass('upgrade_check.users') IS NULL")" = "t" ]; then
    echo "note - the snapshot already had workspaces (upgrade from v1.2+); the §12 backfill isn't part of this upgrade"
    exit "$fail"
  fi

  check "exactly one workspace, named '$EXPECTED_NAME', not an organization" \
    "SELECT count(*) = 1 AND bool_and(name = '${EXPECTED_NAME//\'/\'\'}' AND NOT \"isOrganization\" AND domain IS NULL) FROM \"Workspace\""
  check "one membership per user, in that workspace" \
    "SELECT (SELECT count(*) FROM \"WorkspaceMember\") = (SELECT count(*) FROM upgrade_check.users)
        AND NOT EXISTS (SELECT 1 FROM upgrade_check.users u LEFT JOIN \"WorkspaceMember\" m ON m.\"userId\" = u.id WHERE m.\"userId\" IS NULL)"
  check "membership role = old User.role" \
    "SELECT NOT EXISTS (SELECT 1 FROM upgrade_check.users u JOIN \"WorkspaceMember\" m ON m.\"userId\" = u.id WHERE m.role::text <> u.role)"
  check "membership isActive = old User.isActive (inactive users stay inactive)" \
    "SELECT NOT EXISTS (SELECT 1 FROM upgrade_check.users u JOIN \"WorkspaceMember\" m ON m.\"userId\" = u.id WHERE m.\"isActive\" <> u.active)"
  check "every user's lastWorkspaceId is the default workspace" \
    "SELECT NOT EXISTS (SELECT 1 FROM \"User\" WHERE \"lastWorkspaceId\" IS DISTINCT FROM (SELECT id FROM \"Workspace\"))"
  check "User.role column dropped" \
    "SELECT NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'User' AND column_name = 'role')"
  for tbl in Team Project Task Goal Notification Invite; do
    check "$tbl.workspaceId is NOT NULL and filled with the default workspace" \
      "SELECT (SELECT is_nullable = 'NO' FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = '$tbl' AND column_name = 'workspaceId')
          AND NOT EXISTS (SELECT 1 FROM \"$tbl\" WHERE \"workspaceId\" IS DISTINCT FROM (SELECT id FROM \"Workspace\"))"
  done
  check "a task in a project has the project's workspace" \
    "SELECT NOT EXISTS (SELECT 1 FROM \"Task\" t JOIN \"Project\" p ON p.id = t.\"projectId\" WHERE t.\"workspaceId\" <> p.\"workspaceId\")"
  if [ "$dedupe" = t ]; then
    check "at most one pending invite per workspace and email (duplicates deduped)" \
      "SELECT NOT EXISTS (SELECT 1 FROM \"Invite\" WHERE \"acceptedAt\" IS NULL GROUP BY \"workspaceId\", email HAVING count(*) > 1)"
    check "exactly one pending invite left for pending@example.com" \
      "SELECT count(*) = 1 FROM \"Invite\" WHERE \"acceptedAt\" IS NULL AND email = 'pending@example.com'"
  else
    echo "note - no pending-invite unique index yet; skipping the invite dedupe checks"
  fi
  check "a subtask has its parent's workspace" \
    "SELECT NOT EXISTS (SELECT 1 FROM \"Task\" t JOIN \"Task\" p ON p.id = t.\"parentId\" WHERE t.\"workspaceId\" <> p.\"workspaceId\")"
  exit "$fail"
  ;;

*) echo "usage: $0 snapshot|verify" >&2; exit 2 ;;
esac
