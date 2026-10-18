#!/bin/sh
# Apply pending migrations, then hand off to the app (exec so it receives signals as PID 1).
set -e
if [ "${SKIP_MIGRATIONS:-false}" != "true" ]; then
  if [ -n "${DEFAULT_WORKSPACE_NAME:-}" ]; then
    # The v1.2 workspaces migration is plain SQL and can't read env vars; it names the default
    # workspace from the database setting mekari.default_workspace_name (else "Mekari").
    # Harmless once that migration has run. Quotes are doubled for the SQL literal.
    name=$(printf '%s' "$DEFAULT_WORKSPACE_NAME" | sed "s/'/''/g")
    printf "DO \$ws\$ BEGIN EXECUTE format('ALTER DATABASE %%I SET mekari.default_workspace_name = %%L', current_database(), '%s'); END \$ws\$;\n" "$name" \
      | npx --no-install prisma db execute --stdin --url "$DATABASE_URL" \
      || echo "WARNING: could not set mekari.default_workspace_name; a pending v1.2 migration will name the workspace \"Mekari\"" >&2
  fi
  npx --no-install prisma migrate deploy
fi
exec "$@"
