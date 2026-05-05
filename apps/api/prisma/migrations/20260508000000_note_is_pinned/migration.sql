-- Pinned notes float to the top of the per-entity notes list.
ALTER TABLE "Note" ADD COLUMN "isPinned" BOOLEAN NOT NULL DEFAULT false;
