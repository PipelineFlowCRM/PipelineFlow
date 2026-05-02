import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Hammer, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ConfirmDialog';

type ForceReconcileResponse = { ok: true; jobId: string };

export function MaintenanceCard() {
  const [confirmOpen, setConfirmOpen] = useState(false);

  const forceReconcile = useMutation({
    mutationFn: () => api.post<ForceReconcileResponse>('/admin/s3-reconcile/force'),
    onSuccess: (data) => {
      setConfirmOpen(false);
      toast.success(`Full S3 reconcile queued (job ${data.jobId})`);
    },
    onError: (e) =>
      toast.error((e as Error).message || 'Could not queue reconcile job'),
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
    </div>
  );
}
