import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { api } from '@/lib/api';
import type { CompanyDto, CustomFieldValuesMap } from '@/types';
import { toast } from 'sonner';
import { CustomFieldsSection } from '@/components/customFields/CustomFieldsSection';
import { ListToolbar, type BuiltinColumn } from '@/components/customFields/ListToolbar';
import { useListPrefs } from '@/hooks/useListPrefs';
import { useCustomFieldDefinitions } from '@/hooks/useCustomFieldDefinitions';
import { CustomFieldDisplay } from '@/components/customFields/CustomFieldDisplay';
import { CF_KEY_PREFIX } from '@/components/customFields/filterOps';

const COMPANY_BUILTIN_COLUMNS: BuiltinColumn[] = [
  { key: 'name', label: 'Name', alwaysOn: true, filterType: 'TEXT' },
  { key: 'industry', label: 'Industry', filterType: 'TEXT' },
  { key: 'size', label: 'Size' },
  { key: 'city', label: 'City', filterType: 'TEXT' },
  { key: 'state', label: 'State', filterType: 'TEXT' },
];

export function Companies() {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const { prefs, setColumns, addFilter, removeFilter } = useListPrefs('COMPANY');
  const { data: cfDefsData } = useCustomFieldDefinitions('COMPANY');
  const cfDefs = cfDefsData?.definitions ?? [];

  const queryString = useMemo(() => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (prefs.filters.length > 0) p.set('filters', JSON.stringify(prefs.filters));
    return p.toString();
  }, [q, prefs.filters]);

  const { data } = useQuery({
    queryKey: ['companies', queryString],
    queryFn: () =>
      api.get<{ companies: CompanyDto[] }>(`/companies${queryString ? `?${queryString}` : ''}`),
  });

  const visibleCfDefs = prefs.columns
    .filter((k) => k.startsWith(CF_KEY_PREFIX))
    .map((k) => cfDefs.find((d) => d.key === k.slice(CF_KEY_PREFIX.length)))
    .filter((d): d is NonNullable<typeof d> => Boolean(d));

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Companies</h1>
          <p className="text-sm text-muted-foreground">{data?.companies.length ?? '—'} companies</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button><Plus /> New company</Button></DialogTrigger>
          <CompanyCreateDialog onCreated={() => { setOpen(false); qc.invalidateQueries({ queryKey: ['companies'] }); }} />
        </Dialog>
      </div>

      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <Input
            className="max-w-xs"
            placeholder="Search companies…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <ListToolbar
            entityType="COMPANY"
            builtinColumns={COMPANY_BUILTIN_COLUMNS}
            visibleColumns={prefs.columns}
            onVisibleColumnsChange={setColumns}
            filters={prefs.filters}
            onAddFilter={addFilter}
            onRemoveFilter={removeFilter}
          />
        </div>
        <CardContent className="p-0">
          <div className="divide-y">
            {data?.companies.map((c) => (
              <Link
                key={c.id}
                to={`/companies/${c.id}`}
                className="flex items-center gap-3 px-4 py-3 text-sm hover:bg-accent"
              >
                <div className="flex min-w-0 flex-[2] items-center gap-2">
                  <div className="grid h-8 w-8 place-items-center rounded-md border bg-muted text-muted-foreground">
                    <Building2 className="h-4 w-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="truncate font-medium">{c.name}</div>
                    <div className="truncate text-xs text-muted-foreground">{c.industry ?? '—'}</div>
                  </div>
                </div>
                <div className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{c.website ?? ''}</div>
                <div className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{c.size ?? ''}</div>
                <div className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {[c.city, c.state].filter(Boolean).join(', ') || '—'}
                </div>
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
            {data && data.companies.length === 0 ? (
              <div className="p-8 text-center text-sm text-muted-foreground">No companies match.</div>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function CompanyCreateDialog({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState('');
  const [website, setWebsite] = useState('');
  const [industry, setIndustry] = useState('');
  const [customFields, setCustomFields] = useState<CustomFieldValuesMap>({});
  const mut = useMutation({
    mutationFn: () =>
      api.post<{ company: CompanyDto }>('/companies', {
        name, website: website || null, industry: industry || null,
        customFields,
      }),
    onSuccess: () => { toast.success('Company created'); onCreated(); },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <DialogContent>
      <DialogHeader><DialogTitle>New company</DialogTitle></DialogHeader>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); mut.mutate(); }}>
        <div className="space-y-2"><Label>Name</Label><Input required value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="space-y-2"><Label>Website</Label><Input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="acme.com" /></div>
        <div className="space-y-2"><Label>Industry</Label><Input value={industry} onChange={(e) => setIndustry(e.target.value)} /></div>
        <CustomFieldsSection
          entityType="COMPANY"
          values={customFields}
          onChange={setCustomFields}
          variant="compact"
        />
        <DialogFooter>
          <Button disabled={!name || mut.isPending}>Create</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
