import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent } from '@/components/ui/card';
import { StageBadge } from '@/components/StageBadge';
import { api } from '@/lib/api';
import type { DealDto, StageDto } from '@/types';
import { formatMoney, relativeTime } from '@/lib/utils';

export function Deals() {
  const [q, setQ] = useState('');
  const [stageId, setStageId] = useState<string>('');
  const [sort, setSort] = useState('updated');

  const { data: stages } = useQuery({
    queryKey: ['stages'],
    queryFn: () => api.get<{ stages: StageDto[] }>('/stages'),
  });

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (stageId) p.set('stageId', stageId);
    p.set('sort', sort);
    return p.toString();
  }, [q, stageId, sort]);

  const { data } = useQuery({
    queryKey: ['deals', params],
    queryFn: () => api.get<{ deals: DealDto[]; totalValue: number }>(`/deals?${params}`),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Deals</h1>
          <p className="text-sm text-muted-foreground">
            {data ? `${data.deals.length} deals · ${formatMoney(data.totalValue)} total` : 'Loading…'}
          </p>
        </div>
        <div className="flex items-center gap-2">
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
            className="max-w-xs"
          />
          <Select value={stageId || 'all'} onValueChange={(v) => setStageId(v === 'all' ? '' : v)}>
            <SelectTrigger className="w-44"><SelectValue placeholder="All stages" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All stages</SelectItem>
              {stages?.stages.map((s) => (
                <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={sort} onValueChange={setSort}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="updated">Recently updated</SelectItem>
              <SelectItem value="amount">Amount (high → low)</SelectItem>
              <SelectItem value="close">Closing soonest</SelectItem>
              <SelectItem value="title">Title (A → Z)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <CardContent className="p-0">
          <div className="divide-y divide-border/60">
            <div className="grid grid-cols-12 gap-3 px-4 py-2 text-[10.5px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
              <div className="col-span-5">Deal</div>
              <div className="col-span-2">Stage</div>
              <div className="col-span-2">Amount</div>
              <div className="col-span-1">Prob</div>
              <div className="col-span-2 text-right">Updated</div>
            </div>
            {data?.deals.map((d) => (
              <Link
                key={d.id}
                to={`/deals/${d.id}`}
                className="grid grid-cols-12 items-center gap-3 px-4 py-3 text-[13px] transition-colors hover:bg-accent/60"
              >
                <div className="col-span-5 min-w-0">
                  <div className="truncate font-medium">{d.title}</div>
                  <div className="truncate text-[11.5px] text-muted-foreground">{d.company?.name ?? '—'}</div>
                </div>
                <div className="col-span-2">
                  {d.stage ? <StageBadge name={d.stage.name} color={d.stage.color} /> : null}
                </div>
                <div className="col-span-2 tabular font-medium">{formatMoney(d.amount)}</div>
                <div className="col-span-1 tabular text-xs text-muted-foreground">{d.probability}%</div>
                <div className="col-span-2 text-right text-xs text-muted-foreground">
                  {relativeTime(d.updatedAt)}
                </div>
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
