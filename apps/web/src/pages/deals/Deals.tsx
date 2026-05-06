import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Archive, Plus, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent } from '@/components/ui/card';
import { StageBadge } from '@/components/StageBadge';
import { api } from '@/lib/api';
import type { DealDto, StageDto } from '@/types';
import { cn, formatMoney, relativeTime } from '@/lib/utils';
import { ListToolbar, type BuiltinColumn } from '@/components/customFields/ListToolbar';
import { useListPrefs } from '@/hooks/useListPrefs';
import { useCustomFieldDefinitions } from '@/hooks/useCustomFieldDefinitions';
import { CustomFieldDisplay } from '@/components/customFields/CustomFieldDisplay';
import { CF_KEY_PREFIX } from '@/components/customFields/filterOps';
import { TagFilter } from '@/components/tags/TagFilter';
import { TagsCell } from '@/components/tags/TagsCell';

const DEAL_BUILTIN_COLUMNS: BuiltinColumn[] = [
  { key: 'title', label: 'Title', alwaysOn: true, filterType: 'TEXT' },
  { key: 'amount', label: 'Amount', alwaysOn: true, filterType: 'NUMBER' },
  { key: 'probability', label: 'Probability', filterType: 'NUMBER' },
  { key: 'archivedAt', label: 'Archived', filterType: 'DATE' },
];

export function Deals() {
  const [q, setQ] = useState('');
  const [stageId, setStageId] = useState<string>('');
  const [sort, setSort] = useState('updated');
  const [tagIds, setTagIds] = useState<number[]>([]);
  const [tagOp, setTagOp] = useState<'and' | 'or'>('or');
  const { prefs, setColumns, addFilter, removeFilter } = useListPrefs('DEAL');
  const { data: cfDefsData } = useCustomFieldDefinitions('DEAL');
  const cfDefs = cfDefsData?.definitions ?? [];

  const { data: stages } = useQuery({
    queryKey: ['stages'],
    queryFn: () => api.get<{ stages: StageDto[] }>('/stages'),
  });

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (stageId) p.set('stageId', stageId);
    p.set('sort', sort);
    if (tagIds.length > 0) {
      p.set('tagIds', tagIds.join(','));
      if (tagIds.length > 1) p.set('tagOp', tagOp);
    }
    if (prefs.filters.length > 0) p.set('filters', JSON.stringify(prefs.filters));
    return p.toString();
  }, [q, stageId, sort, tagIds, tagOp, prefs.filters]);

  const { data } = useQuery({
    queryKey: ['deals', params],
    queryFn: () => api.get<{ deals: DealDto[]; totalValue: number }>(`/deals?${params}`),
  });

  const visibleCfDefs = prefs.columns
    .filter((k) => k.startsWith(CF_KEY_PREFIX))
    .map((k) => cfDefs.find((d) => d.key === k.slice(CF_KEY_PREFIX.length)))
    .filter((d): d is NonNullable<typeof d> => Boolean(d));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">Deals</h1>
          <p className="text-sm text-muted-foreground">
            {data ? `${data.deals.length} deals · ${formatMoney(data.totalValue)} total` : 'Loading…'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" asChild>
            <a href="/api/reports/deals.csv">
              <Download /> Export
            </a>
          </Button>
          <Button asChild>
            <Link to="/deals/new"><Plus /> New deal</Link>
          </Button>
        </div>
      </div>

      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <Input
            placeholder="Search title…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="w-full sm:w-auto sm:max-w-xs sm:flex-1"
          />
          <Select value={stageId || 'all'} onValueChange={(v) => setStageId(v === 'all' ? '' : v)}>
            <SelectTrigger className="w-full sm:w-44"><SelectValue placeholder="All stages" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All stages</SelectItem>
              {stages?.stages.map((s) => (
                <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={sort} onValueChange={setSort}>
            <SelectTrigger className="w-full sm:w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="updated">Recently updated</SelectItem>
              <SelectItem value="amount">Amount (high → low)</SelectItem>
              <SelectItem value="close">Closing soonest</SelectItem>
              <SelectItem value="title">Title (A → Z)</SelectItem>
            </SelectContent>
          </Select>
          <ListToolbar
            entityType="DEAL"
            builtinColumns={DEAL_BUILTIN_COLUMNS}
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

        <CardContent className="p-0">
          <div className="divide-y divide-border/60">
            {data?.deals.map((d) => (
              <Link
                key={d.id}
                to={`/deals/${d.id}`}
                className={cn(
                  'flex items-center gap-3 px-3 py-3 text-[13px] transition-colors hover:bg-accent/60 sm:px-4',
                  d.archivedAt && 'bg-muted/40 opacity-70',
                )}
              >
                <div className="min-w-0 flex-[2]">
                  <div className="flex items-center gap-1.5 truncate">
                    <span className="truncate font-medium">{d.title}</span>
                    {d.archivedAt ? (
                      <span
                        className="inline-flex shrink-0 items-center gap-1 rounded-sm border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-900 dark:text-amber-200"
                        title={`Archived ${relativeTime(d.archivedAt)}`}
                      >
                        <Archive className="h-2.5 w-2.5" />
                        Archived
                      </span>
                    ) : null}
                  </div>
                  <div className="truncate text-[11.5px] text-muted-foreground">{d.company?.name ?? '—'}</div>
                  <div className="mt-1 flex items-center gap-2 sm:hidden">
                    {d.stage ? <StageBadge name={d.stage.name} color={d.stage.color} /> : null}
                    <span className="tabular text-[11.5px] font-medium">{formatMoney(d.amount)}</span>
                  </div>
                </div>
                <div className="hidden min-w-0 flex-1 sm:block">
                  {d.stage ? <StageBadge name={d.stage.name} color={d.stage.color} /> : null}
                </div>
                <div className="hidden min-w-0 flex-1 tabular font-medium sm:block">{formatMoney(d.amount)}</div>
                <div className="hidden min-w-0 flex-1 tabular text-xs text-muted-foreground md:block">{d.probability}%</div>
                <div className="hidden min-w-0 flex-1 lg:block">
                  <TagsCell tags={d.tags} />
                </div>
                <div className="hidden min-w-0 flex-1 truncate text-right text-xs text-muted-foreground md:block">
                  {relativeTime(d.updatedAt)}
                </div>
                {visibleCfDefs.map((f) => (
                  <div key={f.id} className="hidden min-w-0 flex-1 truncate text-xs text-muted-foreground lg:block">
                    <CustomFieldDisplay
                      field={f}
                      value={d.customFields?.[f.key]}
                      variant="compact"
                    />
                  </div>
                ))}
              </Link>
            ))}
            {data && data.deals.length === 0 ? (
              <div className="p-8 text-center text-sm text-muted-foreground">No deals match these filters.</div>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
