import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, Check, Copy, KeyRound, Plus, Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { API_TOKEN_SCOPES } from '@pipelineflow/shared';
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
import type { ApiTokenDto, ApiTokenScope } from '@/types';

interface ScopeMeta {
  name: ApiTokenScope;
  label: string;
  description: string;
}

const FALLBACK_SCOPES: ScopeMeta[] = [
  {
    name: 'read',
    label: 'Read',
    description: 'List and view deals, contacts, companies, tasks, notes, tags, stages.',
  },
  {
    name: 'write',
    label: 'Write',
    description: 'Create and update records. Move deals between stages.',
  },
  {
    name: 'delete',
    label: 'Delete',
    description: 'Delete records. Each delete still requires per-call approval.',
  },
];

type FormState = {
  name: string;
  scopes: Set<ApiTokenScope>;
  expiresInDays: number | null;
};

const emptyForm = (): FormState => ({
  name: '',
  scopes: new Set(['read']),
  expiresInDays: null,
});

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

const formatRelative = (iso: string | null) => {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return new Date(iso).toLocaleDateString();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
};

export function ApiTokensCard() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['api-tokens'],
    queryFn: () => api.get<{ tokens: ApiTokenDto[] }>('/api-tokens'),
  });
  const { data: scopeData } = useQuery({
    queryKey: ['api-tokens', 'scopes'],
    queryFn: () => api.get<{ scopes: ScopeMeta[] }>('/api-tokens/scopes'),
  });
  const scopeCatalog = scopeData?.scopes ?? FALLBACK_SCOPES;

  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [revealed, setRevealed] = useState<{ token: string; name: string } | null>(null);
  const [revoking, setRevoking] = useState<ApiTokenDto | null>(null);

  const createMut = useMutation({
    mutationFn: () =>
      api.post<{ token: ApiTokenDto }>('/api-tokens', {
        name: form.name,
        scopes: Array.from(form.scopes),
        expiresAt: form.expiresInDays
          ? new Date(Date.now() + form.expiresInDays * 86_400_000).toISOString()
          : undefined,
      }),
    onSuccess: ({ token }) => {
      qc.invalidateQueries({ queryKey: ['api-tokens'] });
      setCreating(false);
      setForm(emptyForm());
      // The plaintext token is shown exactly once. Persist it in
      // component state until the user explicitly dismisses the dialog.
      if (token.token) {
        setRevealed({ token: token.token, name: token.name });
      }
    },
    onError: (e) => toast.error(formatApiError(e, 'Could not issue token')),
  });

  const revokeMut = useMutation({
    mutationFn: (id: string) => api.delete(`/api-tokens/${id}`),
    onSuccess: () => {
      toast.success('Token revoked');
      qc.invalidateQueries({ queryKey: ['api-tokens'] });
      setRevoking(null);
    },
    onError: (e) => toast.error(formatApiError(e, 'Could not revoke token')),
  });

  const tokens = data?.tokens ?? [];

  const toggleScope = (scope: ApiTokenScope) => {
    setForm((f) => {
      const next = new Set(f.scopes);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return { ...f, scopes: next };
    });
  };

  const canSubmit =
    form.name.trim().length > 0 &&
    form.scopes.size > 0 &&
    !createMut.isPending;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle>API tokens</CardTitle>
            <CardDescription>
              Bearer tokens for the MCP server (
              <code className="rounded bg-muted px-1 py-0.5 text-[12px]">/api/mcp</code>
              ) and other automated clients. Each token is scoped, revokable, and
              attributed to your account in the activity log. Destructive tools
              additionally require per-call approval.
            </CardDescription>
          </div>
          <Button size="sm" onClick={() => { setForm(emptyForm()); setCreating(true); }}>
            <Plus /> New token
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {tokens.length === 0 ? (
          <div className="rounded-md border border-dashed border-border/70 p-6 text-center text-sm text-muted-foreground">
            No tokens yet. Create one to connect Claude or another MCP-aware agent.
          </div>
        ) : (
          <ul className="divide-y divide-border/70">
            {tokens.map((t) => (
              <TokenRow
                key={t.id}
                token={t}
                onRevoke={() => setRevoking(t)}
              />
            ))}
          </ul>
        )}
      </CardContent>

      <Dialog open={creating} onOpenChange={(open) => { if (!open) setCreating(false); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New API token</DialogTitle>
            <DialogDescription>
              Tokens are issued once and stored as a hash on the server. You'll
              see the plaintext value exactly once — copy it then.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="token-name">Name</Label>
              <Input
                id="token-name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Claude Desktop"
                maxLength={120}
                autoFocus
              />
              <p className="text-xs text-muted-foreground">
                For your reference only — pick something that identifies the client.
              </p>
            </div>
            <div className="space-y-2">
              <Label>Scopes</Label>
              <div className="space-y-2 rounded-md border border-border/70 p-3">
                {scopeCatalog.map((s) => (
                  <label
                    key={s.name}
                    className="flex items-start gap-3 text-sm cursor-pointer"
                  >
                    <Switch
                      checked={form.scopes.has(s.name)}
                      onCheckedChange={() => toggleScope(s.name)}
                      className="mt-0.5"
                    />
                    <span className="flex-1">
                      <span className="font-medium">{s.label}</span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        {s.description}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
              {!API_TOKEN_SCOPES.every((s) => scopeCatalog.find((x) => x.name === s)) && (
                <p className="text-xs text-amber-500">
                  Server is offering scopes this UI doesn't recognise — you may
                  want to update the web app.
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="token-expires">Expires</Label>
              <select
                id="token-expires"
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                value={form.expiresInDays ?? ''}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    expiresInDays: e.target.value ? Number(e.target.value) : null,
                  }))
                }
              >
                <option value="">Never (revoke manually)</option>
                <option value="7">7 days</option>
                <option value="30">30 days</option>
                <option value="90">90 days</option>
                <option value="365">365 days</option>
              </select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
            <Button
              disabled={!canSubmit}
              onClick={() => createMut.mutate()}
            >
              {createMut.isPending ? 'Issuing…' : 'Issue token'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/*
        The plaintext token is only ever held in this component's React
        state — once cleared it's gone for good. Block the implicit
        close paths (Esc, click-outside, the X button) so a user who
        accidentally taps outside the dialog doesn't lose the token.
        The "I've saved it" button is the only way out.
      */}
      <Dialog open={!!revealed} onOpenChange={() => undefined}>
        <DialogContent
          onPointerDownOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>Token issued</DialogTitle>
            <DialogDescription>
              This is the only time you'll see this value. Copy it now and store
              it somewhere safe — we only keep a hash on the server.
            </DialogDescription>
          </DialogHeader>
          {revealed && (
            <div className="space-y-3">
              <div className="rounded-md border border-border/70 bg-muted/40 p-3">
                <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
                  {revealed.name}
                </div>
                <code className="block break-all font-mono text-[13px]">
                  {revealed.token}
                </code>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  navigator.clipboard.writeText(revealed.token).then(
                    () => toast.success('Copied'),
                    () => toast.error('Copy failed'),
                  );
                }}
              >
                <Copy /> Copy to clipboard
              </Button>
              <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-600 dark:text-amber-400">
                <AlertTriangle className="inline h-3.5 w-3.5 mr-1" />
                Treat this like a password — anyone with it can act on the
                pipeline within the granted scopes until you revoke it.
              </div>
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setRevealed(null)}>
              <Check /> I've saved it
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(open) => { if (!open) setRevoking(null); }}
        title="Revoke token?"
        description={
          revoking
            ? `Any client using "${revoking.name}" will stop being able to authenticate immediately.`
            : ''
        }
        confirmLabel="Revoke"
        busy={revokeMut.isPending}
        onConfirm={() => {
          if (revoking) revokeMut.mutate(revoking.id);
        }}
        destructive
      />
    </Card>
  );
}

function TokenRow({ token, onRevoke }: {
  token: ApiTokenDto;
  onRevoke: () => void;
}) {
  const isRevoked = !!token.revokedAt;
  const isExpired = !!token.expiresAt && new Date(token.expiresAt) < new Date();
  const inactive = isRevoked || isExpired;

  return (
    <li className="py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
            <span className={`text-sm font-medium ${inactive ? 'text-muted-foreground line-through' : ''}`}>
              {token.name}
            </span>
            {isRevoked && <Badge variant="outline" className="text-[10px]">Revoked</Badge>}
            {!isRevoked && isExpired && <Badge variant="outline" className="text-[10px]">Expired</Badge>}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {token.scopes.map((s) => (
              <Badge
                key={s}
                variant="secondary"
                className="text-[10px] uppercase tracking-wide"
              >
                {s}
              </Badge>
            ))}
          </div>
          <div className="mt-2 grid grid-cols-1 gap-x-4 gap-y-0.5 text-xs text-muted-foreground sm:grid-cols-3">
            <span>Issued {formatRelative(token.createdAt)}</span>
            <span>Last used {formatRelative(token.lastUsedAt)}</span>
            <span>
              Expires{' '}
              {token.expiresAt
                ? new Date(token.expiresAt).toLocaleDateString()
                : 'never'}
            </span>
          </div>
        </div>
        {!isRevoked && (
          <Button size="sm" variant="ghost" onClick={onRevoke}>
            <Trash2 /> Revoke
          </Button>
        )}
      </div>
    </li>
  );
}
