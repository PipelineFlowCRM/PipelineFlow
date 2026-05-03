import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card';
import { Step1Upload } from '@/components/import/Step1Upload';
import { Step2Mapping } from '@/components/import/Step2Mapping';
import { Step3Validate } from '@/components/import/Step3Validate';
import {
  importApi, type EntityType, type RunResponse, type UploadResponse,
} from '@/lib/import/api';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

type Step = 1 | 2 | 3;

const STEPS: { n: Step; label: string }[] = [
  { n: 1, label: 'Upload' },
  { n: 2, label: 'Map columns' },
  { n: 3, label: 'Validate & commit' },
];

interface State {
  entityType: EntityType;
  upload: UploadResponse;
  mapping: Record<string, string | null>;
  stageMapping: Record<string, number>;
  externalSource?: string;
}

const REQUIRED_FIELDS: Record<EntityType, string[]> = {
  company: ['name'],
  contact: ['firstName'],
  deal: ['title', 'stageName'],
};

export function ImportNew() {
  // ─── All hooks must be declared unconditionally before any return.
  // Earlier versions hid mutation hooks behind early returns for the
  // resume loading/error states, which violated the Rules of Hooks
  // (the hook count changed between renders once data arrived). We now
  // declare every hook up front and gate the rendered tree at the bottom.
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [searchParams] = useSearchParams();
  const resumeId = searchParams.get('resume');
  const [step, setStep] = useState<Step>(1);
  const [state, setState] = useState<State | null>(null);
  const [dryRun, setDryRun] = useState<RunResponse | null>(null);
  const [commitResult, setCommitResult] = useState<RunResponse | null>(null);

  // Resume flow: hydrate state from a previously uploaded job. The
  // server returns a `resume` payload that includes the parsed CSV
  // headers + sample rows so we can rehydrate Step 2 / Step 3 without
  // re-uploading the file. If `resume` is null (source CSV gone), we
  // bounce the user back to the list with an error.
  const resumeQuery = useQuery({
    queryKey: ['import-job', resumeId],
    queryFn: () => importApi.getJob(resumeId!),
    enabled: !!resumeId && state == null,
    staleTime: 0,
    retry: false,
  });
  useEffect(() => {
    if (!resumeId || state != null) return;
    const data = resumeQuery.data;
    if (!data) return;
    if (!data.resume) {
      toast.error("This import's source file is no longer available — start a new import.");
      navigate('/settings/import', { replace: true });
      return;
    }
    const detectedPreset = data.resume.detectedPreset?.preset
      ? {
          key: data.resume.detectedPreset.preset.key,
          sourceLabel: data.resume.detectedPreset.preset.sourceLabel,
          entityType: data.resume.detectedPreset.preset.entityType,
          score: data.resume.detectedPreset.score,
          externalSource: data.resume.detectedPreset.preset.externalSource,
        }
      : null;
    setState({
      entityType: data.job.entityType,
      upload: {
        jobId: data.job.id,
        headers: data.resume.headers,
        sampleRows: data.resume.sampleRows,
        totalRows: data.resume.totalRows,
        detectedPreset,
        suggestedMapping: data.resume.mapping,
        canonicalFields: data.resume.canonicalFields,
      },
      mapping: data.resume.mapping,
      stageMapping: data.resume.stageMapping,
      externalSource: detectedPreset?.externalSource,
    });
    // If the prior dry-run is still on the job row, rehydrate the
    // Step 3 summary so the user lands on a populated screen rather
    // than the "Run a dry-run to see the result" empty state.
    if (data.resume.priorRun) {
      setDryRun(data.resume.priorRun);
    }
    // `validated` jobs jump straight to Step 3 — the user already saw
    // the dry-run summary last time. `pending` jobs land on Step 2 so
    // the user can re-confirm the mapping before validating.
    setStep(data.job.status === 'validated' ? 3 : 2);
  }, [resumeId, resumeQuery.data, state, navigate]);

  const dryRunMut = useMutation({
    mutationFn: () => {
      if (!state) throw new Error('No state');
      return importApi.dryRun(state.upload.jobId, {
        entityType: state.entityType,
        mapping: state.mapping,
        stageMapping:
          Object.keys(state.stageMapping).length > 0 ? state.stageMapping : undefined,
        externalSource: state.externalSource,
      });
    },
    onSuccess: (res) => setDryRun(res),
    onError: (err) => toast.error((err as Error).message),
  });

  const commitMut = useMutation({
    mutationFn: () => {
      if (!state) throw new Error('No state');
      return importApi.commit(state.upload.jobId, {
        entityType: state.entityType,
        mapping: state.mapping,
        stageMapping:
          Object.keys(state.stageMapping).length > 0 ? state.stageMapping : undefined,
        externalSource: state.externalSource,
      });
    },
    onSuccess: (res) => {
      setCommitResult(res);
      void qc.invalidateQueries({ queryKey: ['import-jobs'] });
      // Invalidate downstream lists so the imported rows show up immediately.
      void qc.invalidateQueries({ queryKey: ['companies'] });
      void qc.invalidateQueries({ queryKey: ['contacts'] });
      void qc.invalidateQueries({ queryKey: ['deals'] });
      void qc.invalidateQueries({ queryKey: ['pipeline'] });
      toast.success(
        `Imported ${res.summary.willCreate} new and ${res.summary.willUpdate} updated.`,
      );
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const requiredMissing = useMemo(() => {
    if (!state) return [];
    // Keep this in sync with REQUIRED_FIELDS in Step2Mapping. Contact
    // intentionally drops `lastName` so a Pipedrive-style combined
    // "Person - Name" column can be mapped to firstName alone — the
    // server-side validator splits multi-token names automatically.
    const have = new Set(Object.values(state.mapping).filter(Boolean) as string[]);
    return REQUIRED_FIELDS[state.entityType].filter((f) => !have.has(f));
  }, [state]);

  const handleUploaded = (
    entityType: EntityType,
    upload: UploadResponse,
  ) => {
    setState({
      entityType,
      upload,
      mapping: upload.suggestedMapping,
      stageMapping: {},
      externalSource: upload.detectedPreset?.externalSource,
    });
    setDryRun(null);
    setCommitResult(null);
    setStep(2);
  };

  const canAdvanceFromMapping = state != null && requiredMissing.length === 0;

  // ─── Render branches. All hooks above run unconditionally on every
  // render, so React's hook-order invariant holds across loading,
  // error, and ready states.
  if (resumeId && resumeQuery.isLoading && state == null) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading import…
        </CardContent>
      </Card>
    );
  }
  if (resumeId && resumeQuery.isError) {
    return (
      <Card>
        <CardContent className="space-y-3 py-12 text-center">
          <p className="text-sm text-muted-foreground">
            Could not load this import job — it may have been deleted.
          </p>
          <Button asChild size="sm" variant="secondary">
            <Link to="/settings/import">Back to imports</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>New import</CardTitle>
          <CardDescription>
            Three steps: upload your CSV, confirm the column mapping, dry-run
            and commit. You can go back at any point — your work is preserved.
          </CardDescription>
        </div>
        <Button asChild variant="ghost" size="sm">
          <Link to="/settings/import">
            <ArrowLeft className="mr-1 h-4 w-4" />
            Back to imports
          </Link>
        </Button>
      </CardHeader>
      <CardContent className="space-y-6">
        <ol className="flex items-center gap-2 text-xs">
          {STEPS.map(({ n, label }, i) => (
            <li key={n} className="flex items-center gap-2">
              <span
                className={cn(
                  'flex h-6 w-6 items-center justify-center rounded-full font-semibold',
                  step === n
                    ? 'bg-primary text-primary-foreground'
                    : step > n
                      ? 'bg-emerald-500/20 text-emerald-300'
                      : 'bg-muted text-muted-foreground',
                )}
              >
                {n}
              </span>
              <span
                className={cn(
                  'font-medium',
                  step === n ? 'text-foreground' : 'text-muted-foreground',
                )}
              >
                {label}
              </span>
              {i < STEPS.length - 1 ? (
                <span className="ml-1 inline-block h-px w-6 bg-border/70" />
              ) : null}
            </li>
          ))}
        </ol>

        {step === 1 ? <Step1Upload onUploaded={handleUploaded} /> : null}

        {step === 2 && state ? (
          <Step2Mapping
            upload={state.upload}
            entityType={state.entityType}
            mapping={state.mapping}
            onChangeMapping={(m) => setState({ ...state, mapping: m })}
          />
        ) : null}

        {step === 3 && state ? (
          <Step3Validate
            jobId={state.upload.jobId}
            entityType={state.entityType}
            dryRun={dryRun}
            commitResult={commitResult}
            isDryRunning={dryRunMut.isPending}
            isCommitting={commitMut.isPending}
            stageMapping={state.stageMapping}
            onChangeStageMapping={(m) => {
              setState({ ...state, stageMapping: m });
              // Re-running the dry-run picks up the new mapping; the user
              // also sees stale `unmappedStages` state until they do.
            }}
            onDryRun={() => dryRunMut.mutate()}
            onCommit={() => commitMut.mutate()}
          />
        ) : null}

        <div className="flex items-center justify-between border-t border-border/70 pt-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              if (step === 1) navigate('/settings/import');
              else if (step === 2) setStep(1);
              else if (step === 3) setStep(2);
            }}
            disabled={commitMut.isPending}
          >
            <ArrowLeft className="mr-1 h-4 w-4" />
            {step === 1 ? 'Cancel' : 'Back'}
          </Button>
          {step === 2 ? (
            <Button
              size="sm"
              disabled={!canAdvanceFromMapping}
              onClick={() => setStep(3)}
            >
              Continue
              <ArrowRight className="ml-1 h-4 w-4" />
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
