-- CreateTable
CREATE TABLE "JobLease" (
    "name" TEXT NOT NULL,
    "lockedUntil" TIMESTAMP(3),
    "lockedBy" TEXT,
    "lastRunAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobLease_pkey" PRIMARY KEY ("name")
);
