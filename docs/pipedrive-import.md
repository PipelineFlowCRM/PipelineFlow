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

If you run them out of order, PipelineFlow will auto-create stub records
to preserve relationships (a Contact referencing "Acme Corp" will create
a stub Company), but you'll have empty placeholder rows to clean up. The
spec calls these out in the import summary so they're easy to find.

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
3. Same options. Make sure the *Stage*, *Value*, *Expected close date*,
   *Person*, and *Organization* columns are included — they're the ones
   PipelineFlow needs.
4. Save as `pipedrive-deals.csv`.

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

The v1 importer covers Organizations, Persons, and Deals. The following
Pipedrive surfaces are explicitly out of scope and won't be carried over:

- **Activities, Tasks, Notes, Files** attached to Deals or Contacts —
  these depend on the parent Deal/Contact existing first and the
  cross-references get harder. Coming in a future phase.
- **Custom fields** — see above.
- **Email threads / Smart Docs / Insights reports** — these are
  Pipedrive-specific data with no direct PipelineFlow equivalent.
- **Pipedrive's automation rules** — different system, different model.

If any of those matter for your migration, file an issue on GitHub
(*Settings → ?* in the PipelineFlow header) so we can prioritise the
next slice of importer work.
