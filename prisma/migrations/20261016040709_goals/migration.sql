-- CreateEnum
CREATE TYPE "GoalStatus" AS ENUM ('NO_STATUS', 'ON_TRACK', 'AT_RISK', 'OFF_TRACK', 'ACHIEVED', 'PARTIAL', 'MISSED', 'DROPPED');

-- CreateEnum
CREATE TYPE "GoalProgressSource" AS ENUM ('KEY_RESULTS', 'SUB_GOALS', 'PROJECTS', 'MANUAL');

-- CreateEnum
CREATE TYPE "KeyResultMetric" AS ENUM ('NUMBER', 'PERCENT', 'CURRENCY', 'BOOLEAN');

-- CreateTable
CREATE TABLE "Goal" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "ownerId" UUID NOT NULL,
    "isCompany" BOOLEAN NOT NULL DEFAULT false,
    "teamId" UUID,
    "parentId" UUID,
    "timePeriod" TEXT NOT NULL,
    "status" "GoalStatus" NOT NULL DEFAULT 'NO_STATUS',
    "progressSource" "GoalProgressSource" NOT NULL DEFAULT 'KEY_RESULTS',
    "manualProgress" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Goal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KeyResult" (
    "id" UUID NOT NULL,
    "goalId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "metricType" "KeyResultMetric" NOT NULL,
    "startValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "targetValue" DOUBLE PRECISION NOT NULL,
    "currentValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "unit" TEXT,
    "ownerId" UUID,
    "position" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KeyResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoalProject" (
    "goalId" UUID NOT NULL,
    "projectId" UUID NOT NULL,

    CONSTRAINT "GoalProject_pkey" PRIMARY KEY ("goalId","projectId")
);

-- CreateTable
CREATE TABLE "GoalUpdate" (
    "id" UUID NOT NULL,
    "goalId" UUID NOT NULL,
    "authorId" UUID NOT NULL,
    "status" "GoalStatus" NOT NULL,
    "progress" DOUBLE PRECISION NOT NULL,
    "body" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoalUpdate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Goal_parentId_idx" ON "Goal"("parentId");

-- CreateIndex
CREATE INDEX "Goal_teamId_idx" ON "Goal"("teamId");

-- CreateIndex
CREATE INDEX "Goal_timePeriod_idx" ON "Goal"("timePeriod");

-- CreateIndex
CREATE INDEX "KeyResult_goalId_position_idx" ON "KeyResult"("goalId", "position");

-- CreateIndex
CREATE INDEX "GoalProject_projectId_idx" ON "GoalProject"("projectId");

-- CreateIndex
CREATE INDEX "GoalUpdate_goalId_createdAt_idx" ON "GoalUpdate"("goalId", "createdAt");

-- AddForeignKey
ALTER TABLE "Goal" ADD CONSTRAINT "Goal_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Goal" ADD CONSTRAINT "Goal_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Goal" ADD CONSTRAINT "Goal_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Goal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KeyResult" ADD CONSTRAINT "KeyResult_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KeyResult" ADD CONSTRAINT "KeyResult_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoalProject" ADD CONSTRAINT "GoalProject_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoalProject" ADD CONSTRAINT "GoalProject_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoalUpdate" ADD CONSTRAINT "GoalUpdate_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoalUpdate" ADD CONSTRAINT "GoalUpdate_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
