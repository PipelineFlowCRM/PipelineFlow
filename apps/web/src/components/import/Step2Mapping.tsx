import { useMemo, useState } from 'react';
import { CheckCircle2, Sparkles, X } from 'lucide-react';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import type { EntityType, UploadResponse } from '@/lib/import/api';
import { fieldLabel } from '@/lib/import/fieldLabels';

interface Props {
  upload: UploadResponse;
  entityType: EntityType;
  mapping: Record<string, string | null>;
  onChangeMapping: (next: Record<string, string | null>) => void;
}

const IGNORE = '__ignore__';

// Required canonical fields for each entity type. Mirrors the validators
// — used here to flag a missing required mapping in red so the user can't
// click "Continue" and find out 5 seconds later their `name` column is
// unmapped.
//
// `lastName` is intentionally NOT required for Contact: when only
// `firstName` is mapped (e.g. Pipedrive's modern "Person - Name"
// combined column), the validator splits "Mary Watson" → first="Mary",
// last="Watson". A row whose single-token name can't be split surfaces
// as a row-level error in Step 3 instead of a hard block here.
const REQUIRED_FIELDS: Record<EntityType, string[]> = {
  company: ['name'],
  contact: ['firstName'],
  deal: ['title', 'stageName'],
};

export function Step2Mapping({ upload, entityType, mapping, onChangeMapping }: Props) {
  const requiredMissing = useMemo(() => {
    const have = new Set(Object.values(mapping).filter(Boolean) as string[]);
    return REQUIRED_FIELDS[entityType].filter((f) => !have.has(f));
  }, [mapping, entityType]);

  // Surface a duplicates risk for Deal imports without an External ID
  // mapping. Without it, every re-import creates fresh Deal rows because
  // there is no natural key to upsert against (unlike Company.name and
  // Contact.email). We only warn here — the import still works.
  //
  // Two distinct sub-cases that need different advice:
  //   - hasIdLikeColumn: the CSV has *some* column with "id" in its name
  //     that the user could map. Suggest mapping it.
  //   - !hasIdLikeColumn: the CSV genuinely lacks an ID column. Telling
  //     them to "map a column" is unhelpful — the column doesn't exist.
  //     For Pipedrive, point them at the Pipedrive-side fix.
  const externalIdMapped = Object.values(mapping).includes('externalId');
  const hasIdLikeColumn = useMemo(
    () =>
      upload.headers.some((h) =>
        // crude heuristic: a header containing "id" as a word fragment
        // ("Deal - ID", "Record ID", "External Id", "id"). Filter out
        // accidental matches like "Sidekick" by requiring word boundary
        // or explicit ID/Id casing.
        /(^|[\s\-_(])id($|[\s\-_)])/i.test(h) || /\bID\b/.test(h),
      ),
    [upload.headers],
  );
  const presetKey = upload.detectedPreset?.key ?? null;
  const isPipedrive = presetKey?.startsWith('pipedrive') ?? false;
  const noExternalIdRisk = entityType === 'deal' && !externalIdMapped;
  const [externalIdWarningDismissed, setExternalIdWarningDismissed] = useState(false);

  const setOne = (header: string, value: string | null) => {
    onChangeMapping({ ...mapping, [header]: value });
  };

  return (
    <div className="space-y-4">
      {upload.detectedPreset ? (
        <div className="flex items-start gap-3 rounded-md border border-primary/30 bg-primary/5 p-3 text-sm">
          <Sparkles className="mt-0.5 h-4 w-4 text-primary" />
          <div>
            <div className="font-medium">
              Detected: {upload.detectedPreset.sourceLabel}
            </div>
            <div className="text-xs text-muted-foreground">
              Mapping pre-filled — review and adjust as needed. We've also stamped
              every row with{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
                externalSource = "{upload.detectedPreset.externalSource}"
              </code>{' '}
              so re-imports of this CSV update existing rows.
            </div>
          </div>
        </div>
      ) : null}

      {requiredMissing.length > 0 ? (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-200">
          Required field
          {requiredMissing.length > 1 ? 's' : ''} not yet mapped:{' '}
          <strong>
            {requiredMissing.map((f) => fieldLabel(f, entityType)).join(', ')}
          </strong>
        </div>
      ) : null}

      {noExternalIdRisk && !externalIdWarningDismissed ? (
        <div className="relative rounded-md border border-amber-500/30 bg-amber-500/5 p-3 pr-8 text-xs text-amber-200">
          <button
            type="button"
            onClick={() => setExternalIdWarningDismissed(true)}
            className="absolute right-2 top-2 rounded p-0.5 text-amber-200/60 hover:text-amber-100"
            aria-label="Dismiss warning"
            title="Dismiss"
          >
            <X className="h-3.5 w-3.5" />
          </button>
          {hasIdLikeColumn ? (
            <>
              <strong>No External ID column mapped.</strong> Re-importing this
              CSV later will create duplicate Deals because there's no natural
              key (deal title alone isn't unique). Map a column to{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
                External ID
              </code>{' '}
              if you plan to re-import.
            </>
          ) : isPipedrive ? (
            <>
              <strong>This CSV has no Deal&nbsp;ID column.</strong> Re-importing
              later will create duplicates instead of updating. To fix, re-export
              from Pipedrive with the{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
                Deal - ID
              </code>{' '}
              column enabled — in Pipedrive, click <em>Export filter results</em>{' '}
              → expand the column picker and tick <em>ID</em>. If this is a
              one-shot migration, you can dismiss this warning and continue.
            </>
          ) : (
            <>
              <strong>This CSV has no External&nbsp;ID column.</strong>{' '}
              Re-importing later will create duplicates instead of updating.
              Either re-export with a unique-id column included, or dismiss this
              warning if this is a one-shot import.
            </>
          )}
        </div>
      ) : null}

      <div className="overflow-hidden rounded-md border border-border/70">
        <div className="grid grid-cols-[1fr_220px] gap-0 bg-muted/40 px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <div>CSV column</div>
          <div>PipelineFlow field</div>
        </div>
        {upload.headers.map((header) => {
          const samples = upload.sampleRows
            .map((r) => r[header])
            .filter((v): v is string => !!v && v.trim() !== '')
            .slice(0, 3);
          const value = mapping[header] ?? null;
          const isUnmapped = value == null;
          return (
            <div
              key={header}
              className="grid grid-cols-[1fr_220px] items-start gap-3 border-t border-border/70 px-3 py-2"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium" title={header}>
                  {header}
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {samples.length > 0 ? (
                    <span className="space-x-2">
                      {samples.map((s, i) => (
                        <span
                          key={i}
                          className="inline-block max-w-[200px] truncate rounded bg-muted/60 px-1.5 py-0.5 align-top font-mono text-[11px] text-foreground/90"
                          title={s}
                        >
                          {s}
                        </span>
                      ))}
                    </span>
                  ) : (
                    <span className="italic">no sample values</span>
                  )}
                </div>
              </div>
              <div>
                <Select
                  value={value ?? IGNORE}
                  onValueChange={(v) => setOne(header, v === IGNORE ? null : v)}
                >
                  <SelectTrigger className={isUnmapped ? 'text-muted-foreground' : ''}>
                    <SelectValue placeholder="Ignore" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={IGNORE}>
                      <span className="text-muted-foreground">Ignore</span>
                    </SelectItem>
                    {upload.canonicalFields.map((f) => (
                      <SelectItem key={f} value={f}>
                        <span className="inline-flex items-center gap-1.5">
                          {fieldLabel(f, entityType)}
                          {mapping[header] === f ? (
                            <CheckCircle2 className="h-3 w-3 text-primary" />
                          ) : null}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
