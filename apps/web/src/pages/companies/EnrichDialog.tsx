import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Sparkles, Loader2, AlertTriangle, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import type { EnrichmentDiffDto, EnrichmentRunDto } from '@pipelineflow/shared';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { api, ApiError } from '@/lib/api';

interface RunResponse {
  run: EnrichmentRunDto;
  diff: EnrichmentDiffDto | null;
}

interface Props {
  companyId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function formatApiError(e: unknown, fallback = 'Request failed'): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return fallback;
}

export function EnrichDialog({ companyId, open, onOpenChange }: Props) {
  const qc = useQueryClient();
  const [runId, setRunId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [applySummary, setApplySummary] = useState(true);

  // Reset internal state every time the dialog opens — a stale runId from a
  // previous open would otherwise cause the polling query to start firing
  // before the user hits "Run".
  useEffect(() => {
    if (open) {
      setRunId(null);
      setSelected(new Set());
      setApplySummary(true);
    }
  }, [open]);

  const start = useMutation({
    mutationFn: () =>
      api.post<{ runId: string }>(`/enrichment/companies/${companyId}`),
    onSuccess: ({ runId }) => setRunId(runId),
    onError: (e) => toast.error(formatApiError(e, 'Could not start enrichment')),
  });

  const { data: runData } = useQuery<RunResponse>({
    queryKey: ['enrichment', 'run', runId],
    queryFn: () => api.get<RunResponse>(`/enrichment/runs/${runId!}`),
    enabled: Boolean(runId && open),
    // Poll while pending; stop once the row reaches a terminal state.
    refetchInterval: (q) => {
      const s = q.state.data?.run.status;
      if (!s) return 2000;
      return s === 'pending' ? 2000 : false;
    },
  });

  // Seed the selected set from the diff's per-field defaults the first time
  // a diff arrives. Later toggles are user-driven.
  useEffect(() => {
    if (!runData?.diff) return;
    setSelected((prev) => {
      if (prev.size > 0) return prev;
      const next = new Set<string>();
      for (const f of runData.diff!.fields) {
        if (f.selectedByDefault) next.add(f.key);
      }
      return next;
    });
  }, [runData?.diff]);

  const apply = useMutation({
    mutationFn: () =>
      api.post(`/enrichment/runs/${runId!}/apply`, {
        runId,
        fields: Array.from(selected),
        applySummary,
      }),
    onSuccess: () => {
      toast.success('Enrichment applied');
      qc.invalidateQueries({ queryKey: ['company', companyId] });
      onOpenChange(false);
    },
    onError: (e) => toast.error(formatApiError(e, 'Could not apply enrichment')),
  });

  const status = runData?.run.status;
  const diff = runData?.diff;

  const body = useMemo(() => {
    if (!runId) {
      return (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Claude will research this company and propose updates to industry, size,
            address, and a short summary. You&apos;ll review the changes before anything
            is written.
          </p>
        </div>
      );
    }
    if (!status || status === 'pending') {
      return (
        <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Researching… this usually takes 5-30 seconds.</span>
        </div>
      );
    }
    if (status === 'error') {
      return (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 text-destructive" />
          <div>
            <div className="font-medium">Enrichment failed</div>
            <div className="text-muted-foreground">
              {runData?.run.errorMessage ?? 'Unknown error'}
            </div>
          </div>
        </div>
      );
    }
    if (status === 'skipped') {
      return (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <div className="font-medium">Enrichment skipped</div>
          <div className="text-muted-foreground">
            Reason: <code>{runData?.run.reason ?? 'unknown'}</code>
          </div>
        </div>
      );
    }
    if (status === 'proposed' && diff) {
      return (
        <div className="space-y-4">
          {diff.ambiguous ? (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              <div className="font-medium">Multiple companies match</div>
              <div className="mt-1 text-muted-foreground">
                Claude couldn&apos;t pick one. Add the company website to the record and
                try again, or pick a candidate manually:
              </div>
              {diff.candidates && diff.candidates.length > 0 ? (
                <ul className="mt-2 space-y-1">
                  {diff.candidates.map((c, i) => (
                    <li key={i}>
                      <strong>{c.name}</strong>
                      {c.website ? ` — ${c.website}` : ''}
                      {c.reason ? ` (${c.reason})` : ''}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          {diff.fields.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No new field-level information to propose. The summary note (if any)
              will still be appended.
            </p>
          ) : (
            <div className="space-y-2">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                Proposed changes
              </div>
              <ul className="divide-y rounded-md border">
                {diff.fields.map((f) => {
                  const checked = selected.has(f.key);
                  return (
                    <li key={f.key} className="flex items-start gap-3 p-3">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          setSelected((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(f.key);
                            else next.delete(f.key);
                            return next;
                          });
                        }}
                        className="mt-1 h-4 w-4 cursor-pointer accent-primary"
                      />
                      <div className="min-w-0 flex-1 text-sm">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{f.label}</span>
                          {f.confidence ? (
                            <Badge variant="outline" className="text-[10px]">
                              {f.confidence}
                            </Badge>
                          ) : null}
                        </div>
                        <div className="mt-1 grid grid-cols-2 gap-2 text-xs">
                          <div>
                            <div className="text-muted-foreground">Current</div>
                            <div className="break-words">
                              {f.current ?? <span className="text-muted-foreground">—</span>}
                            </div>
                          </div>
                          <div>
                            <div className="text-muted-foreground">Proposed</div>
                            <div className="break-words font-medium">{f.proposed ?? '—'}</div>
                          </div>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {diff.summary ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  Summary note
                </div>
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={applySummary}
                    onChange={(e) => setApplySummary(e.target.checked)}
                    className="h-3.5 w-3.5 cursor-pointer accent-primary"
                  />
                  Append to company
                </label>
              </div>
              <div className="rounded-md border bg-muted/40 p-3 text-sm whitespace-pre-wrap">
                {diff.summary}
              </div>
            </div>
          ) : null}

          {diff.sources.length > 0 ? (
            <div className="space-y-1">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                Sources
              </div>
              <ul className="space-y-1 text-xs">
                {diff.sources.map((s, i) => (
                  <li key={i} className="flex items-start gap-1">
                    <ExternalLink className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noreferrer"
                      className="break-all text-primary hover:underline"
                    >
                      {s.url}
                    </a>
                    {s.fields.length > 0 ? (
                      <span className="text-muted-foreground">
                        — {s.fields.join(', ')}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      );
    }
    return null;
  }, [runId, status, diff, selected, applySummary, runData]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4" /> Enrich with Claude
          </DialogTitle>
          <DialogDescription>
            Research and propose updates to this company record. You&apos;ll review
            field-by-field changes before anything is written.
          </DialogDescription>
        </DialogHeader>
        {body}
        <DialogFooter>
          {!runId ? (
            <Button onClick={() => start.mutate()} disabled={start.isPending}>
              {start.isPending ? 'Starting…' : 'Run enrichment'}
            </Button>
          ) : status === 'proposed' ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => apply.mutate()}
                disabled={
                  apply.isPending ||
                  (selected.size === 0 && !(applySummary && diff?.summary))
                }
              >
                {apply.isPending
                  ? 'Applying…'
                  : selected.size === 0 && diff?.summary && applySummary
                    ? 'Append summary only'
                    : `Apply ${selected.size} field${selected.size === 1 ? '' : 's'}`}
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
