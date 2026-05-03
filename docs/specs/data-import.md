# Spec: CSV Data Import

**Status:** Draft for implementation
**Owner:** William
**Last updated:** 2026-05-03
**Target reader:** Claude Code (implementation agent)

---

## 1. Problem Statement

PipelineFlowCRM has no way to bulk-load existing CRM data. Every prospect onboarding from Pipedrive, HubSpot, Salesforce, or a spreadsheet currently requires hand-entry of Companies, Contacts, and Deals — which is the single biggest blocker to anyone trying the product with their real data. The first user case driving this is a personal Pipedrive migration, but the importer must be generic enough to serve any CSV source on day one.

## 2. Goals

1. Let a user import Companies, Contacts, and Deals from a CSV file in under 5 minutes for a typical 1,000-row dataset.
2. Achieve **zero manual column renaming** for users importing a Pipedrive export — auto-detect Pipedrive's column names and pre-fill the mapping.
3. Resolve cross-entity relationships (Contact → Company, Deal → Company, Deal → primary Contact) automatically during a single multi-file import session.
4. Make imports safe to retry: every job is dry-runnable, errored rows do not block clean rows, and re-imports update existing records via `externalId` instead of duplicating.
5. Ship a foundation that supports HubSpot and Salesforce CSV presets in Phase 2 with no architectural rework.

## 3. Non-Goals

1. **Live Pipedrive API sync.** One-shot CSV is sufficient for the migration use case. Building OAuth, token storage, and paginated fetch logic for a one-time migration is overkill. (May revisit if multiple Pipedrive customers ask for ongoing sync.)
2. **Importing Tasks, Notes, Activities, Attachments.** Out of scope for v1 — these depend on Deals existing first and the relationship resolution gets harder. Phase 2.
3. **Custom fields.** PipelineFlow does not yet support custom fields on Company/Contact/Deal. Importer surfaces unmapped columns as "ignored" but does not store them. Phase 3 once custom fields exist.
4. **Excel (.xlsx) and Google Sheets direct import.** CSV only for v1. Users export to CSV first. Adding xlsx parsing is a small add but not v1.
5. **Two-way sync / export.** Out of scope. Separate initiative.
6. **Background workers / job queues.** v1 runs imports synchronously per HTTP request with streaming response. Async worker is Phase 2 if datasets get large enough to justify it.

## 4. User Stories

### Migrating user (primary persona)

- As a user migrating from Pipedrive, I want to upload a Pipedrive CSV export and have the columns auto-mapped, so I can confirm and import without manually pairing 20+ columns.
- As a user, I want to see a preview of the first 5 rows after upload, so I can confirm the file parsed correctly before committing to mapping.
- As a user, I want to import Companies first, then Contacts, then Deals, so each later import can link to records I just created.
- As a user, I want to see exactly how many rows will create new records vs. update existing ones, so I am not surprised by the result.
- As a user, when a row has an error (missing required field, invalid email format), I want the rest of the file to import successfully and the bad rows reported back to me, so one typo doesn't kill a 1,000-row import.
- As a user, I want to download a CSV of just the failed rows with an `error_reason` column appended, so I can fix and re-import them.

### Returning user

- As a user importing a second file from the same source, I want my previous column mapping remembered as a "preset," so I don't re-do the mapping.
- As a user re-importing the same Pipedrive export after a fix in Pipedrive, I want existing records updated rather than duplicated, via the `externalId` column.

### Admin / safety

- As a user, I want to dry-run an import (validate + preview, no writes), so I can verify the result before committing.
- As a user, I want to see a history of past import jobs with their status, row counts, and a link to the source file, so I can audit what landed in my CRM.

## 5. Requirements

### P0 — Must-Have (v1)

#### P0-1: CSV upload + parse
- Accept `.csv` files up to 10MB / 50,000 rows via `multipart/form-data`.
- Server-side streaming parse using [`csv-parse`](https://www.npmjs.com/package/csv-parse).
- Detect delimiter automatically (`,`, `;`, `\t`).
- Tolerate UTF-8 BOM, mixed line endings (`\n`, `\r\n`), quoted fields with embedded delimiters and newlines.
- Return parse errors with row + column context.
- **Acceptance:**
  - [ ] Upload a 1,000-row CSV with quoted commas — all rows parse correctly
  - [ ] Upload a CSV with UTF-8 BOM — parses without leading garbage in first column header
  - [ ] Upload a 10MB+ file — server returns 413 with friendly error
  - [ ] Upload a malformed CSV (uneven row widths) — returns row-level errors, does not crash

#### P0-2: Three-step import wizard UI
Routes: `/settings/import` (list of past jobs + "New Import" button), `/settings/import/new` (wizard).

**Step 1 — Upload + entity selection.** User picks entity type (Company / Contact / Deal) via radio. Drag-drop or click-to-upload CSV.

**Step 2 — Map columns.** Two-column layout: left is each detected CSV header with first 3 sample values inline, right is a `<Select>` of canonical fields for the chosen entity. Auto-suggested target shown pre-selected. User can mark a column as `Ignore`. A banner at top indicates if a preset matched ("Detected: Pipedrive Persons export — mapping pre-filled").

**Step 3 — Validate + commit.** Shows: total rows, will create N, will update M (matched on email or externalId), will error K. Expandable list of error rows with reason. Two buttons: `Run dry-run again` and `Commit import`. After commit, show success state with link to imported records and button to download error CSV.

- **Acceptance:**
  - [ ] All three steps reachable via Back/Next, no data loss on Back
  - [ ] Mapping persists in component state across step transitions
  - [ ] User can change entity type only by restarting wizard
  - [ ] Commit button is disabled until validation completes successfully

#### P0-3: Auto-detect column mapping
- Fuzzy match each CSV header against canonical fields using normalized comparison (lowercase, strip non-alphanum) plus a synonym table.
- Confidence threshold: only auto-select if score ≥ 0.85; otherwise leave as `Unmapped` (user must pick).
- Synonym table lives in `apps/api/src/import/synonyms.ts` and includes:
  - Company.name ← `name`, `company`, `organization`, `org`, `account`, `business`
  - Company.website ← `website`, `url`, `domain`, `web`
  - Contact.firstName ← `first name`, `firstname`, `given name`, `fname`
  - Contact.lastName ← `last name`, `lastname`, `surname`, `family name`, `lname`
  - Contact.email ← `email`, `email address`, `e-mail`, `primary email`
  - Deal.title ← `title`, `name`, `deal name`, `deal title`, `opportunity`
  - Deal.amount ← `amount`, `value`, `deal value`, `price`, `revenue`
  - (Full list lives in code; this is illustrative.)
- **Acceptance:**
  - [ ] Pipedrive Persons export → 100% of standard columns auto-mapped
  - [ ] HubSpot Companies export → ≥80% of standard columns auto-mapped
  - [ ] Generic "First Name, Last Name, Email, Company" → 100% auto-mapped

#### P0-4: Preset detection
- After parse, run header set against known presets and apply if ≥70% of preset's expected headers are present.
- Bundled presets (in `apps/api/src/import/presets/`):
  - `pipedrive-persons.json`
  - `pipedrive-organizations.json`
  - `pipedrive-deals.json`
  - `hubspot-contacts.json`
  - `hubspot-companies.json`
  - `salesforce-leads.json`
- Each preset is `{ name, sourceLabel, entityType, requiredHeaders[], mapping: { csvHeader → canonicalField } }`.
- UI displays a banner: "Detected: {preset.sourceLabel}. Mapping pre-filled — review and adjust as needed."
- **Acceptance:**
  - [ ] Pipedrive's actual Persons export CSV is detected and fully mapped without user input
  - [ ] Detection does not trigger if headers don't match (e.g., user-built CSV with different names)

#### P0-5: Validation + dry-run
- Validation runs row-by-row using a Zod schema per entity type.
- Validation errors are collected, not thrown — bad rows reported, good rows continue.
- Validation rules:
  - Required: Company.name, Contact.firstName + lastName, Deal.title + stageId
  - Email format check (RFC 5322 lite — Zod's `.email()`)
  - URL normalization (prepend `https://` if missing scheme)
  - Phone normalized via [`libphonenumber-js`](https://www.npmjs.com/package/libphonenumber-js) `.formatInternational()` if parseable; stored as-is otherwise
  - `Deal.amount` parsed via custom parser: strip `$`, `,`, surrounding whitespace, convert `(123.45)` to `-123.45`
  - Dates parsed via [`chrono-node`](https://www.npmjs.com/package/chrono-node) — accepts `2026-03-15`, `3/15/26`, `March 15, 2026`, etc.
- Dry-run returns `{ summary: { totalRows, willCreate, willUpdate, willError }, errors: [{ row, column, value, reason }] }`.
- **Acceptance:**
  - [ ] 1,000-row file with 5 bad rows: dry-run reports `willCreate: 995, willError: 5`
  - [ ] Each error row includes 1-indexed row number matching the source CSV
  - [ ] Date "3/15/26" and "2026-03-15" both parse to the same value
  - [ ] Amount "$1,234.56" parses to `1234.56`

#### P0-6: Relationship resolution
When importing Contacts:
- If a `companyName` column is mapped, resolve to `companyId` in this order:
  1. Match existing Company by case-insensitive name (uses existing `ix_companies_name_lower` index)
  2. If not found, create a new stub Company with that name (only `name` populated)
  3. Cache resolved IDs within the import job to avoid repeated DB hits
- If `companyExternalId` is mapped, prefer match by `externalId` over name match.

When importing Deals:
- Resolve `companyId` via the same logic.
- Resolve `primaryContactId` via email match against existing Contacts. If no match is found, **auto-create a stub Contact** with the email populated and `firstName` / `lastName` left blank (or split from email local-part if that's safer for the Zod schema — implementer's call). Stub creations are counted in the import summary as "auto-created contacts" so the user can review them after import.
- Resolve `stageId` via the **stage mapping sub-step** (see P0-7).

- **Acceptance:**
  - [ ] Importing 100 Contacts where 30 reference "Acme Corp" creates exactly 1 new Company (or matches 1 existing)
  - [ ] Importing a Contact whose `companyName` matches an existing Company case-insensitively links to it (does not duplicate)
  - [ ] Stub Companies created during import are flagged in the result summary so the user knows they were auto-created
  - [ ] Importing a Deal with a `primaryContactEmail` that matches no existing Contact creates a stub Contact (email populated) and links the Deal to it
  - [ ] Stub Contact count appears in the import summary alongside stub Company count

#### P0-7: Stage mapping for Deal imports
- Pipedrive/HubSpot stage names won't match PipelineFlow's stages. After basic column mapping, if the Deal entity is selected and a `stageName` column is mapped, show a sub-step with each unique source stage value paired with a dropdown of PipelineFlow stages.
- Persist this mapping with the saved preset.
- A row whose `stageName` is unmapped is treated as a validation error (user must map every distinct stage).
- **Acceptance:**
  - [ ] Importing a CSV with stages `Lead In`, `Qualified`, `Proposal Sent` shows three rows in the stage-mapping sub-step
  - [ ] Each must be mapped to an existing PipelineStage before commit is allowed

#### P0-8: External ID + idempotency
- Add nullable `externalId TEXT` and `externalSource TEXT` columns to `Company`, `Contact`, `Deal`.
- Composite unique index on `(externalSource, externalId)` per table — `NULL` values do not conflict.
- During import, if a row has both columns mapped and a record with that `(externalSource, externalId)` exists, **update** it instead of creating.
- Update behavior: only overwrite fields that are non-null in the CSV row; do not null out existing data.
- **Acceptance:**
  - [ ] Re-importing the same Pipedrive Persons CSV twice produces the same row counts both times — no duplicates
  - [ ] Editing a value in the CSV and re-importing updates that field on the existing record
  - [ ] A blank cell in the CSV does not overwrite a populated DB field

#### P0-9: Import job persistence
- New Prisma model `ImportJob` (see [§6 Data Model](#6-data-model)).
- Status states: `pending` → `validating` → `validated` (dry-run done) → `committing` → `completed` | `failed`.
- Stored fields include: source filename, entity type, mapping JSON, summary counts, error list (capped at 1,000 rows; full export available via download).
- The original uploaded CSV is stored to S3 (using the existing `@aws-sdk/client-s3` already in deps) under `imports/{jobId}.csv`.
- Listed at `/settings/import` with status, row counts, timestamp, and `Download error rows` link if any errors.
- **Acceptance:**
  - [ ] Every import (dry-run or commit) creates an ImportJob row
  - [ ] Job list page shows last 50 jobs, paginated
  - [ ] Error CSV download contains the original rows plus an `_error_reason` column

#### P0-10: API endpoints
All under `/api/import/`, all require auth via existing `requireAuth` middleware.

- `POST /api/import/upload` — multipart upload, returns `{ jobId, headers[], sampleRows[][], detectedPreset?: {...} }`
- `POST /api/import/:jobId/dry-run` — body: `{ entityType, mapping: { csvHeader → canonicalField | null }, stageMapping?: { sourceStage → stageId } }` — returns `{ summary, errors[] }`
- `POST /api/import/:jobId/commit` — same body as dry-run, idempotent on `(jobId, body hash)` — returns `{ summary, createdIds: { companies: [], contacts: [], deals: [] } }`
- `GET /api/import/jobs` — list past jobs (most recent first, paginated)
- `GET /api/import/jobs/:jobId` — full job detail incl. errors
- `GET /api/import/jobs/:jobId/errors.csv` — error CSV download
- `GET /api/import/presets` — list built-in presets (read-only for v1)

- **Acceptance:**
  - [ ] All endpoints return Zod-validated responses
  - [ ] All endpoints documented in `apps/api/src/routes/import.ts` with JSDoc
  - [ ] Unauthenticated requests get 401

### P1 — Nice-to-Have (fast follow)

- **P1-1: Saved user mappings.** User can save their column mapping as a named preset for that entity type. Stored per-user in `ImportPreset` table.
- **P1-2: Background processing.** Move commit step to a queue (BullMQ or Postgres-backed job table) for files >10k rows. Show progress bar in UI.
- **P1-3: Tag assignment during import.** Map a CSV column to Tag(s); auto-create missing tags.
- **P1-4: Pipedrive landing page.** A `/settings/import/pipedrive` page that walks the user through exporting the 3 CSVs from Pipedrive (with screenshots) and chains the three imports in dependency order.

### P2 — Future Considerations (design for, don't build)

- **P2-1: Pipedrive API direct sync.** Architect the importer so the canonical-field schema is reusable when an API source is added later.
- **P2-2: Custom fields.** When custom fields ship, the mapping UI should render them as additional canonical-field options without a rewrite. Keep the mapping JSON open-ended.
- **P2-3: Tasks / Notes / Activities import.** Out of scope for v1 but the `ImportJob.entityType` enum should be extensible.
- **P2-4: xlsx ingestion.** SheetJS is already in the React deps; future work can add an xlsx → CSV in-memory conversion before parsing.
- **P2-5: Bidirectional sync.** Out of scope, but `externalId` + `externalSource` make this feasible later.

## 6. Data Model

New Prisma migration `20260504000000_import` adds:

```prisma
// External ID + source columns on existing tables
model Company {
  // ...existing fields...
  externalId      String?
  externalSource  String?
  @@unique([externalSource, externalId], name: "company_external_uq")
}

model Contact {
  // ...existing fields...
  externalId      String?
  externalSource  String?
  @@unique([externalSource, externalId], name: "contact_external_uq")
}

model Deal {
  // ...existing fields...
  externalId      String?
  externalSource  String?
  @@unique([externalSource, externalId], name: "deal_external_uq")
}

model ImportJob {
  id           String   @id @default(cuid())
  userId       Int
  user         User     @relation(fields: [userId], references: [id])
  entityType   String   // "company" | "contact" | "deal"
  sourceFile   String   // S3 key
  filename     String   // original filename for display
  status       String   // pending | validating | validated | committing | completed | failed
  mapping      Json?    // { csvHeader: canonicalField }
  stageMapping Json?    // for Deal imports
  presetUsed   String?  // preset key if detected
  totalRows    Int      @default(0)
  createdRows  Int      @default(0)
  updatedRows  Int      @default(0)
  errorRows    Int      @default(0)
  errors       Json?    // array of { row, column, value, reason }, capped at 1000
  startedAt    DateTime @default(now())
  completedAt  DateTime?
  createdAt    DateTime @default(now())

  @@index([userId])
  @@index([status])
  @@index([createdAt])
}
```

## 7. Code Layout

```
apps/api/src/
  routes/
    import.ts                  # Express router, all /api/import/* endpoints
  import/
    parser.ts                  # CSV streaming parse, delimiter detection
    mapping.ts                 # Auto-suggest, fuzzy match, synonym table
    synonyms.ts                # Canonical field → CSV header synonyms
    presets/
      index.ts                 # Preset registry + detection logic
      pipedrive-persons.json
      pipedrive-organizations.json
      pipedrive-deals.json
      hubspot-contacts.json
      hubspot-companies.json
      salesforce-leads.json
    validators/
      company.ts               # Zod schema + transformer
      contact.ts
      deal.ts
    parsers/
      amount.ts                # "$1,234.56" → 1234.56
      date.ts                  # chrono-node wrapper
      phone.ts                 # libphonenumber-js wrapper
      url.ts                   # https:// prefix
    resolvers/
      company.ts               # name/externalId → Company
      contact.ts               # email/externalId → Contact
      stage.ts                 # source stage name → stageId
    storage.ts                 # S3 upload/download for source files
    job-runner.ts              # Orchestrates dry-run + commit

apps/web/src/
  pages/settings/
    Import.tsx                 # Job list + New Import button
    ImportNew.tsx              # 3-step wizard shell
  components/import/
    Step1Upload.tsx
    Step2Mapping.tsx
    Step3Validate.tsx
    StageMappingSubstep.tsx
    ErrorRowList.tsx
  lib/import/
    api.ts                     # Typed client for /api/import/*
```

## 8. Dependencies (npm)

Server:
- `csv-parse` (streaming CSV parse)
- `chrono-node` (forgiving date parser)
- `libphonenumber-js` (phone normalization)
- Already present: `zod`, `@aws-sdk/client-s3`, `@prisma/client`

Client:
- `papaparse` (client-side preview only — server is source of truth)
- Already present: shadcn/ui, react-hook-form, sonner

## 9. Success Metrics

### Leading (measurable within 30 days of launch)
- **Activation:** ≥80% of users who start the import wizard complete a successful import (commit step reached). Measured via ImportJob status counts.
- **Time-to-import:** Median time from upload to commit for ≤1k row files ≤5 minutes.
- **Error rate:** ≤2% of total rows across all imports end up in the error bucket. (Higher means our validators are wrong, not our users.)

### Lagging (90+ days)
- **Self-serve migration:** ≥90% of new users with prior CRM data import successfully without support intervention.
- **Re-import rate:** ≥40% of users run a second import within 30 days of their first (proxy for "the import worked, they trusted it").

### Measurement
- Add an `ImportJob` analytics dashboard at `/admin/imports` (Phase 1.5) showing the above as a Recharts dashboard. SQL queries documented in `apps/api/src/import/metrics.sql` for ad-hoc checks.

## 10. Open Questions

- **[Engineering]** Synchronous commit for v1: at what row count does the request hit Express timeout? Suggested cap: 50k rows synchronous; above that → return 413 and tell user to split. Need to confirm against current Express config. *(Non-blocking — start with 50k cap.)*
- **[Engineering]** S3 source file retention: keep forever, or expire after 90 days? Recommend 90-day lifecycle rule on `imports/` prefix. *(Non-blocking — pick a default, can revisit.)*
- **[Product]** When a stub Company is auto-created during a Contact import, do we surface it differently in the UI (e.g., a "needs review" badge) or treat it as a normal Company? Recommend: normal Company, but flagged in the import job summary. *(Non-blocking.)*
- **[Product]** Should the wizard let users go back and re-upload a different CSV mid-flow without losing their entity-type selection? Recommend yes. *(Non-blocking.)*
- ~~**[Engineering]** Email match for `Deal.primaryContactId` — what if the CSV row has an email but no Contact exists yet?~~ **Resolved 2026-05-03:** auto-create a stub Contact with email populated; count stub creations in the import summary. See P0-6.

## 11. Timeline / Phasing

**Week 1:** P0-1, P0-2 (skeleton wizard, server upload + parse), P0-9 (ImportJob model + migration), P0-10 (endpoint scaffolding). End of week: can upload a CSV and see headers + sample rows in the UI.

**Week 2:** P0-3 (auto-mapping), P0-4 (presets — start with Pipedrive Persons only), P0-5 (validation + dry-run for Company entity). End of week: can dry-run a Pipedrive Persons CSV with full validation.

**Week 3:** P0-6 (relationship resolution), P0-7 (stage mapping), P0-8 (externalId + idempotency). Add Pipedrive Organizations and Deals presets. End of week: can fully migrate a Pipedrive account.

**Week 4:** Hardening — error CSV download, job list page polish, end-to-end testing with real Pipedrive export, HubSpot and Salesforce presets. Ship to prod.

## 12. Testing

- **Unit tests** (vitest, already in deps): every parser (amount, date, phone, url), every validator schema, fuzzy-match algorithm, preset detection.
- **Integration tests** (supertest, already in deps): full upload → dry-run → commit flow per entity type, including idempotency check (commit twice).
- **Fixtures:** check in real Pipedrive, HubSpot, and Salesforce export samples (PII-scrubbed) under `apps/api/test/fixtures/import/`.
- **Acceptance test scenario:** end-to-end Cypress/Playwright (whichever the project uses — confirm during implementation) walking the wizard with the Pipedrive Persons fixture.

## 13. Out-of-Scope Reminders

This spec deliberately excludes Tasks/Notes/Activities, custom fields, xlsx ingestion, background workers, two-way sync, and Pipedrive API. If during implementation any of these feel "easy to add while we're here" — stop. They are explicitly P2. Adding them now will delay v1 and is not what the user asked for.

---

## Appendix A: Pipedrive CSV column reference

For the Pipedrive presets, these are the columns Pipedrive emits in their standard CSV export (as of 2026). Used to populate the preset JSONs.

**Pipedrive Persons:**
`Person - Name`, `Person - First name`, `Person - Last name`, `Person - Email`, `Person - Phone`, `Person - Job title`, `Person - Organization`, `Person - Owner`, `Person - Created`, `Person - Updated`, `Person - ID`

**Pipedrive Organizations:**
`Organization - Name`, `Organization - Address`, `Organization - Owner`, `Organization - Created`, `Organization - ID`

**Pipedrive Deals:**
`Deal - Title`, `Deal - Value`, `Deal - Currency`, `Deal - Stage`, `Deal - Status`, `Deal - Probability`, `Deal - Expected close date`, `Deal - Person`, `Deal - Organization`, `Deal - Owner`, `Deal - Created`, `Deal - Updated`, `Deal - ID`

(Verify exact strings against an actual export during preset implementation — Pipedrive occasionally adjusts these.)
