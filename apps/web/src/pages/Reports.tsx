import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Bar, BarChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { Map, Marker, NavigationControl, Popup } from 'react-map-gl/mapbox';
import { ExternalLink } from 'lucide-react';
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

interface CompanyMapPin {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
}

const MAPBOX_TOKEN = (import.meta.env.MAPBOX_API_TOKEN as string | undefined) ?? '';
// Geographic center of the contiguous US — roughly Lebanon, Kansas.
const US_CENTER = { longitude: -98.58, latitude: 39.83, zoom: 3.3 };

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
  const mapQ = useQuery({
    queryKey: ['report', 'company-map'],
    queryFn: () => api.get<{ companies: CompanyMapPin[] }>('/companies/map'),
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

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Company locations</CardTitle>
            <CardDescription>All geocoded companies. Click a pin for details.</CardDescription>
          </CardHeader>
          <CardContent>
            <CompanyMapCard companies={mapQ.data?.companies ?? []} loading={mapQ.isLoading} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function CompanyMapCard({
  companies,
  loading,
}: {
  companies: CompanyMapPin[];
  loading: boolean;
}) {
  // popup is keyed by companyId. Mapbox marker clicks bubble to the map by
  // default, which would close the popup we just opened — `originalEvent
  // .stopPropagation()` in the click handler keeps the popup alive.
  const [selectedId, setSelectedId] = useState<number | null>(null);

  if (!MAPBOX_TOKEN) {
    return (
      <div className="rounded-md border bg-muted/40 p-4 text-xs text-muted-foreground">
        Set <code className="rounded bg-muted px-1 py-0.5">MAPBOX_API_TOKEN</code>{' '}
        to display the map.
      </div>
    );
  }
  if (loading) {
    return <div className="h-[520px] animate-pulse rounded-md bg-muted" />;
  }
  if (companies.length === 0) {
    return (
      <div className="rounded-md border bg-muted/40 p-4 text-sm text-muted-foreground">
        No companies geocoded yet. Open a company and click "Geocode address".
      </div>
    );
  }

  const selected = companies.find((c) => c.id === selectedId) ?? null;

  return (
    <div className="overflow-hidden rounded-md border" style={{ height: 520 }}>
      <Map
        mapboxAccessToken={MAPBOX_TOKEN}
        initialViewState={US_CENTER}
        mapStyle="mapbox://styles/mapbox/light-v11"
      >
        <NavigationControl position="top-right" showCompass={false} />
        {companies.map((c) => (
          <Marker
            key={c.id}
            longitude={c.longitude}
            latitude={c.latitude}
            color="#6366f1"
            onClick={(e) => {
              e.originalEvent.stopPropagation();
              setSelectedId(c.id);
            }}
          />
        ))}
        {selected ? (
          <Popup
            longitude={selected.longitude}
            latitude={selected.latitude}
            onClose={() => setSelectedId(null)}
            closeOnClick={false}
            anchor="bottom"
            offset={28}
          >
            <div className="space-y-1 text-sm">
              <div className="font-semibold text-foreground">{selected.name}</div>
              <a
                href={`/companies/${selected.id}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                Open company <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          </Popup>
        ) : null}
      </Map>
    </div>
  );
}
