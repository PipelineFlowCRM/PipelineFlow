import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Plus, Trash2, RotateCcw, Send, Eye, Check, AlertTriangle, Copy,
} from 'lucide-react';
import { WEBHOOK_EVENT_GROUPS } from '@pipelineflow/shared';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import type { WebhookDeliveryDto, WebhookEndpointDto, WebhookEvent } from '@/types';

type FormState = {
  name: string;
  url: string;
  events: Set<WebhookEvent>;
  customHeaders: { key: string; value: string }[];
  enabled: boolean;
};

const emptyForm = (): FormState => ({
  name: '',
  url: '',
  events: new Set(),
  customHeaders: [],
  enabled: true,
});

const truncateUrl = (url: string, max = 48) =>
  url.length <= max ? url : `${url.slice(0, max - 1)}…`;

// Pulls Zod field errors out of an ApiError so the toast shows the actual
// rule that fired (e.g. "Cannot override X-PipelineFlow-* headers") instead
// of the generic "Validation failed" the API returns at the top level.
function formatApiError(e: unknown, fallback = 'Request failed'): string {
  if (!(e instanceof ApiError)) return e instanceof Error ? e.message : fallback;
  const details = e.details as { fields?: Record<string, string[]> } | undefined;
  const fields = details?.fields;
  if (fields) {
    const parts: string[] = [];
    for (const [key, msgs] of Object.entries(fields)) {
      if (Array.isArray(msgs) && msgs.length > 0) {
        parts.push(`${key}: ${msgs.join(', ')}`);
      }
    }
    if (parts.length > 0) return parts.join(' — ');
  }
  return e.message;
}

export function WebhooksCard() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['webhooks', 'endpoints'],
    queryFn: () => api.get<{ endpoints: WebhookEndpointDto[] }>('/webhooks/endpoints'),
  });

  const [editing, setEditing] = useState<WebhookEndpointDto | 'new' | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [rotatingId, setRotatingId] = useState<number | null>(null);
  const [viewingDeliveriesFor, setViewingDeliveriesFor] = useState<WebhookEndpointDto | null>(null);
  const [secretReveal, setSecretReveal] = useState<{ secret: string; rotated: boolean } | null>(null);

  const enableMut = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      api.patch<{ endpoint: WebhookEndpointDto }>(`/webhooks/endpoints/${id}`, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['webhooks', 'endpoints'] }),
    onError: (e) => toast.error((e as Error).message),
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => api.delete(`/webhooks/endpoints/${id}`),
    onSuccess: () => {
      toast.success('Endpoint deleted');
      qc.invalidateQueries({ queryKey: ['webhooks', 'endpoints'] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const testMut = useMutation({
    mutationFn: (id: number) =>
      api.post<{ deliveryId: number }>(`/webhooks/endpoints/${id}/test`),
    onSuccess: () => toast.success('Test event queued'),
    onError: (e) => toast.error((e as Error).message),
  });

  const rotateMut = useMutation({
    mutationFn: (id: number) =>
      api.post<{ endpoint: WebhookEndpointDto }>(`/webhooks/endpoints/${id}/rotate-secret`),
    onSuccess: ({ endpoint }) => {
      qc.invalidateQueries({ queryKey: ['webhooks', 'endpoints'] });
      if (endpoint.secret) {
        setSecretReveal({ secret: endpoint.secret, rotated: true });
      }
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle>Webhooks</CardTitle>
            <CardDescription>
              Send signed event payloads to external URLs when deals, companies,
              contacts, or tasks change. Each delivery is HMAC-signed with the
              endpoint's secret.
            </CardDescription>
          </div>
          <Button size="sm" onClick={() => setEditing('new')}>
            <Plus /> New endpoint
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {data?.endpoints.length === 0 ? (
          <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
            No webhook endpoints configured yet.
          </p>
        ) : null}
        {data?.endpoints.map((ep) => (
          <div
            key={ep.id}
            className="flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:gap-3"
          >
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex items-center gap-2">
                <span className="truncate font-medium">{ep.name}</span>
                <Badge variant={ep.enabled ? 'default' : 'secondary'} className="shrink-0">
                  {ep.enabled ? 'Enabled' : 'Disabled'}
                </Badge>
                {ep.disabledReason ? (
                  <span
                    className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400"
                    title={ep.disabledReason}
                  >
                    <AlertTriangle className="h-3.5 w-3.5" /> auto-disabled
                  </span>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span className="truncate font-mono">{truncateUrl(ep.url)}</span>
                <span>·</span>
                <span>{ep.events.length} event{ep.events.length === 1 ? '' : 's'}</span>
                {ep.consecutiveFailures > 0 ? (
                  <>
                    <span>·</span>
                    <span className="text-amber-600 dark:text-amber-400">
                      {ep.consecutiveFailures} consecutive fail{ep.consecutiveFailures === 1 ? '' : 's'}
                    </span>
                  </>
                ) : null}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Switch
                checked={ep.enabled}
                onCheckedChange={(checked) => enableMut.mutate({ id: ep.id, enabled: checked })}
                aria-label={`Toggle ${ep.name}`}
              />
              <Button
                size="icon"
                variant="ghost"
                title="View deliveries"
                onClick={() => setViewingDeliveriesFor(ep)}
              >
                <Eye />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                title="Send test event"
                disabled={!ep.enabled || testMut.isPending}
                onClick={() => testMut.mutate(ep.id)}
              >
                <Send />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                title="Rotate secret"
                onClick={() => setRotatingId(ep.id)}
              >
                <RotateCcw />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setEditing(ep)}
              >
                Edit
              </Button>
              <Button
                size="icon"
                variant="ghost"
                title="Delete"
                onClick={() => setDeletingId(ep.id)}
              >
                <Trash2 />
              </Button>
            </div>
          </div>
        ))}
      </CardContent>

      <EndpointFormDialog
        open={editing != null}
        endpoint={editing === 'new' ? null : editing}
        onOpenChange={(o) => { if (!o) setEditing(null); }}
        onSecretReveal={(secret) => setSecretReveal({ secret, rotated: false })}
      />

      <SecretRevealDialog
        info={secretReveal}
        onClose={() => setSecretReveal(null)}
      />

      <ConfirmDialog
        open={deletingId != null}
        onOpenChange={(o) => { if (!o) setDeletingId(null); }}
        title="Delete this endpoint?"
        description="The endpoint and its delivery history will be removed. This can't be undone."
        confirmLabel="Delete endpoint"
        busy={deleteMut.isPending}
        onConfirm={() => {
          if (deletingId != null) deleteMut.mutate(deletingId);
          setDeletingId(null);
        }}
      />

      <ConfirmDialog
        open={rotatingId != null}
        onOpenChange={(o) => { if (!o) setRotatingId(null); }}
        title="Rotate signing secret?"
        description="The current secret stops working immediately. Update the new secret in your receiver before any subsequent deliveries arrive."
        confirmLabel="Rotate secret"
        destructive={false}
        busy={rotateMut.isPending}
        onConfirm={() => {
          if (rotatingId != null) rotateMut.mutate(rotatingId);
          setRotatingId(null);
        }}
      />

      {viewingDeliveriesFor ? (
        <DeliveriesDialog
          endpoint={viewingDeliveriesFor}
          onClose={() => setViewingDeliveriesFor(null)}
        />
      ) : null}
    </Card>
  );
}

// ─── Endpoint create/edit form ──────────────────────────────────────────────

interface EndpointFormDialogProps {
  open: boolean;
  endpoint: WebhookEndpointDto | null;
  onOpenChange: (open: boolean) => void;
  onSecretReveal: (secret: string) => void;
}

function EndpointFormDialog({ open, endpoint, onOpenChange, onSecretReveal }: EndpointFormDialogProps) {
  const qc = useQueryClient();
  const [form, setForm] = useState<FormState>(emptyForm);

  useEffect(() => {
    if (!open) return;
    if (endpoint) {
      setForm({
        name: endpoint.name,
        url: endpoint.url,
        events: new Set(endpoint.events),
        customHeaders: endpoint.customHeaders
          ? Object.entries(endpoint.customHeaders).map(([key, value]) => ({ key, value }))
          : [],
        enabled: endpoint.enabled,
      });
    } else {
      setForm(emptyForm());
    }
  }, [open, endpoint]);

  const headersObject = useMemo(() => {
    const out: Record<string, string> = {};
    for (const { key, value } of form.customHeaders) {
      const k = key.trim();
      if (k && value !== '') out[k] = value;
    }
    return out;
  }, [form.customHeaders]);

  // Surface the case where the user has typed the same header name twice.
  // We can't safely "merge" them at submit time — we'd silently lose
  // one of the values — so refuse the save instead.
  const duplicateHeaderKey = useMemo(() => {
    const seen = new Map<string, number>();
    for (const { key } of form.customHeaders) {
      const k = key.trim().toLowerCase();
      if (!k) continue;
      const n = (seen.get(k) ?? 0) + 1;
      seen.set(k, n);
      if (n === 2) return key.trim();
    }
    return null;
  }, [form.customHeaders]);

  const buildPayload = () => ({
    name: form.name.trim(),
    url: form.url.trim(),
    events: Array.from(form.events),
    customHeaders: Object.keys(headersObject).length > 0 ? headersObject : null,
    enabled: form.enabled,
  });

  const createMut = useMutation({
    mutationFn: () =>
      api.post<{ endpoint: WebhookEndpointDto }>('/webhooks/endpoints', buildPayload()),
    onSuccess: ({ endpoint: created }) => {
      qc.invalidateQueries({ queryKey: ['webhooks', 'endpoints'] });
      if (created.secret) onSecretReveal(created.secret);
      onOpenChange(false);
    },
    onError: (e) => toast.error(formatApiError(e, 'Failed to create')),
  });

  const updateMut = useMutation({
    mutationFn: () => {
      if (!endpoint) throw new Error('no endpoint');
      return api.patch<{ endpoint: WebhookEndpointDto }>(
        `/webhooks/endpoints/${endpoint.id}`,
        buildPayload(),
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['webhooks', 'endpoints'] });
      onOpenChange(false);
    },
    onError: (e) => toast.error(formatApiError(e, 'Failed to update')),
  });

  const isEditing = endpoint != null;
  const submit = () => {
    if (!form.name.trim() || !form.url.trim() || form.events.size === 0) {
      toast.error('Name, URL, and at least one event are required');
      return;
    }
    if (duplicateHeaderKey) {
      toast.error(`Duplicate header "${duplicateHeaderKey}" — header names must be unique`);
      return;
    }
    if (isEditing) updateMut.mutate();
    else createMut.mutate();
  };
  const busy = createMut.isPending || updateMut.isPending;

  const toggleEvent = (event: WebhookEvent) => {
    setForm((prev) => {
      const next = new Set(prev.events);
      if (next.has(event)) next.delete(event);
      else next.add(event);
      return { ...prev, events: next };
    });
  };

  const toggleAllInGroup = (events: readonly WebhookEvent[], enable: boolean) => {
    setForm((prev) => {
      const next = new Set(prev.events);
      for (const ev of events) {
        if (enable) next.add(ev);
        else next.delete(ev);
      }
      return { ...prev, events: next };
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isEditing ? 'Edit endpoint' : 'New webhook endpoint'}</DialogTitle>
          <DialogDescription>
            Outgoing requests are POSTed to this URL with an HMAC-SHA256
            signature. Pick the events you want to receive.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="webhook-name">Name</Label>
              <Input
                id="webhook-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Zapier — leads channel"
                maxLength={120}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="webhook-url">URL</Label>
              <Input
                id="webhook-url"
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
                placeholder="https://example.com/webhooks/pipelineflow"
                maxLength={2048}
              />
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Events</Label>
              <span className="text-xs text-muted-foreground">
                {form.events.size} selected
              </span>
            </div>
            <div className="grid gap-3 rounded-md border p-3 sm:grid-cols-2">
              {WEBHOOK_EVENT_GROUPS.map((group) => {
                const allSelected = group.events.every((e) => form.events.has(e));
                return (
                  <div key={group.entity} className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">{group.entity}</span>
                      <button
                        type="button"
                        className="text-xs text-muted-foreground hover:text-foreground"
                        onClick={() => toggleAllInGroup(group.events, !allSelected)}
                      >
                        {allSelected ? 'Clear' : 'Select all'}
                      </button>
                    </div>
                    <div className="space-y-1">
                      {group.events.map((event) => (
                        <label
                          key={event}
                          className="flex cursor-pointer items-center gap-2 text-sm"
                        >
                          <input
                            type="checkbox"
                            checked={form.events.has(event)}
                            onChange={() => toggleEvent(event)}
                            className="h-4 w-4 rounded border-input"
                          />
                          <code className="text-xs">{event}</code>
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Custom headers <span className="text-xs text-muted-foreground">(optional)</span></Label>
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={() =>
                  setForm({
                    ...form,
                    customHeaders: [...form.customHeaders, { key: '', value: '' }],
                  })
                }
              >
                + Add header
              </button>
            </div>
            <p className="text-xs text-muted-foreground">
              Content-Type, User-Agent, and the <code>X-PipelineFlow-*</code> namespace
              are reserved — we set those automatically and they can't be overridden.
            </p>
            {duplicateHeaderKey ? (
              <p className="text-xs text-destructive">
                Duplicate header <code>{duplicateHeaderKey}</code> — header names must be unique.
              </p>
            ) : null}
            {form.customHeaders.length > 0 ? (
              <div className="space-y-2">
                {form.customHeaders.map((h, idx) => (
                  <div key={idx} className="flex gap-2">
                    <Input
                      placeholder="Header-Name"
                      value={h.key}
                      onChange={(e) => {
                        const next = [...form.customHeaders];
                        next[idx] = { ...h, key: e.target.value };
                        setForm({ ...form, customHeaders: next });
                      }}
                      className="font-mono text-xs"
                    />
                    <Input
                      placeholder="value"
                      value={h.value}
                      onChange={(e) => {
                        const next = [...form.customHeaders];
                        next[idx] = { ...h, value: e.target.value };
                        setForm({ ...form, customHeaders: next });
                      }}
                      className="font-mono text-xs"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() =>
                        setForm({
                          ...form,
                          customHeaders: form.customHeaders.filter((_, i) => i !== idx),
                        })
                      }
                    >
                      <Trash2 />
                    </Button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          <div className="flex items-center gap-2">
            <Switch
              id="webhook-enabled"
              checked={form.enabled}
              onCheckedChange={(enabled) => setForm({ ...form, enabled })}
            />
            <Label htmlFor="webhook-enabled">Enabled</Label>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            {isEditing ? 'Save changes' : 'Create endpoint'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Secret reveal (one-shot) ───────────────────────────────────────────────

function SecretRevealDialog({
  info,
  onClose,
}: {
  info: { secret: string; rotated: boolean } | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (info) setCopied(false);
  }, [info]);

  return (
    <Dialog open={info != null} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {info?.rotated ? 'Secret rotated' : 'Endpoint created'}
          </DialogTitle>
          <DialogDescription>
            Copy this signing secret now. You won't be able to see it again —
            we don't store it in plaintext anywhere reachable from this UI.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-md bg-muted p-3 font-mono text-sm break-all">
          {info?.secret}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={async () => {
              if (info) {
                await navigator.clipboard.writeText(info.secret);
                setCopied(true);
              }
            }}
          >
            {copied ? <Check /> : <Copy />}
            {copied ? 'Copied' : 'Copy secret'}
          </Button>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Deliveries dialog ──────────────────────────────────────────────────────

function DeliveriesDialog({
  endpoint,
  onClose,
}: {
  endpoint: WebhookEndpointDto;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const queryKey = ['webhooks', 'deliveries', endpoint.id];
  const { data, isFetching } = useQuery({
    queryKey,
    queryFn: () =>
      api.get<{ deliveries: WebhookDeliveryDto[] }>(
        `/webhooks/endpoints/${endpoint.id}/deliveries?limit=50`,
      ),
    // Pending deliveries land here within a few seconds; auto-refresh
    // while the dialog is open so the user sees the staircase advance.
    refetchInterval: 4_000,
  });

  const redeliverMut = useMutation({
    mutationFn: (id: number) =>
      api.post<{ deliveryId: number }>(`/webhooks/deliveries/${id}/redeliver`),
    onSuccess: () => {
      toast.success('Redelivery queued');
      qc.invalidateQueries({ queryKey });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Recent deliveries — {endpoint.name}</DialogTitle>
          <DialogDescription>
            Last 50 attempts. Redeliveries reuse the original event id so
            consumers can dedupe.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto rounded-md border">
          {data?.deliveries.length === 0 && !isFetching ? (
            <p className="p-6 text-center text-sm text-muted-foreground">
              No deliveries yet — fire a test event from the row.
            </p>
          ) : null}
          <div className="divide-y">
            {data?.deliveries.map((d) => (
              <div
                key={d.id}
                className="flex flex-col gap-1 p-3 text-sm sm:flex-row sm:items-center sm:gap-3"
              >
                <DeliveryStatusBadge status={d.status} responseStatus={d.responseStatus} />
                <code className="shrink-0 text-xs">{d.eventType}</code>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {d.errorMessage ?? d.responseBody ?? '—'}
                </span>
                <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                  <span>{new Date(d.createdAt).toLocaleString()}</span>
                  <span>·</span>
                  <span>{d.attemptCount} attempt{d.attemptCount === 1 ? '' : 's'}</span>
                  {d.durationMs != null ? (
                    <>
                      <span>·</span>
                      <span>{d.durationMs}ms</span>
                    </>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => redeliverMut.mutate(d.id)}
                    disabled={redeliverMut.isPending}
                  >
                    Redeliver
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeliveryStatusBadge({
  status,
  responseStatus,
}: {
  status: WebhookDeliveryDto['status'];
  responseStatus: number | null;
}) {
  if (status === 'success') {
    return (
      <Badge className="shrink-0 bg-emerald-600 hover:bg-emerald-600">
        {responseStatus ?? 'OK'}
      </Badge>
    );
  }
  if (status === 'failed') {
    return (
      <Badge variant="destructive" className="shrink-0">
        {responseStatus ?? 'fail'}
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="shrink-0">pending</Badge>
  );
}
