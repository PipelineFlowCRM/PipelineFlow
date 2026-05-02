import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import type { ContactDto } from '@/types';
import { initials } from '@/lib/utils';
import { ListToolbar, type BuiltinColumn } from '@/components/customFields/ListToolbar';
import { useListPrefs } from '@/hooks/useListPrefs';
import { useCustomFieldDefinitions } from '@/hooks/useCustomFieldDefinitions';
import { CustomFieldDisplay } from '@/components/customFields/CustomFieldDisplay';
import { CF_KEY_PREFIX } from '@/components/customFields/filterOps';
import { TagFilter } from '@/components/tags/TagFilter';
import { TagsCell } from '@/components/tags/TagsCell';
import { ContactCreateDialog } from './ContactCreateDialog';

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
  const [tagIds, setTagIds] = useState<number[]>([]);
  const [tagOp, setTagOp] = useState<'and' | 'or'>('or');
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
    if (tagIds.length > 0) {
      p.set('tagIds', tagIds.join(','));
      if (tagIds.length > 1) p.set('tagOp', tagOp);
    }
    if (apiFilters.length > 0) p.set('filters', JSON.stringify(apiFilters));
    return p.toString();
  }, [q, tagIds, tagOp, apiFilters]);

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
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">Contacts</h1>
          <p className="text-sm text-muted-foreground">{data?.contacts.length ?? '—'} contacts</p>
        </div>
        <Button onClick={() => setOpen(true)}><Plus /> New contact</Button>
        <ContactCreateDialog
          open={open}
          onOpenChange={setOpen}
          onCreated={() => qc.invalidateQueries({ queryKey: ['contacts'] })}
        />
      </div>

      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <Input
            className="w-full sm:w-auto sm:max-w-xs sm:flex-1"
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
            <TagFilter
              selectedIds={tagIds}
              op={tagOp}
              onChange={(next) => {
                setTagIds(next.ids);
                setTagOp(next.op);
              }}
            />
          </div>
        </div>
        <CardContent className="p-0">
          <div className="divide-y">
            {data?.contacts.map((c) => (
              <Link
                key={c.id}
                to={`/contacts/${c.id}`}
                className="flex items-center gap-3 px-3 py-3 text-sm hover:bg-accent sm:px-4"
              >
                <div className="flex min-w-0 flex-[2] items-center gap-2">
                  <Avatar className="h-8 w-8 shrink-0"><AvatarFallback>{initials(c.fullName)}</AvatarFallback></Avatar>
                  <div className="min-w-0">
                    <div className="truncate font-medium">{c.fullName}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      <span className="sm:hidden">{c.company?.name ?? c.email ?? c.title ?? '—'}</span>
                      <span className="hidden sm:inline">{c.title ?? '—'}</span>
                    </div>
                  </div>
                </div>
                <div className="hidden min-w-0 flex-1 truncate text-xs text-muted-foreground sm:block">{c.company?.name ?? ''}</div>
                <div className="hidden min-w-0 flex-1 truncate text-xs text-muted-foreground md:block">{c.email ?? ''}</div>
                <div className="hidden min-w-0 flex-1 truncate text-xs text-muted-foreground md:block">{c.phone ?? ''}</div>
                <div className="hidden min-w-0 flex-1 lg:block">
                  <TagsCell tags={c.tags} />
                </div>
                {visibleCfDefs.map((f) => (
                  <div key={f.id} className="hidden min-w-0 flex-1 truncate text-xs text-muted-foreground lg:block">
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

