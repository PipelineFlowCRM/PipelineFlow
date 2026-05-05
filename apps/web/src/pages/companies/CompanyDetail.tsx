import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Bot, Building2, ExternalLink, Mail, Pen, Pencil, Phone, Pin, PinOff, Plus, Sparkles, Trash2 } from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { StageBadge } from '@/components/StageBadge';
import { NoteContent } from '@/components/NoteContent';
import { api } from '@/lib/api';
import type { CompanyDto, ContactDto, DealDto } from '@/types';
import { formatMoney, initials, relativeTime } from '@/lib/utils';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { CustomFieldsReadCard } from '@/components/customFields/CustomFieldsReadCard';
import { TagChip } from '@/components/tags/TagChip';
import { TagEditPopover } from '@/components/tags/TagEditPopover';
import { CompanyEditDialog } from './CompanyEditDialog';
import { ContactCreateDialog } from '../contacts/ContactCreateDialog';
import { DealCreateDialog } from '../deals/DealCreateDialog';
import { EnrichDialog } from './EnrichDialog';

interface CompanyNoteDto {
  id: number;
  content: string;
  companyId: number | null;
  createdBy: number | null;
  author: { id: number; name: string; avatarColor: string } | null;
  isPinned: boolean;
  createdAt: string;
}

interface CompanyResponse {
  company: CompanyDto;
  contacts: ContactDto[];
  deals: DealDto[];
  notes: CompanyNoteDto[];
}

export function CompanyDetail() {
  const { id } = useParams<{ id: string }>();
  const companyId = Number(id);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [editOpen, setEditOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [newContactOpen, setNewContactOpen] = useState(false);
  const [newDealOpen, setNewDealOpen] = useState(false);
  const [enrichOpen, setEnrichOpen] = useState(false);

  const { data } = useQuery({
    queryKey: ['company', companyId],
    queryFn: () => api.get<CompanyResponse>(`/companies/${companyId}`),
    enabled: Number.isFinite(companyId),
  });

  const deleteMut = useMutation({
    mutationFn: () => api.delete(`/companies/${companyId}`),
    onSuccess: () => {
      toast.success('Company deleted');
      qc.invalidateQueries({ queryKey: ['companies'] });
      navigate('/companies');
    },
  });

  if (!data) return <div className="text-sm text-muted-foreground">Loading…</div>;
  const c = data.company;

  const cityState = [c.city, c.state].filter(Boolean).join(', ');
  const fullAddress = [c.addressLine1, c.addressLine2, [cityState, c.postalCode].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join('\n');

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <Link to="/companies" className="mb-2 inline-flex items-center text-xs text-muted-foreground hover:text-foreground">
            <ArrowLeft className="mr-1 h-3 w-3" /> Back
          </Link>
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-md border bg-muted">
              <Building2 className="h-5 w-5 text-muted-foreground" />
            </div>
            <div className="min-w-0">
              <h1 className="text-2xl font-semibold tracking-tight break-words">{c.name}</h1>
              {(c.industry || c.size) && (
                <div className="mt-0.5 text-sm text-muted-foreground">
                  {[c.industry, c.size].filter(Boolean).join(' · ')}
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" onClick={() => setEnrichOpen(true)}>
            <Sparkles /> Enrich
          </Button>
          <Button variant="outline" onClick={() => setEditOpen(true)}>
            <Pen /> Edit
          </Button>
          <Button variant="outline" onClick={() => setConfirmDelete(true)}>
            <Trash2 /> Delete
          </Button>
        </div>
      </div>

      <CompanyEditDialog company={c} open={editOpen} onOpenChange={setEditOpen} />
      <EnrichDialog companyId={companyId} open={enrichOpen} onOpenChange={setEnrichOpen} />

      <ContactCreateDialog
        open={newContactOpen}
        onOpenChange={setNewContactOpen}
        defaultCompanyId={Number.isFinite(companyId) ? companyId : null}
        onCreated={() => {
          qc.invalidateQueries({ queryKey: ['company', companyId] });
          qc.invalidateQueries({ queryKey: ['contacts'] });
        }}
      />

      <DealCreateDialog
        open={newDealOpen}
        onOpenChange={setNewDealOpen}
        defaultCompanyId={Number.isFinite(companyId) ? companyId : null}
        defaultTitle={`${c.name} Deal`}
        onCreated={() => {
          qc.invalidateQueries({ queryKey: ['company', companyId] });
          qc.invalidateQueries({ queryKey: ['deals'] });
        }}
      />

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${c.name}?`}
        description="This removes the company. Linked deals and contacts stay but lose the reference."
        confirmLabel="Delete company"
        busy={deleteMut.isPending}
        onConfirm={() => deleteMut.mutate()}
      />

      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle className="text-base">Details</CardTitle></CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-3">
              <FieldRow label="Website">
                {c.website ? (
                  <a
                    href={normalizeUrl(c.website)}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-primary hover:underline break-all"
                  >
                    {stripUrlScheme(c.website)}
                    <ExternalLink className="h-3 w-3 shrink-0" />
                  </a>
                ) : <Empty />}
              </FieldRow>
              <FieldRow label="Phone">
                {c.phone ? (
                  <a href={`tel:${c.phone}`} className="text-primary hover:underline">{c.phone}</a>
                ) : <Empty />}
              </FieldRow>
              <FieldRow label="Size">
                {c.size ?? <Empty />}
              </FieldRow>
              <div className="md:col-span-3">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">Address</div>
                <div className="mt-1 whitespace-pre-line text-sm">
                  {fullAddress ? fullAddress : <Empty />}
                </div>
              </div>
              {c.notes ? (
                <div className="md:col-span-3">
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">Notes</div>
                  <NoteContent content={c.notes} className="mt-1" />
                </div>
              ) : null}
              {c.tags && c.tags.length > 0 ? (
                <div className="md:col-span-3">
                  <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">Tags</div>
                  <div className="flex flex-wrap gap-1">
                    {c.tags.map((t) => (
                      <TagEditPopover key={t.id} tag={t}>
                        <TagChip tag={t} interactive />
                      </TagEditPopover>
                    ))}
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>

          <CustomFieldsReadCard
            entityType="COMPANY"
            values={c.customFields ?? {}}
            onEdit={() => setEditOpen(true)}
          />

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Notes ({data.notes.length})</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <CompanyNoteForm companyId={companyId} />
              {data.notes.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No notes yet. Add one above, or enrich the company with Claude
                  to drop a research summary here.
                </p>
              ) : (
                data.notes.map((n) => (
                  <CompanyNoteRow key={n.id} note={n} companyId={companyId} />
                ))
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">Deals ({data.deals.length})</CardTitle>
              <Button size="sm" variant="outline" onClick={() => setNewDealOpen(true)}>
                <Plus /> Add
              </Button>
            </CardHeader>
            <CardContent className="space-y-2">
              {data.deals.map((d) => (
                <Link key={d.id} to={`/deals/${d.id}`} className="flex items-center justify-between rounded-md border p-2 text-sm hover:bg-accent">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{d.title}</div>
                    {d.stage ? <StageBadge name={d.stage.name} color={d.stage.color} className="mt-0.5" /> : null}
                  </div>
                  <span className="font-mono text-xs">{formatMoney(d.amount)}</span>
                </Link>
              ))}
              {data.deals.length === 0 ? <p className="text-sm text-muted-foreground">No deals.</p> : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">Contacts ({data.contacts.length})</CardTitle>
              <Button size="sm" variant="outline" onClick={() => setNewContactOpen(true)}>
                <Plus /> Add
              </Button>
            </CardHeader>
            <CardContent className="space-y-2">
              {data.contacts.map((p) => (
                <Link key={p.id} to={`/contacts/${p.id}`} className="flex items-start gap-3 rounded-md border p-2 text-sm hover:bg-accent">
                  <Avatar className="mt-0.5 h-9 w-9 shrink-0"><AvatarFallback>{initials(p.fullName)}</AvatarFallback></Avatar>
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="truncate font-medium">{p.fullName}</div>
                    {p.title ? (
                      <div className="truncate text-xs text-muted-foreground">{p.title}</div>
                    ) : null}
                    {p.email ? (
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Mail className="h-3 w-3 shrink-0" />
                        <span className="truncate">{p.email}</span>
                      </div>
                    ) : null}
                    {p.phone ? (
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Phone className="h-3 w-3 shrink-0" />
                        <span className="truncate">{p.phone}</span>
                      </div>
                    ) : null}
                    {p.tags && p.tags.length > 0 ? (
                      <div className="flex flex-wrap gap-1 pt-1">
                        {p.tags.map((t) => (
                          <TagChip key={t.id} tag={t} />
                        ))}
                      </div>
                    ) : null}
                  </div>
                </Link>
              ))}
              {data.contacts.length === 0 ? <p className="text-sm text-muted-foreground">No contacts.</p> : null}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-sm">{children}</div>
    </div>
  );
}

function Empty() {
  return <span className="text-muted-foreground">—</span>;
}

function normalizeUrl(s: string): string {
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}

function stripUrlScheme(s: string): string {
  return s.replace(/^https?:\/\//i, '');
}

// ─── Notes ──────────────────────────────────────────────────────────────────
// Mirrors the Deal-detail notes pattern: a stacked add-form on top, then a
// list of rows that flip into in-place editors on hover-click. The polymorphic
// notes API accepts any one of dealId / companyId / contactId — here we only
// pass companyId.

function CompanyNoteForm({ companyId }: { companyId: number }) {
  const qc = useQueryClient();
  const [content, setContent] = useState('');
  const mut = useMutation({
    mutationFn: () => api.post('/notes', { companyId, content }),
    onSuccess: () => {
      setContent('');
      qc.invalidateQueries({ queryKey: ['company', companyId] });
    },
    onError: (e) => toast.error((e as Error).message || 'Could not add note'),
  });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (content.trim()) mut.mutate();
      }}
      className="space-y-2"
    >
      <Textarea
        placeholder="Add a note…"
        value={content}
        onChange={(e) => setContent(e.target.value)}
      />
      <div className="flex justify-end">
        <Button size="sm" disabled={!content.trim() || mut.isPending}>
          Add note
        </Button>
      </div>
    </form>
  );
}

function CompanyNoteRow({
  note,
  companyId,
}: {
  note: CompanyNoteDto;
  companyId: number;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.content);

  // Notes appended by the enrichment flow have no author and start with
  // `**Enriched by Claude…**`. Surface that explicitly so users don't see a
  // misleading "—".
  const isEnrichmentNote =
    note.author == null && note.content.startsWith('**Enriched by Claude');

  const updateMut = useMutation({
    mutationFn: () => api.patch(`/notes/${note.id}`, { content: draft }),
    onSuccess: () => {
      setEditing(false);
      qc.invalidateQueries({ queryKey: ['company', companyId] });
    },
    onError: (e) => toast.error((e as Error).message || 'Could not save note'),
  });

  const pinMut = useMutation({
    mutationFn: () => api.patch(`/notes/${note.id}`, { isPinned: !note.isPinned }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['company', companyId] }),
    onError: (e) => toast.error((e as Error).message || 'Could not pin note'),
  });

  const deleteMut = useMutation({
    mutationFn: () => api.delete(`/notes/${note.id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['company', companyId] }),
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
    <div className={`group relative rounded-md border p-3 ${note.isPinned ? 'border-amber-300/70 bg-amber-50/40 dark:border-amber-500/40 dark:bg-amber-500/5' : ''}`}>
      <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
        {isEnrichmentNote ? (
          <span className="inline-flex items-center gap-1 font-medium text-foreground">
            <Sparkles className="h-3 w-3" />
            Claude
          </span>
        ) : note.author ? (
          <>
            <Avatar className="h-5 w-5">
              <AvatarFallback color={note.author.avatarColor}>
                {initials(note.author.name)}
              </AvatarFallback>
            </Avatar>
            <span className="font-medium text-foreground">{note.author.name}</span>
          </>
        ) : (
          <>
            <span className="grid h-5 w-5 place-items-center rounded-full bg-muted text-muted-foreground">
              <Bot className="h-3 w-3" />
            </span>
            <span className="font-medium text-foreground">System</span>
          </>
        )}
        <span>{relativeTime(note.createdAt)}</span>
        {note.isPinned ? (
          <span className="inline-flex items-center gap-1 rounded-sm bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-900 dark:bg-amber-500/15 dark:text-amber-200">
            <Pin className="h-3 w-3" /> Pinned
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            aria-label={note.isPinned ? 'Unpin note' : 'Pin note'}
            aria-pressed={note.isPinned}
            onClick={() => pinMut.mutate()}
            disabled={pinMut.isPending}
          >
            {note.isPinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
          </Button>
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
      <NoteContent content={note.content} />
    </div>
  );
}
