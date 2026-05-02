import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Building2, ExternalLink, Globe, MapPin, Pen, Phone, Trash2 } from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StageBadge } from '@/components/StageBadge';
import { api } from '@/lib/api';
import type { CompanyDto, ContactDto, DealDto } from '@/types';
import { formatMoney, initials } from '@/lib/utils';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { CustomFieldsReadCard } from '@/components/customFields/CustomFieldsReadCard';
import { TagChip } from '@/components/tags/TagChip';
import { TagEditPopover } from '@/components/tags/TagEditPopover';
import { ContactEditDialog } from './ContactEditDialog';

export function ContactDetail() {
  const { id } = useParams<{ id: string }>();
  const contactId = Number(id);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [logoFailed, setLogoFailed] = useState(false);

  const { data } = useQuery({
    queryKey: ['contact', contactId],
    queryFn: () =>
      api.get<{ contact: ContactDto; deals: DealDto[] }>(`/contacts/${contactId}`),
    enabled: Number.isFinite(contactId),
  });
  const { data: companyData } = useQuery({
    queryKey: ['company', data?.contact.companyId ?? null],
    queryFn: () =>
      api.get<{ company: CompanyDto }>(`/companies/${data!.contact.companyId}`),
    enabled: data?.contact.companyId != null,
  });

  const deleteMut = useMutation({
    mutationFn: () => api.delete(`/contacts/${contactId}`),
    onSuccess: () => {
      toast.success('Contact deleted');
      qc.invalidateQueries({ queryKey: ['contacts'] });
      navigate('/contacts');
    },
  });

  const logoUrl = companyData?.company.logoUrl ?? null;
  useEffect(() => { setLogoFailed(false); }, [logoUrl]);

  if (!data) return <div className="text-sm text-muted-foreground">Loading…</div>;
  const c = data.contact;
  const co = companyData?.company;
  const companySubtitle = [co?.industry, co?.size].filter(Boolean).join(' · ');
  const companyLocation = [co?.city, co?.state].filter(Boolean).join(', ');

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <Link to="/contacts" className="mb-2 inline-flex items-center text-xs text-muted-foreground hover:text-foreground">
            <ArrowLeft className="mr-1 h-3 w-3" /> Back
          </Link>
          <div className="flex items-center gap-3">
            <Avatar className="h-10 w-10 shrink-0"><AvatarFallback>{initials(c.fullName)}</AvatarFallback></Avatar>
            <div className="min-w-0">
              <h1 className="text-2xl font-semibold tracking-tight break-words">{c.fullName}</h1>
              {c.title || c.company ? (
                <div className="mt-0.5 text-sm text-muted-foreground">
                  {[c.title, c.company?.name].filter(Boolean).join(' · ')}
                </div>
              ) : null}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" onClick={() => setEditOpen(true)}>
            <Pen /> Edit
          </Button>
          <Button variant="outline" onClick={() => setConfirmDelete(true)}>
            <Trash2 /> Delete
          </Button>
        </div>
      </div>

      <ContactEditDialog contact={c} open={editOpen} onOpenChange={setEditOpen} />

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${c.fullName}?`}
        description="This removes the contact. Deals that referenced them stay but lose the reference."
        confirmLabel="Delete contact"
        busy={deleteMut.isPending}
        onConfirm={() => deleteMut.mutate()}
      />

      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">Details</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2">
              <FieldRow label="Email">
                {c.email ? (
                  <a href={`mailto:${c.email}`} className="text-primary hover:underline break-all">
                    {c.email}
                  </a>
                ) : <Empty />}
              </FieldRow>
              <FieldRow label="Phone">
                {c.phone ? (
                  <a href={`tel:${c.phone}`} className="text-primary hover:underline">{c.phone}</a>
                ) : <Empty />}
              </FieldRow>
              <FieldRow label="Title">
                {c.title ?? <Empty />}
              </FieldRow>
              <FieldRow label="LinkedIn">
                {c.linkedin ? (
                  <a
                    href={normalizeUrl(c.linkedin)}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-primary hover:underline break-all"
                  >
                    {stripUrlScheme(c.linkedin)}
                    <ExternalLink className="h-3 w-3 shrink-0" />
                  </a>
                ) : <Empty />}
              </FieldRow>
              {c.notes ? (
                <div className="space-y-1 md:col-span-2">
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">Notes</div>
                  <div className="whitespace-pre-wrap text-sm">{c.notes}</div>
                </div>
              ) : null}
              {c.tags && c.tags.length > 0 ? (
                <div className="md:col-span-2">
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
            entityType="CONTACT"
            values={c.customFields ?? {}}
            onEdit={() => setEditOpen(true)}
          />
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle className="text-base">Company</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {c.company ? (
                <>
                  <Link
                    to={`/companies/${c.company.id}`}
                    className="flex items-center gap-3 rounded-md border p-2 text-sm hover:bg-accent"
                  >
                    {co?.logoUrl && !logoFailed ? (
                      <img
                        src={co.logoUrl}
                        alt=""
                        onError={() => setLogoFailed(true)}
                        className="h-9 w-9 shrink-0 rounded-md border object-cover"
                      />
                    ) : (
                      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-md border bg-muted text-muted-foreground">
                        <Building2 className="h-4 w-4" />
                      </div>
                    )}
                    <div className="min-w-0">
                      <div className="truncate font-medium">{c.company.name}</div>
                      {companySubtitle ? (
                        <div className="truncate text-xs text-muted-foreground">
                          {companySubtitle}
                        </div>
                      ) : null}
                    </div>
                  </Link>
                  {co && (companyLocation || co.phone || co.website) ? (
                    <div className="space-y-1.5 px-2 text-xs text-muted-foreground">
                      {companyLocation ? (
                        <div className="flex items-center gap-2">
                          <MapPin className="h-3 w-3 shrink-0" />
                          <span className="truncate">{companyLocation}</span>
                        </div>
                      ) : null}
                      {co.phone ? (
                        <div className="flex items-center gap-2">
                          <Phone className="h-3 w-3 shrink-0" />
                          <a href={`tel:${co.phone}`} className="truncate text-primary hover:underline">
                            {co.phone}
                          </a>
                        </div>
                      ) : null}
                      {co.website ? (
                        <div className="flex items-start gap-2">
                          <Globe className="mt-0.5 h-3 w-3 shrink-0" />
                          <a
                            href={normalizeUrl(co.website)}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex min-w-0 flex-wrap items-center gap-1 break-all text-primary hover:underline"
                          >
                            {stripUrlScheme(co.website)}
                            <ExternalLink className="h-3 w-3 shrink-0" />
                          </a>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </>
              ) : (
                <p className="text-sm text-muted-foreground">No company linked.</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Deals ({data.deals.length})</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {data.deals.map((d) => (
                <Link
                  key={d.id}
                  to={`/deals/${d.id}`}
                  className="flex items-center justify-between rounded-md border p-2 text-sm hover:bg-accent"
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium">{d.title}</div>
                    {d.stage ? (
                      <StageBadge name={d.stage.name} color={d.stage.color} className="mt-0.5" />
                    ) : null}
                  </div>
                  <span className="font-mono text-xs">{formatMoney(d.amount)}</span>
                </Link>
              ))}
              {data.deals.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Not the primary contact on any deals.
                </p>
              ) : null}
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
