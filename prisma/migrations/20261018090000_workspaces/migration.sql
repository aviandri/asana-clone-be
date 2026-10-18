-- SPEC §12 Workspaces. NON-DESTRUCTIVE: existing rows are backfilled into one default workspace
-- before any column becomes NOT NULL, and User.role is copied into WorkspaceMember before it is
-- dropped. The default workspace is named 'Mekari' unless the database setting
-- mekari.default_workspace_name is set before deploying, e.g.
--   ALTER DATABASE asana SET mekari.default_workspace_name = 'Acme';
-- (plain SQL can't read DEFAULT_WORKSPACE_NAME from the environment).

-- CreateEnum
CREATE TYPE "WorkspaceRole" AS ENUM ('ADMIN', 'MEMBER', 'GUEST');

-- CreateTable
CREATE TABLE "Workspace" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "isOrganization" BOOLEAN NOT NULL DEFAULT false,
    "domain" TEXT,
    "color" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceMember" (
    "workspaceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "WorkspaceRole" NOT NULL DEFAULT 'MEMBER',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceMember_pkey" PRIMARY KEY ("workspaceId","userId")
);

-- New columns, nullable until backfilled.
ALTER TABLE "User" ADD COLUMN "lastWorkspaceId" UUID;
ALTER TABLE "Team" ADD COLUMN "workspaceId" UUID;
ALTER TABLE "Project" ADD COLUMN "workspaceId" UUID;
ALTER TABLE "Task" ADD COLUMN "workspaceId" UUID;
ALTER TABLE "Goal" ADD COLUMN "workspaceId" UUID;
ALTER TABLE "Notification" ADD COLUMN "workspaceId" UUID;
ALTER TABLE "Invite" ADD COLUMN "workspaceId" UUID;

-- Backfill. Only when there is existing data: a fresh database gets its first workspace from
-- `npm run create-admin` or `npm run seed`.
CREATE TEMP TABLE "_default_ws" AS SELECT gen_random_uuid() AS "id";

INSERT INTO "Workspace" ("id", "name", "color")
SELECT d."id", COALESCE(NULLIF(current_setting('mekari.default_workspace_name', true), ''), 'Mekari'), '#4186e0'
FROM "_default_ws" d
WHERE EXISTS (SELECT 1 FROM "User");

-- Each user's v1 role moves to their membership. v1 deactivation was an admin action, so it becomes
-- an inactive membership, and the global flag is cleared so a workspace admin can re-activate them.
INSERT INTO "WorkspaceMember" ("workspaceId", "userId", "role", "isActive", "joinedAt")
SELECT w."id", u."id", u."role"::text::"WorkspaceRole", u."isActive", u."createdAt"
FROM "User" u CROSS JOIN "Workspace" w;

UPDATE "User" SET "lastWorkspaceId" = (SELECT "id" FROM "Workspace"), "isActive" = true;
UPDATE "Team" SET "workspaceId" = (SELECT "id" FROM "Workspace");
UPDATE "Project" SET "workspaceId" = (SELECT "id" FROM "Workspace");
UPDATE "Task" SET "workspaceId" = (SELECT "id" FROM "Workspace");
UPDATE "Goal" SET "workspaceId" = (SELECT "id" FROM "Workspace");
UPDATE "Notification" SET "workspaceId" = (SELECT "id" FROM "Workspace");
UPDATE "Invite" SET "workspaceId" = (SELECT "id" FROM "Workspace");

DROP TABLE "_default_ws";

ALTER TABLE "Team" ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "Project" ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "Task" ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "Goal" ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "Notification" ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "Invite" ALTER COLUMN "workspaceId" SET NOT NULL;

-- Invite.role and the dropped User.role move to the new enum.
ALTER TABLE "Invite" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "Invite" ALTER COLUMN "role" TYPE "WorkspaceRole" USING "role"::text::"WorkspaceRole";
ALTER TABLE "Invite" ALTER COLUMN "role" SET DEFAULT 'MEMBER';
ALTER TABLE "User" DROP COLUMN "role";
DROP TYPE "Role";

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_domain_key" ON "Workspace"("domain");
CREATE INDEX "WorkspaceMember_userId_idx" ON "WorkspaceMember"("userId");
CREATE INDEX "Goal_workspaceId_idx" ON "Goal"("workspaceId");
CREATE INDEX "Invite_workspaceId_idx" ON "Invite"("workspaceId");
CREATE INDEX "Notification_workspaceId_userId_read_idx" ON "Notification"("workspaceId", "userId", "read");
CREATE INDEX "Project_workspaceId_idx" ON "Project"("workspaceId");
CREATE INDEX "Task_workspaceId_idx" ON "Task"("workspaceId");
CREATE INDEX "Team_workspaceId_idx" ON "Team"("workspaceId");

-- AddForeignKey
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "User" ADD CONSTRAINT "User_lastWorkspaceId_fkey" FOREIGN KEY ("lastWorkspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Team" ADD CONSTRAINT "Team_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Project" ADD CONSTRAINT "Project_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Goal" ADD CONSTRAINT "Goal_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
