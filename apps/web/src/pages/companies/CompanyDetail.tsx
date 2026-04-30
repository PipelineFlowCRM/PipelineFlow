import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Building2, ExternalLink, Trash2 } from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { StageBadge } from '@/components/StageBadge';
import { api } from '@/lib/api';
import type { CompanyDto, ContactDto, DealDto } from '@/types';
import { COMPANY_SIZES, US_STATES } from '@pipelineflow/shared';
import { formatMoney, initials } from '@/lib/utils';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/ConfirmDialog';

interface CompanyResponse {
  company: CompanyDto;
  contacts: ContactDto[];
  deals: DealDto[];
}

export function CompanyDetail() {
  const { id } = useParams<{ id: string }>();
  const companyId = Number(id);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const { data } = useQuery({
    queryKey: ['company', companyId],
    queryFn: () => api.get<CompanyResponse>(`/companies/${companyId}`),
    enabled: Number.isFinite(companyId),
  });

  const updateMut = useMutation({
    mutationFn: (patch: Partial<CompanyDto>) => api.patch(`/companies/${companyId}`, patch),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['company', companyId] }); toast.success('Saved'); },
  });

  const deleteMut = useMutation({
    mutationFn: () => api.delete(`/companies/${companyId}`),
    onSuccess: () => { toast.success('Company deleted'); navigate('/companies'); },
  });

  if (!data) return <div className="text-sm text-muted-foreground">Loading…</div>;
  const c = data.company;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <Link to="/companies" className="mb-2 inline-flex items-center text-xs text-muted-foreground hover:text-foreground">
            <ArrowLeft className="mr-1 h-3 w-3" /> Back
          </Link>
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-md border bg-muted">
              <Building2 className="h-5 w-5 text-muted-foreground" />
            </div>
            <h1 className="text-2xl font-semibold tracking-tight">{c.name}</h1>
          </div>
        </div>
        <Button variant="outline" onClick={() => setConfirmDelete(true)}><Trash2 /> Delete</Button>
      </div>

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
        <Card>
          <CardHeader><CardTitle className="text-base">Details</CardTitle></CardHeader>
          <CardContent>
            <CompanyForm company={c} onSave={(patch) => updateMut.mutate(patch)} saving={updateMut.isPending} />
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle className="text-base">Deals ({data.deals.length})</CardTitle></CardHeader>
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
            <CardHeader><CardTitle className="text-base">Contacts ({data.contacts.length})</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {data.contacts.map((p) => (
                <Link key={p.id} to={`/contacts/${p.id}`} className="flex items-center gap-2 rounded-md border p-2 text-sm hover:bg-accent">
                  <Avatar className="h-7 w-7"><AvatarFallback>{initials(p.fullName)}</AvatarFallback></Avatar>
                  <div className="min-w-0">
                    <div className="truncate font-medium">{p.fullName}</div>
                    <div className="truncate text-xs text-muted-foreground">{p.title ?? p.email ?? ''}</div>
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

function CompanyForm({
  company, onSave, saving,
}: {
  company: CompanyDto;
  onSave: (patch: Partial<CompanyDto>) => void;
  saving: boolean;
}) {
  const [form, setForm] = useState<Partial<CompanyDto>>(company);
  const set = <K extends keyof CompanyDto>(k: K, v: CompanyDto[K]) => setForm((p) => ({ ...p, [k]: v }));

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => { e.preventDefault(); onSave(form); }}
    >
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1.5"><Label>Name</Label><Input value={form.name ?? ''} onChange={(e) => set('name', e.target.value)} /></div>
        <div className="space-y-1.5"><Label>Industry</Label><Input value={form.industry ?? ''} onChange={(e) => set('industry', e.target.value)} /></div>
        <div className="space-y-1.5"><Label>Website</Label><Input value={form.website ?? ''} onChange={(e) => set('website', e.target.value)} /></div>
        <div className="space-y-1.5"><Label>Phone</Label><Input value={form.phone ?? ''} onChange={(e) => set('phone', e.target.value)} /></div>
        <div className="space-y-1.5">
          <Label>Size</Label>
          <Select value={form.size ?? 'unset'} onValueChange={(v) => set('size', v === 'unset' ? null : v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="unset">—</SelectItem>
              {COMPANY_SIZES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="space-y-1.5">
        <Label>Address line 1</Label>
        <Input value={form.addressLine1 ?? ''} onChange={(e) => set('addressLine1', e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label>Address line 2</Label>
        <Input value={form.addressLine2 ?? ''} onChange={(e) => set('addressLine2', e.target.value)} />
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <div className="space-y-1.5"><Label>City</Label><Input value={form.city ?? ''} onChange={(e) => set('city', e.target.value)} /></div>
        <div className="space-y-1.5">
          <Label>State</Label>
          <Select value={form.state ?? 'unset'} onValueChange={(v) => set('state', v === 'unset' ? null : v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="unset">—</SelectItem>
              {US_STATES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5"><Label>ZIP</Label><Input value={form.postalCode ?? ''} onChange={(e) => set('postalCode', e.target.value)} /></div>
      </div>
      <div className="space-y-1.5">
        <Label>Notes</Label>
        <Textarea value={form.notes ?? ''} onChange={(e) => set('notes', e.target.value)} />
      </div>
      <div className="flex justify-end gap-2">
        {form.website ? (
          <Button asChild variant="outline" type="button">
            <a href={form.website.startsWith('http') ? form.website : `https://${form.website}`} target="_blank" rel="noreferrer">
              <ExternalLink /> Visit site
            </a>
          </Button>
        ) : null}
        <Button disabled={saving}>Save</Button>
      </div>
    </form>
  );
}
