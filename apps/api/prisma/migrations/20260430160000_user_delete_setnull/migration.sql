-- Make user-authored content survive account deletion.
-- Drop the strict (RESTRICT) FKs and re-create them as SET NULL on delete,
-- and relax the columns to nullable.

-- Deal.ownerId
ALTER TABLE "Deal" DROP CONSTRAINT "Deal_ownerId_fkey";
ALTER TABLE "Deal" ALTER COLUMN "ownerId" DROP NOT NULL;
ALTER TABLE "Deal"
  ADD CONSTRAINT "Deal_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Note.createdBy
ALTER TABLE "Note" DROP CONSTRAINT "Note_createdBy_fkey";
ALTER TABLE "Note" ALTER COLUMN "createdBy" DROP NOT NULL;
ALTER TABLE "Note"
  ADD CONSTRAINT "Note_createdBy_fkey"
  FOREIGN KEY ("createdBy") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Attachment.uploadedBy
ALTER TABLE "Attachment" DROP CONSTRAINT "Attachment_uploadedBy_fkey";
ALTER TABLE "Attachment" ALTER COLUMN "uploadedBy" DROP NOT NULL;
ALTER TABLE "Attachment"
  ADD CONSTRAINT "Attachment_uploadedBy_fkey"
  FOREIGN KEY ("uploadedBy") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
