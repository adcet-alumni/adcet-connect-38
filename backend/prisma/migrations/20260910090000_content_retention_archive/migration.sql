-- Retention for jobs and events.
--
-- A job stops being shown 30 days after it is posted and is deleted at 45; a
-- past event is deleted six months after it ran. What must NOT go with them is
-- what was counted: the admin dashboard buckets both by month, status and
-- department, and the CSV exports list what was posted.
--
-- `ArchivedContent` is where those numbers survive. The retention sweep writes
-- one row here in the same transaction that deletes the source, so the two can
-- never disagree, and `(kind, sourceId)` is unique so a half-failed sweep that
-- runs again cannot count one posting into a month twice.


-- CreateEnum
CREATE TYPE "ArchivedContentKind" AS ENUM ('JOB', 'EVENT');

-- CreateTable
CREATE TABLE "ArchivedContent" (
    "id" TEXT NOT NULL,
    "kind" "ArchivedContentKind" NOT NULL,
    "sourceId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "authorName" TEXT,
    "status" "ApprovalStatus" NOT NULL,
    "departments" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "location" TEXT,
    "company" TEXT,
    "employmentType" "EmploymentType",
    "vacancies" INTEGER,
    "isClosed" BOOLEAN,
    "closedAt" TIMESTAMP(3),
    "applicationCount" INTEGER NOT NULL DEFAULT 0,
    "isOnline" BOOLEAN,
    "chapterId" TEXT,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "rsvpCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArchivedContent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ArchivedContent_kind_createdAt_idx" ON "ArchivedContent"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "ArchivedContent_kind_status_idx" ON "ArchivedContent"("kind", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ArchivedContent_kind_sourceId_key" ON "ArchivedContent"("kind", "sourceId");

