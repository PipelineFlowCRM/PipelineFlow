import { useMemo, useState } from 'react';
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
import type { CompanyDto, ContactDto, CustomFieldValuesMap } from '@/types';
import { initials } from '@/lib/utils';
import { toast } from 'sonner';
import { CustomFieldsSection } from '@/components/customFields/CustomFieldsSection';
import { ListToolbar, type BuiltinColumn } from '@/components/customFields/ListToolbar';
import { useListPrefs } from '@/hooks/useListPrefs';
import { useCustomFieldDefinitions } from '@/hooks/useCustomFieldDefinitions';
import { CustomFieldDisplay } from '@/components/customFields/CustomFieldDisplay';
import { CF_KEY_PREFIX } from '@/components/customFields/filterOps';

const CONTACT_BUILTIN_COLUMNS: BuiltinColumn[] = [
  { key: 'fullName', label: 'Name', alwaysOn: true, filterType: 'TEXT' },
  { key: 'company', label: 'Company', alwaysOn: true },
  { key: 'email', label: 'Email', filterType: 'EMAIL' },
  { key: 'phone', label: 'Phone', filterType: 'PHONE' },
  { key: 'title', label: 'Title', filterType: 'TEXT' },
];

// Built-in columns that map directly to the entity's filter field name (the
// API's listFilters whitelist uses `firstName`/`lastName` rather than the
// derived `fullName`). `name` here also acts as the search proxy.
const BUILTIN_FILTER_KEY_MAP: Record<string, string> = {
  fullName: 'firstName',
};

export function Contacts() {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const { prefs, setColumns, addFilter, removeFilter } = useListPrefs('CONTACT');
  const { data: cfDefsData } = useCustomFieldDefinitions('CONTACT');
  const cfDefs = cfDefsData?.definitions ?? [];

  const apiFilters = useMemo(() => {
    return prefs.filters.map((f) => ({
      ...f,
      key: BUILTIN_FILTER_KEY_MAP[f.key] ?? f.key,
    }));
  }, [prefs.filters]);

  const queryString = useMemo(() => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (apiFilters.length > 0) p.set('filters', JSON.stringify(apiFilters));
    return p.toString();
  }, [q, apiFilters]);

  const { data } = useQuery({
    queryKey: ['contacts', queryString],
    queryFn: () =>
      api.get<{ contacts: ContactDto[] }>(`/contacts${queryString ? `?${queryString}` : ''}`),
  });

  const visibleCfKeys = prefs.columns.filter((k) => k.startsWith(CF_KEY_PREFIX));
  const visibleCfDefs = visibleCfKeys
    .map((k) => cfDefs.find((d) => d.key === k.slice(CF_KEY_PREFIX.length)))
    .filter((d): d is NonNullable<typeof d> => Boolean(d));

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
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <Input
            className="max-w-xs"
            placeholder="Search contacts…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <ListToolbar
              entityType="CONTACT"
              builtinColumns={CONTACT_BUILTIN_COLUMNS}
              visibleColumns={prefs.columns}
              onVisibleColumnsChange={setColumns}
              filters={prefs.filters}
              onAddFilter={addFilter}
              onRemoveFilter={removeFilter}
            />
          </div>
        </div>
        <CardContent className="p-0">
          <div className="divide-y">
            {data?.contacts.map((c) => (
              <Link
                key={c.id}
                to={`/contacts/${c.id}`}
                className="flex items-center gap-3 px-4 py-3 text-sm hover:bg-accent"
              >
                <div className="flex min-w-0 flex-[2] items-center gap-2">
                  <Avatar className="h-8 w-8"><AvatarFallback>{initials(c.fullName)}</AvatarFallback></Avatar>
                  <div className="min-w-0">
                    <div className="truncate font-medium">{c.fullName}</div>
                    <div className="truncate text-xs text-muted-foreground">{c.title ?? '—'}</div>
                  </div>
                </div>
                <div className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{c.company?.name ?? ''}</div>
                <div className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{c.email ?? ''}</div>
                <div className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{c.phone ?? ''}</div>
                {visibleCfDefs.map((f) => (
                  <div key={f.id} className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                    <CustomFieldDisplay
                      field={f}
                      value={c.customFields?.[f.key]}
                      variant="compact"
                    />
                  </div>
                ))}
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
  const [customFields, setCustomFields] = useState<CustomFieldValuesMap>({});
  const { data: companies } = useQuery({
    queryKey: ['companies', 'all'],
    queryFn: () => api.get<{ companies: CompanyDto[] }>('/companies'),
  });
  const mut = useMutation({
    mutationFn: () =>
      api.post('/contacts', {
        firstName: first, lastName: last, email: email || null,
        companyId: companyId ? Number(companyId) : null,
        customFields,
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
        <CustomFieldsSection
          entityType="CONTACT"
          values={customFields}
          onChange={setCustomFields}
          variant="compact"
        />
        <DialogFooter>
          <Button disabled={!first || !last || mut.isPending}>Create</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
