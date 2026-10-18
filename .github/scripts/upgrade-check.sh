#!/usr/bin/env bash
# Upgrade check for the v1.2 workspaces migration (SPEC §12), run by the `upgrade` CI job.
#
#   upgrade-check.sh snapshot   # after migrating + seeding at the pre-v1.2 commit
#   upgrade-check.sh verify     # after `prisma migrate deploy` on this commit
#
# `snapshot` adds the edge cases the seed lacks (an inactive user, a pending invite) and records
# row counts and each user's old role in a side schema (`upgrade_check`) that Prisma ignores.
# `verify` checks nothing was lost and, once the Workspace table exists, that the backfill
# matches §12: one default workspace, a membership per user with their old role and active flag,
# lastWorkspaceId set, workspaceId filled everywhere, and User.role gone.
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
  psql "$DB" -v ON_ERROR_STOP=1 -Xq <<'SQL'
-- Edge cases: an inactive member must stay inactive; a pending invite must get a workspace.
INSERT INTO "User" (id, email, name, "passwordHash", role, "isActive", "avatarColor")
VALUES (gen_random_uuid(), 'inactive@example.com', 'Ina Active', 'x', 'MEMBER', false, '#999999');
INSERT INTO "Invite" (id, email, role, token, "invitedById", "expiresAt")
SELECT gen_random_uuid(), 'pending@example.com', 'MEMBER', 'upgrade-check-token', id, now() + interval '7 days'
FROM "User" WHERE role = 'ADMIN' ORDER BY "createdAt" LIMIT 1;

DROP SCHEMA IF EXISTS upgrade_check CASCADE;
CREATE SCHEMA upgrade_check;
CREATE TABLE upgrade_check.users AS SELECT id, role::text AS role, "isActive" AS active FROM "User";
CREATE TABLE upgrade_check.counts (tbl text PRIMARY KEY, n bigint);
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
  # Nothing lost: every pre-upgrade table still exists with the same number of rows.
  while IFS='|' read -r tbl n; do
    check "$tbl keeps its $n rows" \
      "SELECT to_regclass('public.\"$tbl\"') IS NOT NULL AND (SELECT count(*) FROM public.\"$tbl\") = $n"
  done < <(q "SELECT tbl, n FROM upgrade_check.counts ORDER BY tbl")

  if [ "$(q "SELECT to_regclass('public.\"Workspace\"') IS NOT NULL")" != "t" ]; then
    echo "note - no \"Workspace\" table yet (pre-v1.2 schema); skipping the §12 backfill checks"
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
  exit "$fail"
  ;;

*) echo "usage: $0 snapshot|verify" >&2; exit 2 ;;
esac
