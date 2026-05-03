-- AlterTable: external-id columns on existing entities. Nullable so legacy
-- rows continue to satisfy the schema; the unique constraint excludes NULLs
-- so multiple non-imported rows don't conflict.
ALTER TABLE "Company"
  ADD COLUMN "externalId" TEXT,
  ADD COLUMN "externalSource" TEXT;

ALTER TABLE "Contact"
  ADD COLUMN "externalId" TEXT,
  ADD COLUMN "externalSource" TEXT;

ALTER TABLE "Deal"
  ADD COLUMN "externalId" TEXT,
  ADD COLUMN "externalSource" TEXT;

-- Composite unique on (externalSource, externalId). Postgres treats NULL as
-- distinct in unique indexes, so non-imported rows don't collide.
CREATE UNIQUE INDEX "company_external_uq" ON "Company"("externalSource", "externalId");
CREATE UNIQUE INDEX "contact_external_uq" ON "Contact"("externalSource", "externalId");
CREATE UNIQUE INDEX "deal_external_uq"    ON "Deal"   ("externalSource", "externalId");

-- CreateTable: ImportJob
CREATE TABLE "ImportJob" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "entityType" TEXT NOT NULL,
    "sourceFile" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "mapping" JSONB,
    "stageMapping" JSONB,
    "presetUsed" TEXT,
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "createdRows" INTEGER NOT NULL DEFAULT 0,
    "updatedRows" INTEGER NOT NULL DEFAULT 0,
    "errorRows" INTEGER NOT NULL DEFAULT 0,
    "stubCompaniesCreated" INTEGER NOT NULL DEFAULT 0,
    "stubContactsCreated" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ImportJob_userId_idx"    ON "ImportJob"("userId");
CREATE INDEX "ImportJob_status_idx"    ON "ImportJob"("status");
CREATE INDEX "ImportJob_createdAt_idx" ON "ImportJob"("createdAt");

ALTER TABLE "ImportJob"
  ADD CONSTRAINT "ImportJob_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
