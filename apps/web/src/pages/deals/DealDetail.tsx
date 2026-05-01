import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, Calendar, Check, FileText, MoreVertical, Paperclip, Pencil, Pen, Plus, Trash2,
} from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { StageBadge } from '@/components/StageBadge';
import { api } from '@/lib/api';
import { formatMoney, initials, relativeTime } from '@/lib/utils';
import type {
  ActivityDto, AttachmentDto, DealDto, NoteDto, StageDto, TaskDto,
} from '@/types';
import { toast } from 'sonner';
import { uploadToS3 } from '@/lib/upload';
import { DealEditDialog } from './DealEditDialog';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { CustomFieldsReadCard } from '@/components/customFields/CustomFieldsReadCard';
import { TagChip } from '@/components/tags/TagChip';
import { TagEditPopover } from '@/components/tags/TagEditPopover';

interface DealResponse {
  deal: DealDto;
  notes: NoteDto[];
  tasks: TaskDto[];
  attachments: AttachmentDto[];
  activities: ActivityDto[];
}

export function DealDetail() {
  const { id } = useParams<{ id: string }>();
  const dealId = Number(id);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [editOpen, setEditOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const { data } = useQuery({
    queryKey: ['deal', dealId],
    queryFn: () => api.get<DealResponse>(`/deals/${dealId}`),
    enabled: Number.isFinite(dealId),
  });
  const { data: stagesData } = useQuery({
    queryKey: ['stages'],
    queryFn: () => api.get<{ stages: StageDto[] }>('/stages'),
  });

  const moveMut = useMutation({
    mutationFn: (stageId: number) => api.post(`/deals/${dealId}/move`, { stageId, position: 0 }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['deal', dealId] }),
  });

  const deleteMut = useMutation({
    mutationFn: () => api.delete(`/deals/${dealId}`),
    onSuccess: () => {
      toast.success('Deal deleted');
      navigate('/deals');
    },
  });

  if (!data) return <div className="text-sm text-muted-foreground">Loading…</div>;
  const { deal } = data;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link to="/deals" className="mb-2 inline-flex items-center text-xs text-muted-foreground hover:text-foreground">
            <ArrowLeft className="mr-1 h-3 w-3" /> Back to deals
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">{deal.title}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            {deal.company ? (
              <Link to={`/companies/${deal.company.id}`} className="hover:text-foreground hover:underline">
                {deal.company.name}
              </Link>
            ) : null}
            {deal.primaryContact ? (
              <>
                <span>·</span>
                <Link
                  to={`/contacts/${deal.primaryContact.id}`}
                  className="hover:text-foreground hover:underline"
                >
                  {deal.primaryContact.fullName}
                </Link>
              </>
            ) : null}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Select
            value={String(deal.stageId)}
            onValueChange={(v) => moveMut.mutate(Number(v))}
          >
            <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
            <SelectContent>
              {stagesData?.stages.map((s) => (
                <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={() => setEditOpen(true)}>
            <Pen /> Edit
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button variant="outline" size="icon"><MoreVertical /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setConfirmDelete(true)}>
                <Trash2 className="h-4 w-4" /> Delete deal
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <DealEditDialog deal={deal} open={editOpen} onOpenChange={setEditOpen} />

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete "${deal.title}"?`}
        description="Notes, tasks, files, and activity for this deal are removed too. This cannot be undone."
        confirmLabel="Delete deal"
        busy={deleteMut.isPending}
        onConfirm={() => deleteMut.mutate()}
      />

      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">Overview</CardTitle>
              {deal.stage ? <StageBadge name={deal.stage.name} color={deal.stage.color} /> : null}
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-3">
              <Field label="Amount" value={formatMoney(deal.amount, deal.currency)} mono />
              <Field label="Probability" value={`${deal.probability}%`} />
              <Field label="Weighted" value={formatMoney(deal.weightedValue)} mono />
              <Field label="Expected close" value={deal.expectedCloseDate ?? '—'} />
              <Field label="Owner" value={deal.owner?.name ?? '—'} />
              <Field label="Updated" value={relativeTime(deal.updatedAt)} />
              {deal.tags.length > 0 && (
                <div className="md:col-span-3">
                  <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">Tags</div>
                  <div className="flex flex-wrap gap-1">
                    {deal.tags.map((t) => (
                      <TagEditPopover key={t.id} tag={t}>
                        <TagChip tag={t} interactive />
                      </TagEditPopover>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          <CustomFieldsReadCard
            entityType="DEAL"
            values={deal.customFields ?? {}}
            onEdit={() => setEditOpen(true)}
          />

          <Tabs defaultValue="notes">
            <TabsList>
              <TabsTrigger value="notes"><FileText className="mr-1 h-3.5 w-3.5" /> Notes ({data.notes.length})</TabsTrigger>
              <TabsTrigger value="tasks"><Check className="mr-1 h-3.5 w-3.5" /> Tasks ({data.tasks.length})</TabsTrigger>
              <TabsTrigger value="files"><Paperclip className="mr-1 h-3.5 w-3.5" /> Files ({data.attachments.length})</TabsTrigger>
              <TabsTrigger value="activity"><Pencil className="mr-1 h-3.5 w-3.5" /> Activity</TabsTrigger>
            </TabsList>

            <TabsContent value="notes" className="space-y-3">
              <NoteForm dealId={dealId} />
              {data.notes.map((n) => (
                <NoteRow key={n.id} note={n} dealId={dealId} />
              ))}
              {data.notes.length === 0 ? (
                <p className="text-sm text-muted-foreground">No notes yet.</p>
              ) : null}
            </TabsContent>

            <TabsContent value="tasks" className="space-y-3">
              <TaskForm dealId={dealId} />
              <div className="space-y-2">
                {data.tasks.map((t) => <TaskRow key={t.id} task={t} dealId={dealId} />)}
                {data.tasks.length === 0 ? <p className="text-sm text-muted-foreground">No tasks yet.</p> : null}
              </div>
            </TabsContent>

            <TabsContent value="files" className="space-y-3">
              <UploadBox dealId={dealId} />
              <div className="space-y-2">
                {data.attachments.map((a) => <AttachmentRow key={a.id} att={a} dealId={dealId} />)}
                {data.attachments.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No files yet.</p>
                ) : null}
              </div>
            </TabsContent>

            <TabsContent value="activity" className="space-y-2">
              {data.activities.map((a) => (
                <div key={a.id} className="flex items-start gap-3 text-sm">
                  <Avatar className="h-7 w-7">
                    <AvatarFallback color={a.actor?.avatarColor ?? '#94a3b8'}>{initials(a.actor?.name ?? '?')}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <div><span className="font-medium">{a.actor?.name ?? 'System'}</span>{' '}
                      <span className="text-muted-foreground">{a.summary}</span>
                    </div>
                    <div className="text-xs text-muted-foreground">{relativeTime(a.createdAt)}</div>
                  </div>
                </div>
              ))}
            </TabsContent>
          </Tabs>
        </div>

        <Card>
          <CardHeader><CardTitle className="text-base">Pipeline</CardTitle></CardHeader>
          <CardContent>
            <ol className="space-y-1.5">
              {stagesData?.stages.map((s) => (
                <li
                  key={s.id}
                  className={`flex items-center justify-between rounded-md px-2 py-1.5 text-sm ${s.id === deal.stageId ? 'bg-accent font-medium' : ''}`}
                >
                  <span className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
                    {s.name}
                  </span>
                  {s.id === deal.stageId ? <Check className="h-3.5 w-3.5" /> : null}
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`text-sm ${mono ? 'font-mono' : ''}`}>{value}</div>
    </div>
  );
}

function NoteForm({ dealId }: { dealId: number }) {
  const qc = useQueryClient();
  const [content, setContent] = useState('');
  const mut = useMutation({
    mutationFn: () => api.post('/notes', { dealId, content }),
    onSuccess: () => {
      setContent('');
      qc.invalidateQueries({ queryKey: ['deal', dealId] });
    },
  });
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); if (content.trim()) mut.mutate(); }}
      className="space-y-2"
    >
      <Textarea placeholder="Add a note…" value={content} onChange={(e) => setContent(e.target.value)} />
      <div className="flex justify-end">
        <Button size="sm" disabled={!content.trim() || mut.isPending}>Add note</Button>
      </div>
    </form>
  );
}

function NoteRow({ note, dealId }: { note: NoteDto; dealId: number }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.content);

  const updateMut = useMutation({
    mutationFn: () => api.patch(`/notes/${note.id}`, { content: draft }),
    onSuccess: () => {
      setEditing(false);
      qc.invalidateQueries({ queryKey: ['deal', dealId] });
    },
    onError: (e) => toast.error((e as Error).message || 'Could not save note'),
  });

  const deleteMut = useMutation({
    mutationFn: () => api.delete(`/notes/${note.id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['deal', dealId] }),
    onError: (e) => toast.error((e as Error).message || 'Could not delete note'),
  });

  if (editing) {
    return (
      <form
        className="space-y-2 rounded-md border bg-card p-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim() && draft.trim() !== note.content) updateMut.mutate();
          else setEditing(false);
        }}
      >
        <Textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setDraft(note.content);
              setEditing(false);
            } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              if (draft.trim() && draft.trim() !== note.content) updateMut.mutate();
              else setEditing(false);
            }
          }}
        />
        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setDraft(note.content);
              setEditing(false);
            }}
            disabled={updateMut.isPending}
          >
            Cancel
          </Button>
          <Button size="sm" disabled={!draft.trim() || updateMut.isPending}>
            Save
          </Button>
        </div>
      </form>
    );
  }

  return (
    <div className="group relative rounded-md border p-3">
      <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
        <Avatar className="h-5 w-5">
          <AvatarFallback color={note.author?.avatarColor ?? '#94a3b8'}>
            {initials(note.author?.name ?? '?')}
          </AvatarFallback>
        </Avatar>
        <span className="font-medium text-foreground">{note.author?.name ?? 'System'}</span>
        <span>{relativeTime(note.createdAt)}</span>
        <div className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            aria-label="Edit note"
            onClick={() => {
              setDraft(note.content);
              setEditing(true);
            }}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-muted-foreground hover:text-destructive"
            aria-label="Delete note"
            onClick={() => deleteMut.mutate()}
            disabled={deleteMut.isPending}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <p className="whitespace-pre-wrap text-sm">{note.content}</p>
    </div>
  );
}

function TaskForm({ dealId }: { dealId: number }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [dueDate, setDueDate] = useState('');
  const mut = useMutation({
    mutationFn: () => api.post('/tasks', { dealId, title, dueDate: dueDate || null }),
    onSuccess: () => { setTitle(''); setDueDate(''); qc.invalidateQueries({ queryKey: ['deal', dealId] }); },
  });
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => { e.preventDefault(); if (title.trim()) mut.mutate(); }}
    >
      <div className="flex-1 space-y-1">
        <Label className="text-xs">New task</Label>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs to happen?" />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Due</Label>
        <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
      </div>
      <Button size="sm" disabled={!title.trim() || mut.isPending}><Plus /> Add</Button>
    </form>
  );
}

function TaskRow({ task, dealId }: { task: TaskDto; dealId: number }) {
  const qc = useQueryClient();
  const toggleMut = useMutation({
    mutationFn: () => api.post(`/tasks/${task.id}/toggle`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['deal', dealId] }),
  });
  const deleteMut = useMutation({
    mutationFn: () => api.delete(`/tasks/${task.id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['deal', dealId] }),
  });
  return (
    <div className="flex items-center gap-3 rounded-md border p-2 text-sm">
      <button
        onClick={() => toggleMut.mutate()}
        className={`grid h-5 w-5 place-items-center rounded border transition-colors ${task.status === 'completed' ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'}`}
      >
        {task.status === 'completed' ? <Check className="h-3 w-3" /> : null}
      </button>
      <div className={`flex-1 ${task.status === 'completed' ? 'text-muted-foreground line-through' : ''}`}>
        {task.title}
      </div>
      {task.dueDate ? (
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <Calendar className="h-3 w-3" />{task.dueDate}
        </span>
      ) : null}
      <Button variant="ghost" size="icon" onClick={() => deleteMut.mutate()}><Trash2 /></Button>
    </div>
  );
}

function UploadBox({ dealId }: { dealId: number }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  return (
    <div className="rounded-md border border-dashed p-4">
      <Label className="block text-sm font-medium">Upload file</Label>
      <input
        type="file"
        className="mt-2 text-sm"
        disabled={busy}
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          setBusy(true);
          try {
            await uploadToS3(file, 'attachment', { dealId });
            toast.success('File uploaded');
            qc.invalidateQueries({ queryKey: ['deal', dealId] });
            e.target.value = '';
          } catch (err) {
            toast.error((err as Error).message || 'Upload failed');
          } finally {
            setBusy(false);
          }
        }}
      />
      <p className="mt-1 text-xs text-muted-foreground">Up to 50 MB. Stored in S3.</p>
    </div>
  );
}

function AttachmentRow({ att, dealId }: { att: AttachmentDto; dealId: number }) {
  const qc = useQueryClient();
  const open = async () => {
    const { url } = await api.get<{ url: string }>(`/uploads/attachments/${att.id}/url`);
    window.open(url, '_blank');
  };
  const del = useMutation({
    mutationFn: () => api.delete(`/uploads/attachments/${att.id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['deal', dealId] }),
  });
  return (
    <div className="flex items-center gap-3 rounded-md border p-2 text-sm">
      <Paperclip className="h-4 w-4 text-muted-foreground" />
      <button onClick={open} className="flex-1 truncate text-left hover:underline">{att.filename}</button>
      <span className="text-xs text-muted-foreground">{att.uploader?.name}</span>
      <Button variant="ghost" size="icon" onClick={() => del.mutate()}><Trash2 /></Button>
    </div>
  );
}
