-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateIndex
CREATE INDEX "Post_content_idx" ON "Post" USING GIN ("content" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Profile_currentCompany_trgm_idx" ON "Profile" USING GIN ("currentCompany" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Profile_city_trgm_idx" ON "Profile" USING GIN ("city" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "User_firstName_idx" ON "User" USING GIN ("firstName" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "User_lastName_idx" ON "User" USING GIN ("lastName" gin_trgm_ops);
