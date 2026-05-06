-- Geocoding result columns + status fields for the geocode-company worker.
-- Manual-only trigger in v1; geocodingStatus drives the UI's queued/failed
-- states without polling Redis.
ALTER TABLE "Company" ADD COLUMN "latitude" DOUBLE PRECISION;
ALTER TABLE "Company" ADD COLUMN "longitude" DOUBLE PRECISION;
ALTER TABLE "Company" ADD COLUMN "geocodedAt" TIMESTAMP(3);
ALTER TABLE "Company" ADD COLUMN "geocodingStatus" TEXT;
ALTER TABLE "Company" ADD COLUMN "geocodingError" TEXT;

-- Supports the bulk map feed (`WHERE latitude IS NOT NULL`) and future
-- bounding-box queries.
CREATE INDEX "Company_latitude_longitude_idx" ON "Company" ("latitude", "longitude");
