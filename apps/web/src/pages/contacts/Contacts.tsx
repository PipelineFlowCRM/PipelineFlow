import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { api } from '@/lib/api';
import type { CompanyDto, ContactDto } from '@/types';
import { initials } from '@/lib/utils';
import { toast } from 'sonner';

export function Contacts() {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['contacts', q],
    queryFn: () => api.get<{ contacts: ContactDto[] }>(`/contacts${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  });
  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Contacts</h1>
          <p className="text-sm text-muted-foreground">{data?.contacts.length ?? '—'} contacts</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button><Plus /> New contact</Button></DialogTrigger>
          <ContactCreateDialog onCreated={() => { setOpen(false); qc.invalidateQueries({ queryKey: ['contacts'] }); }} />
        </Dialog>
      </div>

      <Card>
        <div className="border-b p-3"><Input className="max-w-xs" placeholder="Search contacts…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <CardContent className="p-0">
          <div className="divide-y">
            {data?.contacts.map((c) => (
              <Link key={c.id} to={`/contacts/${c.id}`} className="grid grid-cols-12 items-center gap-3 px-4 py-3 text-sm hover:bg-accent">
                <div className="col-span-5 flex items-center gap-2">
                  <Avatar className="h-8 w-8"><AvatarFallback>{initials(c.fullName)}</AvatarFallback></Avatar>
                  <div className="min-w-0">
                    <div className="truncate font-medium">{c.fullName}</div>
                    <div className="truncate text-xs text-muted-foreground">{c.title ?? '—'}</div>
                  </div>
                </div>
                <div className="col-span-3 truncate text-xs text-muted-foreground">{c.company?.name ?? ''}</div>
                <div className="col-span-2 truncate text-xs text-muted-foreground">{c.email ?? ''}</div>
                <div className="col-span-2 text-right text-xs text-muted-foreground">{c.phone ?? ''}</div>
              </Link>
            ))}
            {data && data.contacts.length === 0 ? <div className="p-8 text-center text-sm text-muted-foreground">No contacts match.</div> : null}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function ContactCreateDialog({ onCreated }: { onCreated: () => void }) {
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [email, setEmail] = useState('');
  const [companyId, setCompanyId] = useState<string>('');
  const { data: companies } = useQuery({
    queryKey: ['companies', 'all'],
    queryFn: () => api.get<{ companies: CompanyDto[] }>('/companies'),
  });
  const mut = useMutation({
    mutationFn: () =>
      api.post('/contacts', {
        firstName: first, lastName: last, email: email || null,
        companyId: companyId ? Number(companyId) : null,
      }),
    onSuccess: () => { toast.success('Contact created'); onCreated(); },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <DialogContent>
      <DialogHeader><DialogTitle>New contact</DialogTitle></DialogHeader>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); mut.mutate(); }}>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2"><Label>First name</Label><Input required value={first} onChange={(e) => setFirst(e.target.value)} /></div>
          <div className="space-y-2"><Label>Last name</Label><Input required value={last} onChange={(e) => setLast(e.target.value)} /></div>
        </div>
        <div className="space-y-2"><Label>Email</Label><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        <div className="space-y-2">
          <Label>Company</Label>
          <Select value={companyId || 'none'} onValueChange={(v) => setCompanyId(v === 'none' ? '' : v)}>
            <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None</SelectItem>
              {companies?.companies.map((c) => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button disabled={!first || !last || mut.isPending}>Create</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
