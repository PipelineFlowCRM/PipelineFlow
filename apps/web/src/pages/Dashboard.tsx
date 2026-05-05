import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Calendar, Check, Clock, DollarSign, TrendingUp } from 'lucide-react';
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { StageBadge } from '@/components/StageBadge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { api } from '@/lib/api';
import { formatMoney, formatMoneyShort, initials, relativeTime } from '@/lib/utils';
import type { ActivityDto, DealDto, TaskDto } from '@/types';

interface DashboardData {
  kpis: {
    openCount: number;
    openValue: number;
    weightedValue: number;
    wonCount: number;
    wonValue: number;
    lostCount: number;
    winRate: number;
  };
  byStage: { id: number; name: string; color: string; count: number; amount: number }[];
  overdueTasks: TaskDto[];
  myTasks: TaskDto[];
  recentActivity: ActivityDto[];
  recentDeals: DealDto[];
}

export function Dashboard() {
  const { data } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.get<DashboardData>('/dashboard'),
  });

  if (!data) return <div className="text-sm text-muted-foreground">Loading…</div>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">A snapshot of your pipeline.</p>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Kpi
          icon={<DollarSign className="h-4 w-4" />}
          label="Open value"
          value={formatMoney(data.kpis.openValue)}
          sub={`${data.kpis.openCount} deals`}
        />
        <Kpi
          icon={<TrendingUp className="h-4 w-4" />}
          label="Weighted"
          value={formatMoney(data.kpis.weightedValue)}
          sub="probability-weighted"
          accent
        />
        <Kpi
          icon={<Check className="h-4 w-4" />}
          label="Won"
          value={formatMoney(data.kpis.wonValue)}
          sub={`${data.kpis.wonCount} deals`}
        />
        <Kpi
          icon={<TrendingUp className="h-4 w-4" />}
          label="Win rate"
          value={`${(data.kpis.winRate * 100).toFixed(0)}%`}
          sub={`${data.kpis.wonCount}W / ${data.kpis.lostCount}L`}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Pipeline value by stage</CardTitle>
            <CardDescription>Sum of deal amounts per stage.</CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={data.byStage}>
                <XAxis dataKey="name" tickLine={false} axisLine={false} fontSize={12} />
                <YAxis tickFormatter={formatMoneyShort} tickLine={false} axisLine={false} fontSize={12} width={60} />
                <Tooltip
                  contentStyle={{ background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', borderRadius: 8 }}
                  formatter={(v: number) => formatMoney(v)}
                />
                <Bar dataKey="amount" radius={[4, 4, 0, 0]}>
                  {data.byStage.map((s) => (
                    <Cell key={s.id} fill={s.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>My tasks</CardTitle>
            <CardDescription>Open tasks assigned to you.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {data.myTasks.length === 0 ? (
              <p className="text-sm text-muted-foreground">No open tasks. Nice.</p>
            ) : (
              data.myTasks.slice(0, 6).map((t) => (
                <div key={t.id} className="flex items-start gap-2 rounded-md border p-2 text-sm">
                  <Clock className="mt-0.5 h-4 w-4 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{t.title}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {t.deal ? (
                        <Link to={`/deals/${t.deal.id}`} className="hover:underline">
                          {t.deal.title}
                        </Link>
                      ) : null}
                      {t.dueDate ? <span className="ml-2">due {t.dueDate}</span> : null}
                    </div>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle>Recent deals</CardTitle>
              <CardDescription>Most recently updated.</CardDescription>
            </div>
            <Link to="/deals" className="text-sm text-muted-foreground hover:text-foreground">
              View all <ArrowUpRight className="ml-1 inline h-3 w-3" />
            </Link>
          </CardHeader>
          <CardContent className="space-y-2">
            {data.recentDeals.map((d) => (
              <Link
                key={d.id}
                to={`/deals/${d.id}`}
                className="flex items-center justify-between rounded-md border p-3 text-sm transition-colors hover:bg-accent"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium">{d.title}</div>
                  <div className="truncate text-xs text-muted-foreground">{d.company?.name ?? '—'}</div>
                </div>
                <div className="flex items-center gap-3">
                  {d.stage ? <StageBadge name={d.stage.name} color={d.stage.color} /> : null}
                  <div className="font-mono text-xs">{formatMoney(d.amount)}</div>
                </div>
              </Link>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent activity</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {data.recentActivity.slice(0, 8).map((a) => (
              <div key={a.id} className="flex items-start gap-3 text-sm">
                <Avatar className="h-7 w-7">
                  {a.actor?.avatarUrl ? <AvatarImage src={a.actor.avatarUrl} alt={a.actor.name} /> : null}
                  <AvatarFallback color={a.actor?.avatarColor ?? '#94a3b8'}>
                    {initials(a.actor?.name ?? '?')}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <div className="truncate">
                    <span className="font-medium">{a.actor?.name ?? 'System'}</span>{' '}
                    <span className="text-muted-foreground">{a.summary}</span>
                  </div>
                  <div className="text-xs text-muted-foreground">{relativeTime(a.createdAt)}</div>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {data.overdueTasks.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Overdue tasks</CardTitle>
              <Badge variant="destructive">{data.overdueTasks.length}</Badge>
            </div>
          </CardHeader>
          <CardContent className="grid gap-2 md:grid-cols-2">
            {data.overdueTasks.map((t) => (
              <div key={t.id} className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-sm">
                <Calendar className="mt-0.5 h-4 w-4 text-destructive" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{t.title}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {t.deal ? (
                      <Link to={`/deals/${t.deal.id}`} className="hover:underline">
                        {t.deal.title}
                      </Link>
                    ) : null}
                    <span className="ml-2 text-destructive">due {t.dueDate}</span>
                  </div>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Kpi({
  icon, label, value, sub, accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <Card className={accent ? 'relative overflow-hidden ring-brand' : 'shadow-soft'}>
      {accent ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-60"
          style={{ background: 'var(--gradient-mesh)' }}
        />
      ) : null}
      <CardContent className="relative p-4">
        <div className="flex items-center justify-between">
          <div className="text-[10.5px] font-medium uppercase tracking-[0.08em] text-muted-foreground">{label}</div>
          <div className={accent ? 'text-brand' : 'text-muted-foreground'}>{icon}</div>
        </div>
        <div
          className={`mt-2 text-2xl font-semibold tracking-tight tabular ${accent ? 'text-gradient' : ''}`}
        >
          {value}
        </div>
        {sub ? <div className="mt-1 text-[11px] text-muted-foreground">{sub}</div> : null}
      </CardContent>
    </Card>
  );
}
