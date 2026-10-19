-- CreateEnum
CREATE TYPE "AttachmentKind" AS ENUM ('FILE', 'LINK');

-- CreateEnum
CREATE TYPE "LinkPreviewStatus" AS ENUM ('PENDING', 'READY', 'FAILED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ActivityType" ADD VALUE 'ATTACHMENT_ADDED';
ALTER TYPE "ActivityType" ADD VALUE 'ATTACHMENT_REMOVED';

-- CreateTable
CREATE TABLE "Attachment" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "commentId" UUID,
    "uploaderId" UUID NOT NULL,
    "kind" "AttachmentKind" NOT NULL,
    "draft" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "name" TEXT,
    "mimeType" TEXT,
    "size" INTEGER,
    "storageKey" TEXT,
    "sha256" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "hasThumbnail" BOOLEAN NOT NULL DEFAULT false,
    "url" TEXT,
    "title" TEXT,
    "description" TEXT,
    "siteName" TEXT,
    "provider" TEXT,
    "previewStatus" "LinkPreviewStatus",
    "iconKey" TEXT,
    "imageKey" TEXT,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Attachment_storageKey_key" ON "Attachment"("storageKey");

-- CreateIndex
CREATE UNIQUE INDEX "Attachment_iconKey_key" ON "Attachment"("iconKey");

-- CreateIndex
CREATE UNIQUE INDEX "Attachment_imageKey_key" ON "Attachment"("imageKey");

-- CreateIndex
CREATE INDEX "Attachment_taskId_createdAt_idx" ON "Attachment"("taskId", "createdAt");

-- CreateIndex
CREATE INDEX "Attachment_commentId_idx" ON "Attachment"("commentId");

-- CreateIndex
CREATE INDEX "Attachment_draft_createdAt_idx" ON "Attachment"("draft", "createdAt");

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "Comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

