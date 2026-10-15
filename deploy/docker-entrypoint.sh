#!/bin/sh
# Apply pending migrations, then hand off to the app (exec so it receives signals as PID 1).
set -e
if [ "${SKIP_MIGRATIONS:-false}" != "true" ]; then
  npx --no-install prisma migrate deploy
fi
exec "$@"
