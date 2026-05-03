import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Download, FileSpreadsheet, Play, Plus, Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { importApi, type ImportJobDto } from '@/lib/import/api';
import { toast } from 'sonner';

const STATUS_STYLES: Record<ImportJobDto['status'], string> = {
  pending: 'bg-muted text-muted-foreground',
  validating: 'bg-amber-500/15 text-amber-300',
  validated: 'bg-amber-500/15 text-amber-300',
  committing: 'bg-amber-500/15 text-amber-300',
  completed: 'bg-emerald-500/15 text-emerald-300',
  failed: 'bg-rose-500/15 text-rose-300',
};

const ENTITY_LABELS: Record<ImportJobDto['entityType'], string> = {
  company: 'Companies',
  contact: 'Contacts',
  deal: 'Deals',
  note: 'Notes',
};

// Statuses where the server is doing work. The list page polls while
// any visible job is in one of these so the user sees status changes
// without a manual refresh.
const IN_FLIGHT_STATUSES: ReadonlyArray<ImportJobDto['status']> = [
  'validating',
  'committing',
];

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// A job is resumable if the user can still progress it: the upload
// landed (`pending`) or the dry-run finished (`validated`). In-flight
// statuses (`validating`, `committing`) are excluded — the wizard would
// race against the server. Terminal statuses (`completed`, `failed`)
// are out too — completed has no more steps; failed is intentionally
// archived rather than retried in place.
function isResumable(status: ImportJobDto['status']): boolean {
  return status === 'pending' || status === 'validated';
}

// Deletable in any non-in-flight status. Both `validating` and
// `committing` are mid-write — yanking the row out from under the
// runner would surface as a P2025 to whatever is awaiting that run.
function isDeletable(status: ImportJobDto['status']): boolean {
  return status !== 'committing' && status !== 'validating';
}

export function Import() {
  const qc = useQueryClient();

  // Cursor-paginated infinite list. We refetch while any in-flight job
  // is on screen so the user sees `committing → completed` flips
  // without hitting refresh.
  const query = useInfiniteQuery({
    queryKey: ['import-jobs'],
    queryFn: ({ pageParam }) => importApi.listJobs(pageParam ?? undefined),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: (q) => {
      const pages = q.state.data?.pages ?? [];
      const hasInFlight = pages.some((p) =>
        p.jobs.some((j) => IN_FLIGHT_STATUSES.includes(j.status)),
      );
      return hasInFlight ? 2_000 : false;
    },
  });

  const jobs = useMemo(
    () => (query.data?.pages ?? []).flatMap((p) => p.jobs),
    [query.data],
  );

  const [confirmDelete, setConfirmDelete] = useState<ImportJobDto | null>(null);

  const deleteMut = useMutation({
    mutationFn: (id: string) => importApi.deleteJob(id),
    onSuccess: () => {
      toast.success('Import job deleted');
      setConfirmDelete(null);
      void qc.invalidateQueries({ queryKey: ['import-jobs'] });
    },
    onError: (err) => toast.error((err as Error).message),
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>Data import</CardTitle>
          <CardDescription>
            Bulk-load Companies, Contacts, and Deals from a CSV. Re-imports of
            the same export update existing records via external ID.
          </CardDescription>
        </div>
        <Button asChild>
          <Link to="/settings/import/new">
            <Plus className="mr-1 h-4 w-4" />
            New import
          </Link>
        </Button>
      </CardHeader>
      <CardContent>
        {query.isLoading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>
        ) : jobs.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/70 py-10 text-center">
            <FileSpreadsheet className="mx-auto mb-3 h-8 w-8 text-muted-foreground/60" />
            <div className="text-sm font-medium">No imports yet</div>
            <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
              Upload a CSV to bring your existing CRM data into PipelineFlow.
              Pipedrive, HubSpot, and Salesforce exports auto-map.
            </p>
            <Button asChild className="mt-4" variant="secondary">
              <Link to="/settings/import/new">Start an import</Link>
            </Button>
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border border-border/70">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">When</th>
                  <th className="px-3 py-2 font-medium">File</th>
                  <th className="px-3 py-2 font-medium">Entity</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium text-right">Rows</th>
                  <th className="px-3 py-2 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id} className="border-t border-border/70">
                    <td className="px-3 py-2 text-muted-foreground">
                      {formatDateTime(job.createdAt)}
                    </td>
                    <td className="max-w-[260px] truncate px-3 py-2 font-medium">
                      {job.filename}
                      {job.presetUsed ? (
                        <span className="ml-2 text-[11px] text-muted-foreground">
                          ({job.presetUsed})
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {ENTITY_LABELS[job.entityType]}
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant="secondary" className={STATUS_STYLES[job.status]}>
                        {job.status}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                      <span className="text-emerald-300">{job.createdRows}</span>{' '}new ·{' '}
                      <span className="text-sky-300">{job.updatedRows}</span>{' '}upd ·{' '}
                      <span className={job.errorRows > 0 ? 'text-rose-300' : ''}>{job.errorRows}</span>{' '}err
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-1">
                        {isResumable(job.status) ? (
                          <Button asChild size="sm" variant="ghost">
                            <Link to={`/settings/import/new?resume=${job.id}`}>
                              <Play className="mr-1 h-3.5 w-3.5" />
                              Resume
                            </Link>
                          </Button>
                        ) : null}
                        {job.errorRows > 0 ? (
                          <Button asChild size="sm" variant="ghost">
                            <a href={importApi.errorsCsvUrl(job.id)}>
                              <Download className="mr-1 h-3.5 w-3.5" />
                              Errors
                            </a>
                          </Button>
                        ) : null}
                        {isDeletable(job.status) ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-muted-foreground hover:text-rose-300"
                            onClick={() => setConfirmDelete(job)}
                            aria-label="Delete import"
                            title="Delete import"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {query.hasNextPage ? (
              <div className="flex justify-center border-t border-border/70 bg-muted/20 px-3 py-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void query.fetchNextPage()}
                  disabled={query.isFetchingNextPage}
                >
                  {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </CardContent>

      <ConfirmDialog
        open={!!confirmDelete}
        onOpenChange={(open) => !open && setConfirmDelete(null)}
        title="Delete this import job?"
        description={
          confirmDelete ? (
            <>
              Permanently removes <strong>{confirmDelete.filename}</strong> and
              its source file from storage.{' '}
              {confirmDelete.status === 'completed'
                ? 'Records imported by this job stay in PipelineFlow — only the audit row is deleted.'
                : 'You can re-upload the CSV to start fresh.'}
            </>
          ) : null
        }
        confirmLabel="Delete"
        busy={deleteMut.isPending}
        onConfirm={() => {
          if (confirmDelete) deleteMut.mutate(confirmDelete.id);
        }}
      />
    </Card>
  );
}
