-- GIN index on Company.domains so the meeting auto-link matcher's
-- `domains: { hasSome: [...] }` query plans as an index lookup instead
-- of a sequential scan. Postgres's GIN index on text[] supports the
-- @> / && operators that Prisma compiles `hasSome` into.
--
-- Backfill is implicit: the existing migration adds the column with a
-- default empty array, so this index is built over rows that mostly
-- have an empty domains[]. Cheap to build at this scale.
CREATE INDEX "Company_domains_idx" ON "Company" USING GIN ("domains");
