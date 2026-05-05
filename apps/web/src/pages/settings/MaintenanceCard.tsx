import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Database, Hammer, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ConfirmDialog';

type ForceReconcileResponse = { ok: true; jobId: string };
type ScheduledBackupStatus = { lastSuccessAt: string | null };
type RunBackupResponse = { ok: true; jobId: string };

export function MaintenanceCard() {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [backupConfirmOpen, setBackupConfirmOpen] = useState(false);
  const queryClient = useQueryClient();

  const forceReconcile = useMutation({
    mutationFn: () => api.post<ForceReconcileResponse>('/admin/s3-reconcile/force'),
    onSuccess: (data) => {
      setConfirmOpen(false);
      toast.success(`Full S3 reconcile queued (job ${data.jobId})`);
    },
    onError: (e) =>
      toast.error((e as Error).message || 'Could not queue reconcile job'),
  });

  // Polled at a long interval — the backup job runs at most once a day, so
  // 60s gives "feels live" feedback after a manual trigger without busy
  // work in steady state.
  const backupStatus = useQuery({
    queryKey: ['admin', 'scheduled-backup'],
    queryFn: () => api.get<ScheduledBackupStatus>('/admin/scheduled-backup'),
    refetchInterval: 60_000,
  });

  const runBackup = useMutation({
    mutationFn: () => api.post<RunBackupResponse>('/admin/scheduled-backup/run'),
    onSuccess: (data) => {
      setBackupConfirmOpen(false);
      toast.success(`Backup queued (job ${data.jobId})`);
      // Don't refetch immediately — the job hasn't run yet. Schedule a
      // refetch in 30s by which time a fast dump will have finished and
      // updated the freshness key. The 60s polling cadence picks up
      // anything slower.
      setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: ['admin', 'scheduled-backup'] });
      }, 30_000);
    },
    onError: (e) =>
      toast.error((e as Error).message || 'Could not queue backup job'),
  });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Hammer className="h-4 w-4" />
            S3 reconcile
          </CardTitle>
          <CardDescription>
            A daily background job already removes orphaned bucket objects
            using an incremental scan. Run a full sweep when you've restored
            the database from a snapshot or suspect drift the incremental
            scan can't catch on its own.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="text-sm text-muted-foreground">
            Resets the incremental high-water mark and lists every key under
            <code className="mx-1 rounded bg-muted px-1 py-0.5 text-xs">attachment/</code>,
            <code className="mx-1 rounded bg-muted px-1 py-0.5 text-xs">avatar/</code>,
            and <code className="mx-1 rounded bg-muted px-1 py-0.5 text-xs">logo/</code>.
            Progress is visible in <a className="underline" href="/admin/queues" target="_blank" rel="noreferrer">/admin/queues</a>.
          </div>
          <Button
            variant="outline"
            disabled={forceReconcile.isPending}
            onClick={() => setConfirmOpen(true)}
          >
            {forceReconcile.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Queueing…
              </>
            ) : (
              <>
                <Hammer className="h-4 w-4" /> Run full S3 reconcile
              </>
            )}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Database className="h-4 w-4" />
            Database backups
          </CardTitle>
          <CardDescription>
            A daily background job runs <code className="mx-1 rounded bg-muted px-1 py-0.5 text-xs">pg_dump</code>,
            writes a gzipped snapshot to the local backups volume, and uploads
            it to S3 under the <code className="mx-1 rounded bg-muted px-1 py-0.5 text-xs">backups/</code> prefix.
            See <a className="underline" href="https://github.com/PipelineFlowCRM/PipelineFlow/blob/main/docs/backups.md" target="_blank" rel="noreferrer">docs/backups.md</a> for restore steps.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="text-sm text-muted-foreground">
            Last successful backup:{' '}
            <span className="font-medium text-foreground">
              {backupStatus.isPending
                ? 'checking…'
                : backupStatus.isError
                  ? 'unavailable'
                  : backupStatus.data?.lastSuccessAt
                    ? new Date(backupStatus.data.lastSuccessAt).toLocaleString()
                    : 'never'}
            </span>
            {/* Distinguish "we couldn't reach the API" from "no run has succeeded".
                The bare 'never' state otherwise misleads ops during an incident
                where the api itself is the thing that's broken. */}
            {backupStatus.isError && (
              <span className="ml-2 text-xs">
                (couldn't load status — retrying)
              </span>
            )}
          </div>
          <Button
            variant="outline"
            disabled={runBackup.isPending}
            onClick={() => setBackupConfirmOpen(true)}
          >
            {runBackup.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Queueing…
              </>
            ) : (
              <>
                <Database className="h-4 w-4" /> Run backup now
              </>
            )}
          </Button>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Run full S3 reconcile?"
        description="The next reconcile run will scan every key in the bucket instead of the daily incremental window. Safe but can take a while on large buckets."
        confirmLabel="Run sweep"
        destructive={false}
        busy={forceReconcile.isPending}
        onConfirm={() => forceReconcile.mutate()}
      />

      <ConfirmDialog
        open={backupConfirmOpen}
        onOpenChange={setBackupConfirmOpen}
        title="Run database backup now?"
        description="Takes a fresh pg_dump and uploads it to S3. Safe to run alongside live traffic, but holds a brief consistent snapshot of the database. If a backup is already running it will no-op."
        confirmLabel="Run backup"
        destructive={false}
        busy={runBackup.isPending}
        onConfirm={() => runBackup.mutate()}
      />
    </div>
  );
}
