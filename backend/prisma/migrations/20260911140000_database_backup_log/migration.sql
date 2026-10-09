-- The record of each monthly database backup.
--
-- The dump itself is an object in storage; this row says which month it covers,
-- where it went and how big it was. The unique `period` does two jobs: it makes
-- `jobs/databaseBackup.ts` idempotent — the job runs daily and does nothing
-- once the current month has a row, which is how a monthly backup survives
-- restarts without drifting off the calendar — and it makes retention
-- answerable without a `list()` on the storage interface, since the oldest rows
-- name the objects to prune.


-- CreateTable
CREATE TABLE "DatabaseBackup" (
    "id" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DatabaseBackup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DatabaseBackup_period_key" ON "DatabaseBackup"("period");

-- CreateIndex
CREATE INDEX "DatabaseBackup_createdAt_idx" ON "DatabaseBackup"("createdAt");

