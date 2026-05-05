import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Link2, Link2Off, RefreshCw, AlertTriangle, Mail, Video } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';

type GoogleStatus = {
  connected: boolean;
  configured: boolean;
  account: {
    googleEmail: string;
    scopes: string[];
    connectedAt: string;
    disabledAt: string | null;
    disabledReason: string | null;
  } | null;
  contacts: {
    inboundEnabled: boolean;
    outboundEnabled: boolean;
    fullSyncDoneAt: string | null;
    lastPulledAt: string | null;
    lastPushedAt: string | null;
    initialImportedCount: number;
  } | null;
  calendar: {
    enabled: boolean;
    lastEventsSyncedAt: string | null;
    lastArtifactsSyncedAt: string | null;
  } | null;
};

const formatRelative = (iso: string | null): string => {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return new Date(iso).toLocaleString();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
};

function formatApiError(e: unknown, fallback = 'Request failed'): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return fallback;
}

export function IntegrationsCard() {
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  const { data, isLoading, error } = useQuery<GoogleStatus>({
    queryKey: ['integrations', 'google', 'status'],
    queryFn: () => api.get<GoogleStatus>('/integrations/google/status'),
    retry: false,
    // Auto-refresh while the initial import is running so the count
    // ticks up live without the user having to refresh. Stops once
    // fullSyncDoneAt lands or the connection goes away.
    refetchInterval: (q) => {
      const d = q.state.data;
      if (!d || !d.connected) return false;
      if (d.contacts && !d.contacts.fullSyncDoneAt) return 5_000;
      return false;
    },
  });

  // Surface the OAuth callback's query-param outcome as a toast, then
  // strip the params so a refresh doesn't re-fire the toast.
  useEffect(() => {
    const status = searchParams.get('google');
    if (!status) return;
    if (status === 'connected') {
      toast.success('Google account connected — initial import has started');
    } else if (status === 'error') {
      toast.error(`Google connection failed: ${searchParams.get('reason') ?? 'unknown'}`);
    }
    const next = new URLSearchParams(searchParams);
    next.delete('google');
    next.delete('reason');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const start = useMutation({
    mutationFn: (intent: 'contacts' | 'calendar') =>
      api.get<{ url: string }>(`/integrations/google/start?intent=${intent}`),
    onSuccess: ({ url }) => {
      // Full-page nav to Google's consent screen — we'll come back via
      // /api/integrations/google/callback which redirects to this page.
      window.location.href = url;
    },
    onError: (e) => toast.error(formatApiError(e, 'Could not start Google connection')),
  });

  const resyncCalendar = useMutation({
    mutationFn: () =>
      api.post<{ enqueued: 'incremental' }>('/integrations/google/calendar/resync'),
    onSuccess: () => {
      toast.success('Calendar resync enqueued');
      void qc.invalidateQueries({ queryKey: ['integrations', 'google', 'status'] });
    },
    onError: (e) => toast.error(formatApiError(e, 'Could not enqueue calendar resync')),
  });

  const backfillCalendar = useMutation({
    mutationFn: () =>
      api.post<{ enqueued: 'backfill' }>('/integrations/google/calendar/backfill'),
    onSuccess: () => {
      toast.success('Backfill enqueued — pulling the last 90 days');
      void qc.invalidateQueries({ queryKey: ['integrations', 'google', 'status'] });
    },
    onError: (e) => toast.error(formatApiError(e, 'Could not enqueue backfill')),
  });

  const disconnect = useMutation({
    mutationFn: () => api.post<{ disconnected: boolean }>('/integrations/google/disconnect'),
    onSuccess: () => {
      toast.success('Google account disconnected');
      void qc.invalidateQueries({ queryKey: ['integrations', 'google', 'status'] });
    },
    onError: (e) => toast.error(formatApiError(e, 'Could not disconnect')),
  });

  const resync = useMutation({
    mutationFn: () => api.post<{ enqueued: 'initial' | 'incremental' }>('/integrations/google/contacts/resync'),
    onSuccess: ({ enqueued }) => {
      toast.success(
        enqueued === 'initial'
          ? 'Initial import re-enqueued'
          : 'Incremental sync enqueued',
      );
      void qc.invalidateQueries({ queryKey: ['integrations', 'google', 'status'] });
    },
    onError: (e) => toast.error(formatApiError(e, 'Could not enqueue sync')),
  });

  const setOutbound = useMutation({
    mutationFn: (next: boolean) =>
      api.patch<{ outboundEnabled: boolean; inboundEnabled: boolean }>(
        '/integrations/google/contacts/settings',
        { outboundEnabled: next },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['integrations', 'google', 'status'] });
    },
    onError: (e) => toast.error(formatApiError(e, 'Could not update setting')),
  });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Mail className="h-4 w-4" />
            Google
          </CardTitle>
          <CardDescription>
            Connect your Google account to keep your PipelineFlow contacts
            and your Google address book in sync. Each user connects their
            own account; pulls run automatically, pushes are off until you
            opt in below.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Render order matters — error and loading take priority over the
              configured/connected branches so a 500 doesn't fall through to
              the "not configured" message and confuse the user. */}
          {error ? (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
              Couldn&apos;t load Google integration status:{' '}
              {formatApiError(error, 'unknown error')}. The api may be down,
              or the database may be missing the integrations migration —
              check the api container logs.
            </p>
          ) : null}

          {!error && data && !data.configured ? (
            <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
              Google integration isn&apos;t configured on this server. An
              admin needs to set <code>GOOGLE_OAUTH_CLIENT_ID</code>,{' '}
              <code>GOOGLE_OAUTH_CLIENT_SECRET</code>,{' '}
              <code>GOOGLE_OAUTH_REDIRECT_URI</code>, and{' '}
              <code>GOOGLE_TOKEN_ENCRYPTION_KEY</code> on the API.
            </p>
          ) : null}

          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : error ? null : data?.connected && data.account ? (
            <ConnectedState
              status={data}
              onDisconnect={() => disconnect.mutate()}
              disconnecting={disconnect.isPending}
              onResync={() => resync.mutate()}
              resyncing={resync.isPending}
              onSetOutbound={(v) => setOutbound.mutate(v)}
              outboundPending={setOutbound.isPending}
              onConnectCalendar={() => start.mutate('calendar')}
              startingCalendar={start.isPending}
              onResyncCalendar={() => resyncCalendar.mutate()}
              resyncingCalendar={resyncCalendar.isPending}
              onBackfillCalendar={() => backfillCalendar.mutate()}
              backfillingCalendar={backfillCalendar.isPending}
            />
          ) : (
            <DisconnectedState
              onConnect={() => start.mutate('contacts')}
              starting={start.isPending}
              configured={data?.configured ?? false}
              disabledReason={data?.account?.disabledReason ?? null}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function DisconnectedState(props: {
  onConnect: () => void;
  starting: boolean;
  configured: boolean;
  disabledReason: string | null;
}) {
  return (
    <div className="space-y-3">
      {props.disabledReason ? (
        <p className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Connection disabled (<code>{props.disabledReason}</code>).
            Reconnect below to resume syncing.
          </span>
        </p>
      ) : null}
      <Button onClick={props.onConnect} disabled={!props.configured || props.starting}>
        <Link2 className="mr-2 h-4 w-4" />
        {props.starting ? 'Redirecting…' : 'Connect Google account'}
      </Button>
    </div>
  );
}

function ConnectedState(props: {
  status: GoogleStatus;
  onDisconnect: () => void;
  disconnecting: boolean;
  onResync: () => void;
  resyncing: boolean;
  onSetOutbound: (next: boolean) => void;
  outboundPending: boolean;
  onConnectCalendar: () => void;
  startingCalendar: boolean;
  onResyncCalendar: () => void;
  resyncingCalendar: boolean;
  onBackfillCalendar: () => void;
  backfillingCalendar: boolean;
}) {
  const { status } = props;
  const account = status.account!;
  const contacts = status.contacts;
  return (
    <div className="space-y-5">
      <div className="grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Connected as</div>
          <div className="font-medium">{account.googleEmail}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Connected</div>
          <div>{formatRelative(account.connectedAt)}</div>
        </div>
        {contacts ? (
          <>
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Last pulled</div>
              <div>{formatRelative(contacts.lastPulledAt)}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Last pushed</div>
              <div>{formatRelative(contacts.lastPushedAt)}</div>
            </div>
          </>
        ) : null}
      </div>

      {contacts && !contacts.fullSyncDoneAt ? (
        <p className="rounded-md border border-blue-500/40 bg-blue-500/10 px-3 py-2 text-sm">
          Initial import in progress — {contacts.initialImportedCount.toLocaleString()} contacts
          imported so far. The page updates automatically as the worker
          processes each batch.
        </p>
      ) : null}

      {contacts ? (
        <div className="flex items-start justify-between gap-4 rounded-md border border-border/60 bg-muted/30 px-4 py-3">
          <div>
            <Label htmlFor="outbound-toggle" className="text-sm font-medium">
              Push my PipelineFlow edits back to Google Contacts
            </Label>
            <p className="mt-1 text-xs text-muted-foreground">
              Off by default. When on, contacts you create or edit in
              PipelineFlow are mirrored to your personal Google address
              book. Other users&apos; Google accounts are never written to.
            </p>
          </div>
          <Switch
            id="outbound-toggle"
            checked={contacts.outboundEnabled}
            disabled={props.outboundPending}
            onCheckedChange={(v) => props.onSetOutbound(v)}
          />
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={props.onResync} disabled={props.resyncing}>
          <RefreshCw className={`mr-2 h-4 w-4 ${props.resyncing ? 'animate-spin' : ''}`} />
          {props.resyncing ? 'Syncing…' : 'Resync contacts'}
        </Button>
        <Button
          variant="outline"
          onClick={props.onDisconnect}
          disabled={props.disconnecting}
        >
          <Link2Off className="mr-2 h-4 w-4" />
          {props.disconnecting ? 'Disconnecting…' : 'Disconnect'}
        </Button>
      </div>

      <div className="rounded-md border border-border/60 bg-muted/30 px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <Label className="flex items-center gap-2 text-sm font-medium">
              <Video className="h-4 w-4" />
              Calendar &amp; Meet
            </Label>
            <p className="mt-1 text-xs text-muted-foreground">
              Pull customer Calendar events into deals and attach Meet
              recordings, Gemini summaries, and transcripts. Polling every
              5 minutes once connected. Requires re-consent because the
              Calendar / Meet / Drive scopes weren&apos;t granted at first
              sign-in.
            </p>
            {status.calendar ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Last synced: {formatRelative(status.calendar.lastEventsSyncedAt)} ·
                Last artifacts run: {formatRelative(status.calendar.lastArtifactsSyncedAt)}
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 flex-col gap-2">
            {status.calendar ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={props.onResyncCalendar}
                  disabled={props.resyncingCalendar}
                >
                  <RefreshCw
                    className={`mr-2 h-4 w-4 ${props.resyncingCalendar ? 'animate-spin' : ''}`}
                  />
                  {props.resyncingCalendar ? 'Syncing…' : 'Resync calendar'}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={props.onBackfillCalendar}
                  disabled={props.backfillingCalendar}
                  title="Re-pull the last 90 days. Useful if you connected before older meetings were available."
                >
                  <RefreshCw
                    className={`mr-2 h-4 w-4 ${props.backfillingCalendar ? 'animate-spin' : ''}`}
                  />
                  {props.backfillingCalendar ? 'Backfilling…' : 'Backfill 90d'}
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                onClick={props.onConnectCalendar}
                disabled={props.startingCalendar}
              >
                <Link2 className="mr-2 h-4 w-4" />
                {props.startingCalendar ? 'Redirecting…' : 'Enable Calendar'}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
