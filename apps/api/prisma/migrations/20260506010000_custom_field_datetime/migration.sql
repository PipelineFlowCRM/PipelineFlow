-- Add DATETIME as a first-class custom-field type. Stored in a dedicated
-- valueDateTime column (TIMESTAMP(3) — Prisma's default precision) since
-- valueDate is @db.Date and can't carry a time component.
--
-- Postgres won't let `ALTER TYPE ... ADD VALUE` execute alongside SQL that
-- *uses* the new value in the same transaction; here we only declare the
-- enum value and the column, so the two statements coexist fine.

-- AlterEnum
ALTER TYPE "CustomFieldType" ADD VALUE 'DATETIME';

-- AlterTable
ALTER TABLE "CustomFieldValue" ADD COLUMN "valueDateTime" TIMESTAMP(3);
