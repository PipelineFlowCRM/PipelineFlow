-- AlterTable: external-id columns on Note for CSV-import idempotency.
-- Same shape as Company/Contact/Deal (see 20260504000000_import).
ALTER TABLE "Note"
  ADD COLUMN "externalId" TEXT,
  ADD COLUMN "externalSource" TEXT;

CREATE UNIQUE INDEX "note_external_uq" ON "Note"("externalSource", "externalId");
