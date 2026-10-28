-- CreateEnum
CREATE TYPE "EsteemedCategory" AS ENUM ('leadership', 'entrepreneurs', 'civil_services');

-- CreateTable
CREATE TABLE "BoardMember" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "authority" TEXT NOT NULL,
    "designation" TEXT NOT NULL,
    "photoKey" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BoardMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EsteemedAlumnus" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "batch" INTEGER NOT NULL,
    "position" TEXT NOT NULL,
    "photoKey" TEXT NOT NULL,
    "category" "EsteemedCategory" NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EsteemedAlumnus_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BoardMember_sortOrder_createdAt_idx" ON "BoardMember"("sortOrder", "createdAt");

-- CreateIndex
CREATE INDEX "EsteemedAlumnus_category_sortOrder_idx" ON "EsteemedAlumnus"("category", "sortOrder");
