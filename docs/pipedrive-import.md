# Migrating from Pipedrive to PipelineFlow

This guide walks you through exporting your Pipedrive data and importing it
into PipelineFlow. Total time for a typical workspace (a few hundred
records): about 10 minutes.

PipelineFlow auto-detects Pipedrive's export format, so once your CSVs are
saved you don't need to map columns manually — just confirm and commit.

## Before you start

Run the imports in this order so cross-references resolve cleanly:

1. **Organizations** → become PipelineFlow **Companies**
2. **Persons** → become PipelineFlow **Contacts** (linked to the Companies
   you just imported)
3. **Deals** → linked to the Companies and Contacts above
4. **Notes** *(optional)* → attach to the Deals from step 3 via Pipedrive's
   Deal ID. Org-only and contact-only notes are skipped — PipelineFlow's
   Note model only attaches to Deals.

If you run them out of order, PipelineFlow will auto-create stub records
to preserve relationships (a Contact referencing "Acme Corp" will create
a stub Company), but you'll have empty placeholder rows to clean up. The
spec calls these out in the import summary so they're easy to find.

> **Important for Notes:** the Notes import resolves each note's parent
> Deal by Pipedrive Deal ID. That means **the Deals export must include
> the `Deal - ID` column** — Pipedrive doesn't include it by default.
> See the Deal export instructions below for how to enable it.

## Step 1 — Export from Pipedrive

You'll export three CSVs: Organizations, Persons, and Deals.

### Organizations

1. In Pipedrive, open **Contacts → Organizations**.
2. Apply any filters you want to narrow the export (e.g. only active
   organizations). To export everything, leave the default *All
   organizations* filter selected.
3. Click the **`...` overflow menu** next to the filter bar → **Export
   filter results**.
4. In the export modal:
   - **Format:** CSV
   - **Encoding:** UTF-8
   - **Include all columns** (PipelineFlow ignores columns it doesn't use,
     so over-exporting is fine).
5. Click **Export**. Pipedrive emails you a download link when the file is
   ready (usually under a minute for workspaces with under 10 000 rows).
6. Save the file as `pipedrive-organizations.csv`.

### Persons

1. Open **Contacts → People**.
2. Same overflow menu → **Export filter results**.
3. Same options: CSV, UTF-8, all columns.
4. Save as `pipedrive-persons.csv`.

### Deals

1. Open **Deals → list view** (the table view, not the kanban — exports
   only work from the list view).
2. Same overflow menu → **Export filter results**.
3. Open the column picker and **make sure these columns are ticked**:
   *Stage*, *Value*, *Expected close date*, *Person*, *Organization*,
   and **`ID`** (the column picker labels it just `ID`, but it ends up
   in the CSV as `Deal - ID`).
   The `ID` column is **required if you plan to import Notes** — notes
   reference their parent Deal by Pipedrive ID. It's also recommended
   regardless: it's the natural key the importer uses for re-imports,
   so without it any re-export creates duplicates.
4. Save as `pipedrive-deals.csv`.

### Notes (optional, after Deals)

1. Open **Activities/Notes → Notes view**, or use Pipedrive's
   *Insights → All notes* surface depending on plan tier.
2. Same overflow menu → **Export filter results**.
3. Defaults are fine — every standard column ships with the export.
4. Save as `pipedrive-notes.csv`.

Notes that are attached to *Organizations* or *Persons* (without a
parent Deal) won't import — PipelineFlow only supports deal-attached
notes. They're reported in the dry-run summary so you can see how many
were skipped.

### A note on filters

Pipedrive only exports rows that match the **currently active filter**. If
you want to migrate everything, switch to the *All deals* / *All
organizations* / *All people* filter before exporting. To migrate only a
subset (e.g. *Active deals from this year*), apply that filter first.

If you export a partial set now and discover later you need more rows,
you can re-import without duplicating anything — PipelineFlow keys on
Pipedrive's row IDs to update existing records rather than create new
ones. See *Re-importing safely* below.

## Step 2 — Import into PipelineFlow

Open PipelineFlow → **Settings → Data import → New import**.

### Run 1: Companies

1. Pick **Companies** in the entity selector.
2. Drop `pipedrive-organizations.csv` into the upload area (or click
   *Choose file*).
3. PipelineFlow detects the Pipedrive Organizations preset and pre-fills
   every column mapping. You'll see a banner: *Detected: Pipedrive
   Organizations export*.
4. Click **Continue** → **Run dry-run**.
5. Review the summary (will create / update / error counts). If anything
   errored, expand the error list to see which row and column caused it
   — usually a typo in a website URL or a malformed phone number.
6. Click **Commit import**.

If a row errored, click *Download error rows* to get a CSV of just the
failed rows with an `_error_reason` column appended. Fix them in your
spreadsheet editor and re-upload — PipelineFlow will skip rows that
already imported successfully.

### Run 2: Contacts

1. Start a new import → **Contacts**.
2. Upload `pipedrive-persons.csv`.
3. The Pipedrive Persons preset is detected and applied automatically.
   The `Person - Organization` column is mapped to *Company name* —
   PipelineFlow will look up each name against the Companies you
   imported in Run 1 and link them.
4. Continue → dry-run → commit.

If any Contact references an Organization name you didn't import (e.g. a
person who joined a company between exports), PipelineFlow auto-creates a
stub Company with just the name set. The summary screen tells you how
many stubs were created so you can review them at **Companies** and
merge / fill in details as needed.

### Run 3: Deals

1. Start a new import → **Deals**.
2. Upload `pipedrive-deals.csv`.
3. The Pipedrive Deals preset is detected.
4. After mapping, PipelineFlow shows a **Stage mapping** sub-step on the
   Validate screen — Pipedrive's stage names ("Lead In", "Qualified",
   "Proposal Made") won't match PipelineFlow's stages until you tell it
   how. For each Pipedrive stage, pick the closest PipelineFlow stage
   from the dropdown.
5. Click *Run dry-run again* once every stage is mapped.
6. Commit.

Deals link to the Company *and* the primary Contact via the
`Deal - Organization` and `Deal - Person` columns. If a Deal's primary
contact email isn't in PipelineFlow yet, a stub Contact is created with
just the email set. (Same pattern as stub Companies — the import summary
counts them so they're easy to find.)

> **First-time bridge for existing Deals.** If you imported Deals
> previously *without* the `Deal - ID` column and are now re-importing
> with it, the Deal CSV's `External ID` rows can't match by `externalId`
> (your existing PF Deals don't have one yet). The importer falls back
> to a case-insensitive **Deal title** match: an existing PF Deal with
> the same title gets stamped with its Pipedrive ID and updated.
> Ambiguous titles (two existing Deals share the same name) are
> reported as row-level errors — fix by deleting the duplicate or
> editing the CSV before re-running.

### Run 4: Notes (optional)

1. Start a new import → **Notes**.
2. Upload `pipedrive-notes.csv`.
3. The Pipedrive Notes preset is detected. The mapping pre-fills:
   `Content` → *Content*, `Deal ID` → *Deal external ID*,
   `Deal title` → *Deal title*, `Add time` → *Created at*,
   `User` → *Author name*, plus your Pipedrive note ID → *External ID*.
   Pin flags, lead/project columns, and org/person attachments are all
   set to *Ignore*.
4. Dry-run. The summary tells you how many notes will create vs. skip.

#### What gets imported

- Notes whose `Deal ID` matches an existing PipelineFlow Deal (via the
  Pipedrive `externalId` you stamped in Run 3).
- Each note's original Pipedrive `Add time` becomes the PF note's
  `createdAt`, so timeline ordering survives the migration.
- The Pipedrive author name (e.g. *"Bob Misita"*) is preserved as a
  small attribution line at the top of the note content
  (`*[Imported from Pipedrive: Bob Misita]*\n\n<original note>`).
  PipelineFlow's `Note.author` field stays empty — Pipedrive doesn't
  emit user emails so we can't reliably resolve author identity.

#### What gets skipped

- Notes attached to an **Organization or Person without a Deal** — PF's
  Note model only supports deal-attached notes. Reported as row-level
  errors in the dry-run.
- Notes attached to **Leads** or **Projects** — PF doesn't model those.
  The columns are present but mapped to *Ignore* in the preset.

#### Re-importing notes

Notes carry their Pipedrive note ID as `externalId`, so re-importing
the same export updates the existing PF rows in place rather than
creating duplicates. Editing a note in Pipedrive and re-exporting will
update the content in PF; the original `createdAt` is preserved (we
don't churn it — Pipedrive's `Add time` doesn't change between exports
anyway).

> **Manual edits in PipelineFlow are overwritten on re-import.** If you
> rephrase a note's content directly in PipelineFlow — for example to
> strip the auto-prefixed `*[Imported from Pipedrive: …]*` line — a
> later re-import of the same Pipedrive CSV will reset the content
> back to what's in the CSV. Notes are the most freeform of the
> imported entities and the most likely to get manual editing, so this
> is worth knowing. If you're done re-importing and want to clean up
> author prefixes, do that as a final pass.

## Re-importing safely

Every imported record gets stamped with Pipedrive's row ID
(`externalSource = "pipedrive"`, `externalId = <pipedrive-id>`). On a
re-import:

- Rows whose `(externalSource, externalId)` already exists are
  **updated**, not duplicated.
- Blank cells in the new CSV **don't overwrite** existing values —
  Pipedrive's nulls are treated as "no opinion", so manually-entered
  PipelineFlow data is preserved.
- Net effect: you can re-export from Pipedrive and re-import as many
  times as you want without creating duplicates. Useful if you're doing
  a staged migration and Pipedrive is still your live system.

## Common issues

**"File too large".** Cap is 10 MB / 50 000 rows per file. For a workspace
larger than that, split the export by year or by region — Pipedrive's
filter bar makes this straightforward — and import each chunk as a
separate run.

**Phone numbers look weird in PipelineFlow.** The importer normalizes
phones to E.164 international form (`+1 415 555 1234`) when it can parse
them. Pipedrive's bare 10-digit US numbers are assumed to be US-based; if
your contacts are in other regions and you want a different default,
edit the cells before import or accept the as-is fallback (unparseable
values are kept verbatim).

**A Pipedrive custom field didn't import.** Custom fields aren't
supported in the v1 importer (PipelineFlow's own custom fields support is
recent and the import schema is still narrow). Map the column to *Notes*
as a workaround, or wait for the custom-fields-on-import follow-up.

**Stage names don't quite match.** That's expected — every CRM names
stages differently. Use the stage-mapping sub-step on the Deals import to
pair each Pipedrive stage to the closest PipelineFlow stage. The mapping
is saved against the import job, so you don't redo it if you re-import.

## What doesn't migrate

The importer covers Organizations, Persons, Deals, and Notes (deal
notes only). The following Pipedrive surfaces are explicitly out of
scope and won't be carried over:

- **Activities** (calls, meetings, emails, tasks) — deliberately
  skipped. Pipedrive activity logs are noisy and bulky: every inbound
  and outbound email gets echoed as an activity row, and a workspace
  with active email sync can easily produce tens of thousands of these.
  Importing them clutters the PipelineFlow timeline with stale,
  low-signal entries that drown out the deal updates that actually
  matter. If we revisit this later, it'll be with filters
  (date-range, type, has-content) rather than a bulk dump.
- **Tasks** standalone (not attached to a Deal) — Pipedrive's task
  surface and PipelineFlow's are similar enough to map, but task
  records are activity-shaped and inherit the same noise problem.
- **Files / Attachments** — would need to download every file from
  Pipedrive's storage and re-upload to S3. Out of scope until the
  importer grows a binary-fetch path. The activity log entries that
  reference attachments don't carry the file bytes, just metadata, so
  there's nothing useful to import without the binaries.
- **Org-level / Person-level notes** — Pipedrive supports notes
  attached to an Organization or a Person without a Deal.
  PipelineFlow's Note model only attaches to Deals, so these are
  reported as row-level errors and skipped during the Notes import.
- **Custom fields** — see above.
- **Email threads / Smart Docs / Insights reports** — these are
  Pipedrive-specific data with no direct PipelineFlow equivalent.
- **Pipedrive's automation rules** — different system, different model.

If any of those matter for your migration, file an issue on GitHub
(*Settings → ?* in the PipelineFlow header) so we can prioritise the
next slice of importer work.
