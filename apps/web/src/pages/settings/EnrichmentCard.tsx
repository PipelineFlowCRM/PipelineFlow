import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Sparkles, AlertTriangle, BarChart3 } from 'lucide-react';
import { toast } from 'sonner';
import type {
  EnrichmentSettings,
  EnrichmentSettingsUpdate,
  EnrichmentUsageDto,
} from '@pipelineflow/shared';
import { api, ApiError } from '@/lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';

interface EnrichmentSettingsResponse {
  settings: EnrichmentSettings;
  usage: EnrichmentUsageDto;
  configured: boolean;
  model: string;
}

function formatApiError(e: unknown, fallback = 'Request failed'): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return fallback;
}

export function EnrichmentCard() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery<EnrichmentSettingsResponse>({
    queryKey: ['enrichment', 'settings'],
    queryFn: () => api.get<EnrichmentSettingsResponse>('/enrichment/settings'),
    retry: false,
  });

  const update = useMutation({
    mutationFn: (patch: EnrichmentSettingsUpdate) =>
      api.patch<EnrichmentSettingsResponse>('/enrichment/settings', patch),
    onSuccess: (resp) => {
      qc.setQueryData(['enrichment', 'settings'], resp);
      toast.success('Settings saved');
    },
    onError: (e) => toast.error(formatApiError(e, 'Could not save settings')),
  });

  const ping = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; model: string; stopReason: string }>('/enrichment/ping'),
    onSuccess: (r) => toast.success(`Connected to Anthropic — model ${r.model}`),
    onError: (e) => toast.error(formatApiError(e, 'Anthropic ping failed')),
  });

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">Loading…</div>;
  }
  if (error || !data) {
    return (
      <div className="text-sm text-destructive">
        Could not load enrichment settings: {formatApiError(error)}
      </div>
    );
  }

  const { settings, usage, configured, model } = data;
  const remaining = Math.max(0, usage.cap - usage.count);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="h-4 w-4" /> Company enrichment
        </CardTitle>
        <CardDescription>
          Use Claude to fill in industry, size, address, and a short summary on company
          records. Auto-runs on create / import or on demand from the company page.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {!configured ? (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 text-amber-600" />
            <div>
              <div className="font-medium">Anthropic isn&apos;t configured on this server.</div>
              <div className="text-muted-foreground">
                Set <code className="rounded bg-muted px-1">ANTHROPIC_API_KEY</code> in your env
                and restart the api + worker. You can pre-stage the toggles below — they take
                effect once the key is present.
              </div>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between rounded-md bg-muted/40 px-3 py-2 text-sm">
            <div className="flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-muted-foreground" />
              <span>
                Today: <strong>{usage.count}</strong> / {usage.cap} runs (
                {remaining} remaining)
              </span>
            </div>
            <div className="text-xs text-muted-foreground">Model: {model}</div>
          </div>
        )}

        <Toggle
          id="enrichment-enabled"
          label="Enable enrichment"
          description="Master switch. When off, no enrichment runs (auto or manual)."
          checked={settings.enabled}
          onChange={(v) => update.mutate({ enabled: v })}
          disabled={update.isPending}
        />
        <Toggle
          id="enrichment-auto-create"
          label="Auto-enrich new companies"
          description="Run automatically when a company is created via the UI or quick-add."
          checked={settings.autoOnCreate}
          onChange={(v) => update.mutate({ autoOnCreate: v })}
          disabled={!settings.enabled || update.isPending}
        />
        <Toggle
          id="enrichment-auto-import"
          label="Auto-enrich on CSV import"
          description="Run for each new company created via /settings/import. Off by default — large imports can fan out hundreds of LLM calls."
          checked={settings.autoOnImport}
          onChange={(v) => update.mutate({ autoOnImport: v })}
          disabled={!settings.enabled || update.isPending}
        />

        <div className="space-y-2">
          <Label className="text-sm font-medium">Mode</Label>
          <div className="grid gap-2 sm:grid-cols-2">
            <ModeOption
              id="mode-structured"
              title="Structured (cheaper)"
              description="One Claude call per company. Best for accurate data when you have the company website on file."
              selected={settings.mode === 'structured'}
              disabled={!settings.enabled || update.isPending}
              onSelect={() => update.mutate({ mode: 'structured' })}
            />
            <ModeOption
              id="mode-agentic"
              title="Agentic (better quality)"
              description="Claude searches the web and follows links. Costs more per call but handles companies you only have a name for."
              selected={settings.mode === 'agentic'}
              disabled={!settings.enabled || update.isPending}
              onSelect={() => update.mutate({ mode: 'agentic' })}
            />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField
            id="debounce-days"
            label="Debounce window (days)"
            description="Skip auto-enrichment when the company was already enriched within this many days."
            value={settings.debounceDays}
            onCommit={(n) => update.mutate({ debounceDays: n })}
            min={0}
            max={365}
            disabled={!settings.enabled || update.isPending}
          />
          <NumberField
            id="daily-cap"
            label="Daily run cap"
            description="Maximum enrichments per UTC day. Above this, additional jobs land as 'skipped'."
            value={settings.dailyCap}
            onCommit={(n) => update.mutate({ dailyCap: n })}
            min={0}
            max={10000}
            disabled={!settings.enabled || update.isPending}
          />
        </div>

        <div className="flex items-center justify-end gap-2 pt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => ping.mutate()}
            disabled={!configured || ping.isPending}
          >
            {ping.isPending ? 'Pinging…' : 'Test connection'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

interface ToggleProps {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}
function Toggle({ id, label, description, checked, onChange, disabled }: ToggleProps) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-1">
        <Label htmlFor={id} className="text-sm font-medium">
          {label}
        </Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}

interface ModeOptionProps {
  id: string;
  title: string;
  description: string;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
}
function ModeOption({ id, title, description, selected, disabled, onSelect }: ModeOptionProps) {
  return (
    <button
      type="button"
      id={id}
      disabled={disabled}
      onClick={onSelect}
      className={`rounded-md border p-3 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        selected
          ? 'border-primary bg-primary/5'
          : 'border-border hover:border-primary/40 hover:bg-muted/40'
      }`}
    >
      <div className="font-medium">{title}</div>
      <div className="mt-1 text-xs text-muted-foreground">{description}</div>
    </button>
  );
}

interface NumberFieldProps {
  id: string;
  label: string;
  description: string;
  value: number;
  onCommit: (n: number) => void;
  min: number;
  max: number;
  disabled?: boolean;
}
function NumberField({ id, label, description, value, onCommit, min, max, disabled }: NumberFieldProps) {
  const [draft, setDraft] = useState(String(value));
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-sm font-medium">
        {label}
      </Label>
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const n = parseInt(draft, 10);
          if (Number.isFinite(n) && n >= min && n <= max && n !== value) {
            onCommit(n);
          } else {
            setDraft(String(value));
          }
        }}
      />
      <p className="text-xs text-muted-foreground">{description}</p>
    </div>
  );
}
