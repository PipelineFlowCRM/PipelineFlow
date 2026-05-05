-- EnrichmentRun: audit row per company-enrichment attempt.
-- See schema.prisma for field-by-field rationale.

CREATE TABLE "EnrichmentRun" (
    "id" TEXT NOT NULL,
    "companyId" INTEGER,
    "companyName" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reason" TEXT,
    "payload" JSONB,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EnrichmentRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EnrichmentRun_companyId_createdAt_idx" ON "EnrichmentRun"("companyId", "createdAt");
CREATE INDEX "EnrichmentRun_status_idx" ON "EnrichmentRun"("status");
CREATE INDEX "EnrichmentRun_createdAt_idx" ON "EnrichmentRun"("createdAt");

ALTER TABLE "EnrichmentRun" ADD CONSTRAINT "EnrichmentRun_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;
