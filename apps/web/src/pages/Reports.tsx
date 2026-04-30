import { useQuery } from '@tanstack/react-query';
import {
  Bar, BarChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';
import { formatMoney, formatMoneyShort } from '@/lib/utils';

interface PipelineRow {
  stage: string;
  color: string;
  count: number;
  amount: number;
  weighted: number;
}

interface WinLoss { won: number; lost: number; open: number }

interface ConversionRow { stage: string; count: number }

export function Reports() {
  const pipelineQ = useQuery({
    queryKey: ['report', 'pipeline'],
    queryFn: () => api.get<{ data: PipelineRow[] }>('/reports/pipeline'),
  });
  const winLossQ = useQuery({
    queryKey: ['report', 'win-loss'],
    queryFn: () => api.get<WinLoss>('/reports/win-loss'),
  });
  const conversionQ = useQuery({
    queryKey: ['report', 'conversion'],
    queryFn: () => api.get<{ data: ConversionRow[] }>('/reports/conversion'),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
        <p className="text-sm text-muted-foreground">Pipeline, win/loss, conversion.</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Pipeline value by stage</CardTitle>
            <CardDescription>Total + weighted by probability.</CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={pipelineQ.data?.data ?? []}>
                <XAxis dataKey="stage" tickLine={false} axisLine={false} fontSize={12} />
                <YAxis tickFormatter={formatMoneyShort} tickLine={false} axisLine={false} fontSize={12} width={60} />
                <Tooltip
                  contentStyle={{ background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', borderRadius: 8 }}
                  formatter={(v: number) => formatMoney(v)}
                />
                <Bar dataKey="amount" radius={[4, 4, 0, 0]}>
                  {(pipelineQ.data?.data ?? []).map((r, i) => (
                    <Cell key={i} fill={r.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Win / loss</CardTitle>
            <CardDescription>All-time outcomes.</CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Tooltip />
                <Pie
                  data={[
                    { name: 'Won', value: winLossQ.data?.won ?? 0, fill: '#10b981' },
                    { name: 'Lost', value: winLossQ.data?.lost ?? 0, fill: '#ef4444' },
                    { name: 'Open', value: winLossQ.data?.open ?? 0, fill: '#6366f1' },
                  ]}
                  dataKey="value"
                  innerRadius={60}
                  outerRadius={100}
                  label
                />
              </PieChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Conversion funnel</CardTitle>
            <CardDescription>Deal counts by stage.</CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={conversionQ.data?.data ?? []} layout="vertical">
                <XAxis type="number" tickLine={false} axisLine={false} fontSize={12} />
                <YAxis dataKey="stage" type="category" tickLine={false} axisLine={false} fontSize={12} width={100} />
                <Tooltip />
                <Bar dataKey="count" fill="hsl(var(--primary))" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
