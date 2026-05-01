-- Tag bookkeeping columns. The DEFAULT covers existing rows; Prisma drops
-- the default on createdAt for new inserts (it sets the value via Prisma).
-- updatedAt is also expected to be set by Prisma on every write.
ALTER TABLE "Tag"
  ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Swap case-sensitive unique for case-insensitive functional unique.
DROP INDEX "Tag_name_key";
CREATE UNIQUE INDEX "Tag_name_lower_key" ON "Tag" (lower("name"));

-- Polymorphic junction. entityType reuses the existing CustomFieldEntity enum.
CREATE TABLE "TagAttachment" (
    "id" SERIAL NOT NULL,
    "tagId" INTEGER NOT NULL,
    "entityType" "CustomFieldEntity" NOT NULL,
    "entityId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TagAttachment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TagAttachment_tagId_entityType_entityId_key"
  ON "TagAttachment"("tagId", "entityType", "entityId");
CREATE INDEX "TagAttachment_entityType_entityId_idx"
  ON "TagAttachment"("entityType", "entityId");
CREATE INDEX "TagAttachment_tagId_idx" ON "TagAttachment"("tagId");

ALTER TABLE "TagAttachment"
  ADD CONSTRAINT "TagAttachment_tagId_fkey"
  FOREIGN KEY ("tagId") REFERENCES "Tag"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill existing deal tags from the implicit join table.
INSERT INTO "TagAttachment" ("tagId", "entityType", "entityId")
SELECT "B", 'DEAL', "A" FROM "_DealTags";

-- Drop the legacy implicit join.
DROP TABLE "_DealTags";
