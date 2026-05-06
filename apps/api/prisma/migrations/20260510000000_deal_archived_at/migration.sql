-- Soft-archive timestamp. Archived deals are dropped from the Pipeline board
-- view; the deal list view exposes archivedAt as a filterable field so users
-- can still find them. Indexed because the board query filters every page
-- load by `archivedAt IS NULL`.
ALTER TABLE "Deal" ADD COLUMN "archivedAt" TIMESTAMP(3);

CREATE INDEX "Deal_archivedAt_idx" ON "Deal" ("archivedAt");
