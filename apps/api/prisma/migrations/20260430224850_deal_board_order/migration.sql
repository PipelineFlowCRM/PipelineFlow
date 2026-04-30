-- Add boardOrder column for explicit kanban ordering within a stage.
ALTER TABLE "Deal" ADD COLUMN "boardOrder" INTEGER NOT NULL DEFAULT 0;

-- Backfill: assign per-stage ordering based on the previous updatedAt-desc sort,
-- so the board renders in the same order as before until the user reorders.
UPDATE "Deal" d
SET "boardOrder" = sub.rn - 1
FROM (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY "stageId"
           ORDER BY "updatedAt" DESC, id DESC
         ) AS rn
  FROM "Deal"
) sub
WHERE d.id = sub.id;

-- Replace the single-column stageId index with a composite that supports
-- both (stageId) lookups and the (stageId, boardOrder) sort.
DROP INDEX IF EXISTS "Deal_stageId_idx";
CREATE INDEX "Deal_stageId_boardOrder_idx" ON "Deal"("stageId", "boardOrder");
