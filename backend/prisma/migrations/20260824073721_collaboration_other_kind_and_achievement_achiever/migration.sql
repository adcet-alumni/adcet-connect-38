-- AlterEnum
ALTER TYPE "CollaborationType" ADD VALUE 'OTHER';

-- AlterTable
ALTER TABLE "Achievement" ADD COLUMN     "achieverLinkedinUrl" TEXT,
ADD COLUMN     "achieverName" TEXT;
