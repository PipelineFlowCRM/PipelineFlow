-- Polymorphic Note: a note can attach to a Deal, Company, or Contact.
-- Existing rows are deal-attached and unchanged; the CHECK constraint
-- requires exactly one target column to be set on every row.

-- Drop the existing FK so we can relax the column to nullable.
ALTER TABLE "Note" DROP CONSTRAINT "Note_dealId_fkey";

-- Make dealId optional.
ALTER TABLE "Note" ALTER COLUMN "dealId" DROP NOT NULL;

-- New target columns.
ALTER TABLE "Note"
  ADD COLUMN "companyId" INTEGER,
  ADD COLUMN "contactId" INTEGER;

-- Re-add FKs (all three targets cascade-delete the note when the parent goes away).
ALTER TABLE "Note" ADD CONSTRAINT "Note_dealId_fkey"
  FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Note" ADD CONSTRAINT "Note_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Note" ADD CONSTRAINT "Note_contactId_fkey"
  FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Indexes mirror the existing dealId index pattern.
CREATE INDEX "Note_companyId_idx" ON "Note"("companyId");
CREATE INDEX "Note_contactId_idx" ON "Note"("contactId");

-- Exactly one of (dealId, companyId, contactId) must be set per row.
ALTER TABLE "Note" ADD CONSTRAINT "Note_target_exactly_one_chk"
  CHECK (
    (("dealId" IS NOT NULL)::int + ("companyId" IS NOT NULL)::int + ("contactId" IS NOT NULL)::int) = 1
  );
