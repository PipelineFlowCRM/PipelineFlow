import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Trash2 } from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api } from '@/lib/api';
import type { CompanyDto, ContactDto } from '@/types';
import { initials } from '@/lib/utils';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/ConfirmDialog';

export function ContactDetail() {
  const { id } = useParams<{ id: string }>();
  const contactId = Number(id);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const { data } = useQuery({
    queryKey: ['contact', contactId],
    queryFn: () => api.get<{ contact: ContactDto }>(`/contacts/${contactId}`),
    enabled: Number.isFinite(contactId),
  });
  const { data: companies } = useQuery({
    queryKey: ['companies', 'all'],
    queryFn: () => api.get<{ companies: CompanyDto[] }>('/companies'),
  });

  const updateMut = useMutation({
    mutationFn: (patch: Partial<ContactDto>) => api.patch(`/contacts/${contactId}`, patch),
    onSuccess: () => { toast.success('Saved'); qc.invalidateQueries({ queryKey: ['contact', contactId] }); },
  });

  const deleteMut = useMutation({
    mutationFn: () => api.delete(`/contacts/${contactId}`),
    onSuccess: () => { toast.success('Contact deleted'); navigate('/contacts'); },
  });

  if (!data) return <div className="text-sm text-muted-foreground">Loading…</div>;
  const c = data.contact;
  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <Link to="/contacts" className="mb-2 inline-flex items-center text-xs text-muted-foreground hover:text-foreground">
            <ArrowLeft className="mr-1 h-3 w-3" /> Back
          </Link>
          <div className="flex items-center gap-3">
            <Avatar className="h-10 w-10"><AvatarFallback>{initials(c.fullName)}</AvatarFallback></Avatar>
            <h1 className="text-2xl font-semibold tracking-tight">{c.fullName}</h1>
          </div>
        </div>
        <Button variant="outline" onClick={() => setConfirmDelete(true)}><Trash2 /> Delete</Button>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${c.fullName}?`}
        description="This removes the contact. Deals that referenced them stay but lose the reference."
        confirmLabel="Delete contact"
        busy={deleteMut.isPending}
        onConfirm={() => deleteMut.mutate()}
      />

      <Card>
        <CardHeader><CardTitle className="text-base">Details</CardTitle></CardHeader>
        <CardContent>
          <Form contact={c} companies={companies?.companies ?? []} onSave={(p) => updateMut.mutate(p)} saving={updateMut.isPending} />
        </CardContent>
      </Card>
    </div>
  );
}

function Form({
  contact, companies, onSave, saving,
}: {
  contact: ContactDto;
  companies: CompanyDto[];
  onSave: (p: Partial<ContactDto>) => void;
  saving: boolean;
}) {
  const [form, setForm] = useState<Partial<ContactDto>>(contact);
  const set = <K extends keyof ContactDto>(k: K, v: ContactDto[K]) => setForm((p) => ({ ...p, [k]: v }));
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => { e.preventDefault(); onSave(form); }}
    >
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1.5"><Label>First name</Label><Input value={form.firstName ?? ''} onChange={(e) => set('firstName', e.target.value)} /></div>
        <div className="space-y-1.5"><Label>Last name</Label><Input value={form.lastName ?? ''} onChange={(e) => set('lastName', e.target.value)} /></div>
        <div className="space-y-1.5"><Label>Email</Label><Input type="email" value={form.email ?? ''} onChange={(e) => set('email', e.target.value)} /></div>
        <div className="space-y-1.5"><Label>Phone</Label><Input value={form.phone ?? ''} onChange={(e) => set('phone', e.target.value)} /></div>
        <div className="space-y-1.5"><Label>Title</Label><Input value={form.title ?? ''} onChange={(e) => set('title', e.target.value)} /></div>
        <div className="space-y-1.5"><Label>LinkedIn</Label><Input value={form.linkedin ?? ''} onChange={(e) => set('linkedin', e.target.value)} /></div>
      </div>
      <div className="space-y-1.5">
        <Label>Company</Label>
        <Select
          value={form.companyId ? String(form.companyId) : 'none'}
          onValueChange={(v) => set('companyId', v === 'none' ? null : Number(v))}
        >
          <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">None</SelectItem>
            {companies.map((c) => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label>Notes</Label>
        <Textarea value={form.notes ?? ''} onChange={(e) => set('notes', e.target.value)} />
      </div>
      <div className="flex justify-end"><Button disabled={saving}>Save</Button></div>
    </form>
  );
}
