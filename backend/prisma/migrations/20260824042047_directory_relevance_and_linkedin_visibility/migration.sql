-- AlterTable
ALTER TABLE "Profile" ADD COLUMN     "showLinkedin" BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE INDEX "Profile_department_graduationYear_idx" ON "Profile"("department", "graduationYear");
