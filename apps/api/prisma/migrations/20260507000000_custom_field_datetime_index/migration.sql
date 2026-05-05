-- Index on (definitionId, valueDateTime) so list-view filters and sorts on
-- a DATETIME custom field don't scan the table. The closest analogue today
-- is the `last_enriched_at` field used by the worker's debounce check —
-- which already goes through the unique key — but list-view filters like
-- "show me companies enriched in the last 7 days" land on this index.
--
-- Other typed columns (valueDate, valueNumber, etc.) intentionally don't
-- have per-column indexes; the `(entityType, entityId)` composite handles
-- the read-an-entity's-fields path. We add this one because DATETIME is
-- specifically motivated by the enrichment-history query pattern and is
-- expected to grow with run cadence.

CREATE INDEX "CustomFieldValue_definitionId_valueDateTime_idx"
  ON "CustomFieldValue"("definitionId", "valueDateTime");
