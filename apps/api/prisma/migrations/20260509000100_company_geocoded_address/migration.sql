-- Snapshot of the formatted address Mapbox geocoded against. Lets the UI
-- detect "address changed since geocode" by string compare instead of a
-- timestamp heuristic — `updatedAt` bumps on every write (including the
-- enqueue's status update) so timestamps would always read stale.
ALTER TABLE "Company" ADD COLUMN "geocodedAddress" TEXT;
