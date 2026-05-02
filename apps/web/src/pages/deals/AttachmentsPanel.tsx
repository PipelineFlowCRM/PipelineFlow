import { useCallback, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Download, FileText, Image as ImageIcon, Loader2, Paperclip, Trash2, Upload, X,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { uploadToS3 } from '@/lib/upload';
import { cn, formatBytes, relativeTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import type { AttachmentDto } from '@/types';

interface Props {
  dealId: number;
  attachments: AttachmentDto[];
}

type UploadItem = {
  id: string;
  file: File;
  loaded: number;
  total: number;
  status: 'queued' | 'uploading' | 'done' | 'error';
  error?: string;
};

const MAX_BYTES = 50 * 1024 * 1024; // matches the api's presignUploadSchema cap
const isImageType = (ct: string | null | undefined) => !!ct?.startsWith('image/');

export function AttachmentsPanel({ dealId, attachments }: Props) {
  const images = attachments.filter((a) => isImageType(a.contentType));
  const files = attachments.filter((a) => !isImageType(a.contentType));

  // Default to whichever sub-tab actually has content. Falls through to
  // Images on a fresh deal so the empty-state CTA appears in the more
  // visually-rich panel.
  const defaultTab = images.length > 0 || files.length === 0 ? 'images' : 'files';

  return (
    <div className="space-y-4">
      <Uploader dealId={dealId} />

      <Tabs defaultValue={defaultTab} className="space-y-3">
        <TabsList>
          <TabsTrigger value="images">
            <ImageIcon className="mr-1.5 h-3.5 w-3.5" />
            Images
            <span className="ml-1.5 rounded-md bg-background/80 px-1.5 text-[11px] font-medium text-muted-foreground data-[state=active]:bg-muted">
              {images.length}
            </span>
          </TabsTrigger>
          <TabsTrigger value="files">
            <FileText className="mr-1.5 h-3.5 w-3.5" />
            Files
            <span className="ml-1.5 rounded-md bg-background/80 px-1.5 text-[11px] font-medium text-muted-foreground">
              {files.length}
            </span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="images" className="m-0">
          <ImageGrid attachments={images} dealId={dealId} />
        </TabsContent>

        <TabsContent value="files" className="m-0">
          <FilesTable attachments={files} dealId={dealId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ─── Uploader ─────────────────────────────────────────────────────────────

function Uploader({ dealId }: { dealId: number }) {
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [items, setItems] = useState<UploadItem[]>([]);
  // Track depth so a child element's `dragleave` doesn't blank the highlight
  // while the cursor is still inside the dropzone. Browsers fire enter/leave
  // for every nested element traversal — depth >= 1 means "still over us".
  const dragDepth = useRef(0);

  const enqueue = useCallback(
    (files: FileList | File[]) => {
      const incoming: UploadItem[] = [];
      for (const file of Array.from(files)) {
        if (file.size > MAX_BYTES) {
          toast.error(`${file.name} is over the 50 MB limit`);
          continue;
        }
        incoming.push({
          // Plain pseudo-random suffix instead of `crypto.randomUUID()` —
          // randomUUID requires a Secure Context (HTTPS or localhost), and
          // the homelab/LAN-IP-over-HTTP deployment scenario the README
          // documents would otherwise crash here. Uniqueness is for a
          // React `key` only; non-cryptographic is fine.
          id: `${file.name}-${file.size}-${file.lastModified}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          file,
          loaded: 0,
          total: file.size,
          status: 'queued',
        });
      }
      if (incoming.length === 0) return;
      setItems((prev) => [...prev, ...incoming]);
      // Kick uploads off in parallel — S3 handles concurrent PUTs fine and
      // a typical multi-select is 2–10 files. If we ever see users dragging
      // 100+ at once we should add a concurrency limiter (p-limit-style).
      void Promise.allSettled(incoming.map((item) => runUpload(item)));
    },
    // runUpload uses qc + setItems via closure; nothing else needs to be in the dep array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dealId, qc],
  );

  const runUpload = useCallback(
    async (item: UploadItem) => {
      setItems((prev) =>
        prev.map((i) => (i.id === item.id ? { ...i, status: 'uploading' } : i)),
      );
      try {
        await uploadToS3(item.file, 'attachment', { dealId }, {
          onProgress: (loaded, total) => {
            setItems((prev) =>
              prev.map((i) => (i.id === item.id ? { ...i, loaded, total } : i)),
            );
          },
        });
        setItems((prev) =>
          prev.map((i) =>
            i.id === item.id
              ? { ...i, status: 'done', loaded: i.total }
              : i,
          ),
        );
        qc.invalidateQueries({ queryKey: ['deal', dealId] });
        // Auto-clear successful entries after a beat so the panel doesn't
        // accumulate stale "done" rows. Errors stick until the user dismisses.
        setTimeout(() => {
          setItems((prev) => prev.filter((i) => i.id !== item.id));
        }, 1500);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Upload failed';
        setItems((prev) =>
          prev.map((i) =>
            i.id === item.id ? { ...i, status: 'error', error: message } : i,
          ),
        );
        toast.error(`${item.file.name}: ${message}`);
      }
    },
    [dealId, qc],
  );

  const dismiss = (id: string) =>
    setItems((prev) => prev.filter((i) => i.id !== id));

  return (
    <div className="space-y-2">
      <div
        onClick={() => fileInputRef.current?.click()}
        onDragEnter={(e) => {
          e.preventDefault();
          dragDepth.current += 1;
          setIsDragging(true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setIsDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          dragDepth.current = 0;
          setIsDragging(false);
          if (e.dataTransfer.files.length > 0) enqueue(e.dataTransfer.files);
        }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            fileInputRef.current?.click();
          }
        }}
        className={cn(
          'group flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed p-6 text-center transition-colors',
          'border-border bg-muted/30 hover:border-primary/50 hover:bg-muted/50',
          isDragging && 'border-primary bg-primary/5',
        )}
      >
        <div
          className={cn(
            'rounded-full bg-background p-2 shadow-sm ring-1 ring-border transition-colors',
            isDragging && 'ring-primary',
          )}
        >
          <Upload className={cn('h-4 w-4', isDragging ? 'text-primary' : 'text-muted-foreground')} />
        </div>
        <div className="text-sm font-medium">
          {isDragging ? 'Drop to upload' : 'Drop files here, or click to browse'}
        </div>
        <div className="text-xs text-muted-foreground">
          Multiple files supported — up to 50 MB each
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="sr-only"
          // The dropzone's onClick calls inputRef.click(); without
          // stopPropagation here the resulting click event would bubble
          // back up to the dropzone div and re-trigger the same handler
          // (depending on browser, this can manifest as the file picker
          // opening twice or worse — a synchronous stack-overflow loop).
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) {
              enqueue(e.target.files);
              e.target.value = '';
            }
          }}
        />
      </div>

      {items.length > 0 ? (
        <ul className="space-y-1.5">
          {items.map((item) => (
            <li
              key={item.id}
              className={cn(
                'flex items-center gap-3 rounded-md border bg-card p-2.5 text-sm',
                item.status === 'error' && 'border-destructive/40 bg-destructive/5',
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <div className="truncate font-medium">{item.file.name}</div>
                  <div className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {item.status === 'error'
                      ? 'Failed'
                      : item.status === 'done'
                        ? formatBytes(item.total)
                        : `${formatBytes(item.loaded)} / ${formatBytes(item.total)}`}
                  </div>
                </div>
                <ProgressBar
                  value={item.total > 0 ? (item.loaded / item.total) * 100 : 0}
                  state={item.status}
                />
                {item.error ? (
                  <div className="mt-1 truncate text-xs text-destructive">{item.error}</div>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => dismiss(item.id)}
                className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label="Dismiss"
              >
                {item.status === 'uploading' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <X className="h-3.5 w-3.5" />
                )}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ProgressBar({
  value,
  state,
}: {
  value: number;
  state: UploadItem['status'];
}) {
  return (
    <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-muted">
      <div
        className={cn(
          'h-full transition-[width] duration-200 ease-out',
          state === 'error' ? 'bg-destructive'
            : state === 'done' ? 'bg-emerald-500'
              : 'bg-primary',
        )}
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  );
}

// ─── Image grid ───────────────────────────────────────────────────────────

function ImageGrid({
  attachments,
  dealId,
}: {
  attachments: AttachmentDto[];
  dealId: number;
}) {
  const [lightboxId, setLightboxId] = useState<number | null>(null);
  const lightbox = attachments.find((a) => a.id === lightboxId) ?? null;

  if (attachments.length === 0) {
    return (
      <div className="rounded-lg border border-dashed bg-muted/30 p-8 text-center text-sm text-muted-foreground">
        No images yet. Drop one above to get started.
      </div>
    );
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {attachments.map((a) => (
          <ImageCard
            key={a.id}
            att={a}
            dealId={dealId}
            onOpen={() => setLightboxId(a.id)}
          />
        ))}
      </div>
      <Lightbox
        att={lightbox}
        onClose={() => setLightboxId(null)}
      />
    </>
  );
}

function ImageCard({
  att,
  dealId,
  onOpen,
}: {
  att: AttachmentDto;
  dealId: number;
  onOpen: () => void;
}) {
  const qc = useQueryClient();
  const [confirmDel, setConfirmDel] = useState(false);

  const thumb = useQuery({
    queryKey: ['attachment-inline-url', att.id],
    queryFn: () =>
      api.get<{ url: string }>(`/uploads/attachments/${att.id}/url?inline=1`),
    staleTime: 4 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const del = useMutation({
    mutationFn: () => api.delete(`/uploads/attachments/${att.id}`),
    onSuccess: () => {
      setConfirmDel(false);
      qc.invalidateQueries({ queryKey: ['deal', dealId] });
    },
    onError: (e) => toast.error((e as Error).message || 'Could not delete file'),
  });

  return (
    <div className="group relative overflow-hidden rounded-lg border bg-card shadow-sm transition-shadow hover:shadow-md">
      <button
        onClick={onOpen}
        className="block aspect-square w-full overflow-hidden bg-muted"
        aria-label={`Open ${att.filename}`}
      >
        {thumb.data?.url ? (
          <img
            src={thumb.data.url}
            alt={att.filename}
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <ImageIcon className="h-8 w-8 text-muted-foreground/50" />
          </div>
        )}
      </button>

      {/* Hover gradient + filename + actions */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 via-black/40 to-transparent p-2 opacity-0 transition-opacity group-hover:opacity-100">
        <div className="truncate text-xs font-medium text-white">{att.filename}</div>
        <div className="text-[10px] text-white/70">
          {formatBytes(att.sizeBytes)} · {att.uploader?.name ?? 'Unknown'}
        </div>
      </div>
      <button
        type="button"
        onClick={() => setConfirmDel(true)}
        aria-label={`Delete ${att.filename}`}
        className="absolute right-1.5 top-1.5 rounded-md bg-background/90 p-1 text-muted-foreground opacity-0 shadow-sm ring-1 ring-border transition-all hover:text-destructive group-hover:opacity-100"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>

      <ConfirmDialog
        open={confirmDel}
        onOpenChange={setConfirmDel}
        title={`Delete "${att.filename}"?`}
        description="The file is removed from storage and cannot be restored."
        confirmLabel="Delete file"
        busy={del.isPending}
        onConfirm={() => del.mutate()}
      />
    </div>
  );
}

function Lightbox({
  att,
  onClose,
}: {
  att: AttachmentDto | null;
  onClose: () => void;
}) {
  const thumb = useQuery({
    queryKey: ['attachment-inline-url', att?.id],
    queryFn: () =>
      api.get<{ url: string }>(`/uploads/attachments/${att!.id}/url?inline=1`),
    enabled: att != null,
    staleTime: 4 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  return (
    <Dialog open={att != null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[90vw] border-none bg-transparent p-0 shadow-none sm:max-w-[90vw]">
        <DialogTitle className="sr-only">{att?.filename ?? 'Image'}</DialogTitle>
        {thumb.data?.url ? (
          <img
            src={thumb.data.url}
            alt={att?.filename}
            className="mx-auto max-h-[85vh] w-auto rounded-md object-contain"
          />
        ) : (
          <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
            Loading…
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Files table ──────────────────────────────────────────────────────────

function FilesTable({
  attachments,
  dealId,
}: {
  attachments: AttachmentDto[];
  dealId: number;
}) {
  if (attachments.length === 0) {
    return (
      <div className="rounded-lg border border-dashed bg-muted/30 p-8 text-center text-sm text-muted-foreground">
        No files yet. Drop one above to get started.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <th className="px-3 py-2 text-left font-medium">Name</th>
            <th className="hidden px-3 py-2 text-left font-medium sm:table-cell">Size</th>
            <th className="hidden px-3 py-2 text-left font-medium md:table-cell">Uploader</th>
            <th className="hidden px-3 py-2 text-left font-medium md:table-cell">Added</th>
            <th className="px-2 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {attachments.map((a) => (
            <FileRow key={a.id} att={a} dealId={dealId} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FileRow({ att, dealId }: { att: AttachmentDto; dealId: number }) {
  const qc = useQueryClient();
  const [confirmDel, setConfirmDel] = useState(false);

  const download = async () => {
    const { url } = await api.get<{ url: string }>(`/uploads/attachments/${att.id}/url`);
    window.open(url, '_blank');
  };
  const del = useMutation({
    mutationFn: () => api.delete(`/uploads/attachments/${att.id}`),
    onSuccess: () => {
      setConfirmDel(false);
      qc.invalidateQueries({ queryKey: ['deal', dealId] });
    },
    onError: (e) => toast.error((e as Error).message || 'Could not delete file'),
  });

  return (
    <tr className="border-b last:border-b-0 hover:bg-muted/40">
      <td className="px-3 py-2">
        <button
          onClick={download}
          className="flex min-w-0 items-center gap-2 text-left"
        >
          <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate hover:underline">{att.filename}</span>
        </button>
      </td>
      <td className="hidden px-3 py-2 text-xs tabular-nums text-muted-foreground sm:table-cell">
        {formatBytes(att.sizeBytes)}
      </td>
      <td className="hidden px-3 py-2 text-xs text-muted-foreground md:table-cell">
        {att.uploader?.name ?? '—'}
      </td>
      <td className="hidden px-3 py-2 text-xs text-muted-foreground md:table-cell">
        {relativeTime(att.uploadedAt)}
      </td>
      <td className="px-2 py-1.5">
        <div className="flex items-center justify-end gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            onClick={download}
            aria-label="Download"
            className="h-7 w-7"
          >
            <Download className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setConfirmDel(true)}
            aria-label="Delete"
            className="h-7 w-7 text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </td>
      <ConfirmDialog
        open={confirmDel}
        onOpenChange={setConfirmDel}
        title={`Delete "${att.filename}"?`}
        description="The file is removed from storage and cannot be restored."
        confirmLabel="Delete file"
        busy={del.isPending}
        onConfirm={() => del.mutate()}
      />
    </tr>
  );
}
