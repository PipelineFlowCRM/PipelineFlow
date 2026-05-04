import { CheckCircle2, Download, Loader2, RefreshCcw, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ErrorRowList } from './ErrorRowList';
import { StageMappingSubstep } from './StageMappingSubstep';
import { importApi, type EntityType, type RunResponse } from '@/lib/import/api';
import { cn } from '@/lib/utils';

interface Props {
  jobId: string;
  entityType: EntityType;
  dryRun: RunResponse | null;
  commitResult: RunResponse | null;
  isDryRunning: boolean;
  isCommitting: boolean;
  // Set when stageMapping needs to be filled. Wizard renders the
  // sub-step here rather than as a separate route to keep the back/next
  // contract simple — every step is on the same page.
  stageMapping: Record<string, number>;
  onChangeStageMapping: (next: Record<string, number>) => void;
  onDryRun: () => void;
  onCommit: () => void;
}

function StatLabel({
  value,
  label,
  tone,
}: {
  value: number;
  label: string;
  tone: 'create' | 'update' | 'error' | 'neutral';
}) {
  return (
    <div
      className={cn(
        'rounded-md border border-border/70 px-3 py-2 text-center',
        tone === 'create' && 'border-emerald-500/30 bg-emerald-500/5',
        tone === 'update' && 'border-sky-500/30 bg-sky-500/5',
        tone === 'error' && value > 0 && 'border-rose-500/30 bg-rose-500/5',
      )}
    >
      <div
        className={cn(
          'text-xl font-semibold tabular-nums',
          tone === 'create' && 'text-emerald-300',
          tone === 'update' && 'text-sky-300',
          tone === 'error' && value > 0 && 'text-rose-300',
        )}
      >
        {value}
      </div>
      <div className="mt-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
    </div>
  );
}

export function Step3Validate({
  jobId,
  entityType,
  dryRun,
  commitResult,
  isDryRunning,
  isCommitting,
  stageMapping,
  onChangeStageMapping,
  onDryRun,
  onCommit,
}: Props) {
  const hasResult = !!dryRun;
  const summary = commitResult?.summary ?? dryRun?.summary;
  const errors = commitResult?.errors ?? dryRun?.errors ?? [];
  const distinctStages = dryRun?.summary.distinctStages ?? [];
  const unmappedStages = dryRun?.summary.unmappedStages ?? [];
  const stagesNeedMapping = entityType === 'deal' && unmappedStages.length > 0;
  const canCommit =
    hasResult &&
    !commitResult &&
    !isCommitting &&
    !isDryRunning &&
    !stagesNeedMapping;

  return (
    <div className="space-y-5">
      {!hasResult ? (
        <div className="rounded-md border border-dashed border-border/70 p-6 text-center">
          <Sparkles className="mx-auto mb-2 h-5 w-5 text-muted-foreground" />
          <div className="text-sm font-medium">Run a dry-run to see the result</div>
          <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
            We'll validate every row, predict create vs. update, and surface
            errors — without writing anything yet.
          </p>
          <Button onClick={onDryRun} disabled={isDryRunning} className="mt-4">
            {isDryRunning ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCcw className="mr-2 h-4 w-4" />
            )}
            Run dry-run
          </Button>
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            <StatLabel value={summary?.totalRows ?? 0} label="Total rows" tone="neutral" />
            <StatLabel value={summary?.willCreate ?? 0} label="Will create" tone="create" />
            <StatLabel value={summary?.willUpdate ?? 0} label="Will update" tone="update" />
            <StatLabel value={summary?.willError ?? 0} label="Will error" tone="error" />
          </div>

          {(summary?.stubCompaniesCreated ?? 0) > 0 ||
          (summary?.stubContactsCreated ?? 0) > 0 ? (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
              <div className="font-medium text-amber-200">
                Auto-created relationship stubs
              </div>
              <p className="mt-1 text-muted-foreground">
                Cross-entity references generated{' '}
                {summary?.stubCompaniesCreated ?? 0} stub Compan
                {(summary?.stubCompaniesCreated ?? 0) === 1 ? 'y' : 'ies'} and{' '}
                {summary?.stubContactsCreated ?? 0} stub Contact
                {(summary?.stubContactsCreated ?? 0) === 1 ? '' : 's'}. Review
                them on the Companies / Contacts list pages — they have only
                names or emails populated.
              </p>
            </div>
          ) : null}

          {entityType === 'deal' && distinctStages.length > 0 ? (
            <section className="space-y-2">
              <div className="flex items-baseline justify-between">
                <h3 className="text-sm font-semibold">Stage mapping</h3>
                {stagesNeedMapping ? (
                  <span className="text-xs text-amber-300">
                    {unmappedStages.length} unmapped
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-xs text-emerald-300">
                    <CheckCircle2 className="h-3 w-3" /> All stages mapped
                  </span>
                )}
              </div>
              <StageMappingSubstep
                distinctStages={distinctStages}
                stageMapping={stageMapping}
                onChange={onChangeStageMapping}
              />
            </section>
          ) : null}

          <ErrorRowList errors={errors} />

          {commitResult ? (
            <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-4">
              <div className="inline-flex items-center gap-2 text-sm font-semibold text-emerald-200">
                <CheckCircle2 className="h-4 w-4" />
                Import committed
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {commitResult.summary.willCreate} new ·{' '}
                {commitResult.summary.willUpdate} updated ·{' '}
                {commitResult.summary.willError} errored.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {commitResult.summary.willError > 0 ? (
                  <Button asChild size="sm" variant="secondary">
                    <a href={importApi.errorsCsvUrl(jobId)}>
                      <Download className="mr-1 h-3.5 w-3.5" />
                      Download error rows
                    </a>
                  </Button>
                ) : null}
                {entityType === 'company' ? (
                  <Button asChild size="sm" variant="outline">
                    <a href="/companies">View companies</a>
                  </Button>
                ) : entityType === 'contact' ? (
                  <Button asChild size="sm" variant="outline">
                    <a href="/contacts">View contacts</a>
                  </Button>
                ) : (
                  // Both deal and note imports surface their results
                  // through the pipeline view — notes are deal-attached,
                  // so opening the pipeline lets the user click into
                  // any deal to see the imported notes.
                  <Button asChild size="sm" variant="outline">
                    <a href="/pipeline">View pipeline</a>
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={onDryRun}
                disabled={isDryRunning || isCommitting}
              >
                {isDryRunning ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCcw className="mr-2 h-4 w-4" />
                )}
                Run dry-run again
              </Button>
              <Button
                onClick={onCommit}
                disabled={!canCommit}
                title={
                  stagesNeedMapping
                    ? 'Map every stage before committing'
                    : undefined
                }
              >
                {isCommitting ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                Commit import
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
