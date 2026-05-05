import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronUp,
  FileText,
  Link2Off,
  Plus,
  RefreshCw,
  Sparkles,
  Video,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { MeetingDto, TaskDto } from '@/types';
import { relativeTime } from '@/lib/utils';
import { ConnectMeetingDialog } from './ConnectMeetingDialog';

// Meetings panel — embedded on deal, contact, and company detail pages.
// The headline interaction is the three artifact buttons on each meeting
// card: open recording, open Gemini summary doc, open transcript. Anything
// missing renders as a disabled placeholder rather than vanishing, so the
// rep can tell at a glance whether Gemini is still cooking vs. there's
// genuinely no recording.
//
// Scope filters: pass exactly one of dealId / contactId / companyId. The
// API accepts more, but the panel is deliberately single-scope so the
// "from meeting" badges line up with the card the user is on.

interface PanelProps {
  dealId?: number;
  contactId?: number;
  companyId?: number;
  // Title of the deal the panel is rendered for. Used in the Connect
  // Meeting dialog header so the rep can verify they're attaching to
  // the deal they're looking at. Only meaningful when dealId is set.
  dealTitle?: string;
  // When the panel sits on a deal page, also surface the action-items
  // inbox above the meeting list. On contact / company panels we hide
  // it — those don't have a single deal to attribute the inbox to.
  showInbox?: boolean;
}

export function MeetingsPanel(props: PanelProps) {
  const qc = useQueryClient();
  const [connectOpen, setConnectOpen] = useState(false);
  // Key only on the scope ids — display-only props like `dealTitle` and
  // `showInbox` don't change the API result and would otherwise force a
  // refetch on parent re-renders that produced an equivalent prop bundle
  // with a fresh object identity.
  const queryKey = [
    'meetings',
    { dealId: props.dealId ?? null, contactId: props.contactId ?? null, companyId: props.companyId ?? null },
  ] as const;
  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: () => {
      const params = new URLSearchParams();
      if (props.dealId != null) params.set('dealId', String(props.dealId));
      if (props.contactId != null) params.set('contactId', String(props.contactId));
      if (props.companyId != null) params.set('companyId', String(props.companyId));
      return api.get<{ meetings: MeetingDto[] }>(`/meetings?${params.toString()}`);
    },
  });

  const inboxEnabled = props.showInbox && props.dealId != null;
  const inbox = useQuery({
    queryKey: ['meeting-inbox', props.dealId],
    queryFn: () =>
      api.get<{ tasks: TaskDto[] }>(`/meetings/inbox/by-deal/${props.dealId}`),
    enabled: !!inboxEnabled,
  });

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading meetings…</p>;
  }
  const meetings = data?.meetings ?? [];

  const onChanged = () => {
    void qc.invalidateQueries({ queryKey });
    if (inboxEnabled) {
      void qc.invalidateQueries({ queryKey: ['meeting-inbox', props.dealId] });
    }
  };

  return (
    <div className="space-y-4">
      {props.dealId != null ? (
        <div className="flex justify-end">
          <Button size="sm" variant="outline" onClick={() => setConnectOpen(true)}>
            <Plus className="mr-1 h-3.5 w-3.5" /> Connect meeting
          </Button>
        </div>
      ) : null}

      {inboxEnabled && (inbox.data?.tasks.length ?? 0) > 0 ? (
        <ActionItemsInbox dealId={props.dealId!} tasks={inbox.data!.tasks} />
      ) : null}

      {meetings.length === 0 ? (
        <p className="text-sm text-muted-foreground">No meetings yet.</p>
      ) : (
        <div className="space-y-3">
          {meetings.map((m) => (
            <MeetingCard key={m.id} meeting={m} onChanged={onChanged} />
          ))}
        </div>
      )}

      {props.dealId != null ? (
        <ConnectMeetingDialog
          dealId={props.dealId}
          dealTitle={props.dealTitle ?? 'this deal'}
          open={connectOpen}
          onOpenChange={setConnectOpen}
        />
      ) : null}
    </div>
  );
}

function MeetingCard({
  meeting,
  onChanged,
}: {
  meeting: MeetingDto;
  onChanged: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const start = new Date(meeting.scheduledStart);
  const isUpcoming = start.getTime() > Date.now();
  const status = meeting.status;
  const linkStatus = meeting.linkStatus;

  const reject = useMutation({
    mutationFn: () =>
      api.patch<{ meeting: MeetingDto }>(`/meetings/${meeting.id}/link`, {
        linkStatus: 'rejected',
      }),
    onSuccess: () => {
      toast.success('Suggestion rejected');
      onChanged();
    },
    onError: (e) => toast.error(formatErr(e, 'Could not reject')),
  });

  const accept = useMutation({
    mutationFn: () =>
      api.patch<{ meeting: MeetingDto }>(`/meetings/${meeting.id}/link`, {
        linkStatus: 'confirmed',
        primaryContactId: meeting.primaryContactId,
        primaryDealId: meeting.primaryDealId,
        primaryCompanyId: meeting.primaryCompanyId,
      }),
    onSuccess: () => {
      toast.success('Meeting linked');
      onChanged();
    },
    onError: (e) => toast.error(formatErr(e, 'Could not confirm')),
  });

  const refresh = useMutation({
    mutationFn: () =>
      api.post<{ enqueued: boolean }>(`/meetings/${meeting.id}/refresh-artifacts`),
    onSuccess: () => {
      toast.success('Refresh enqueued — checking for recording, summary, transcript');
      // Give the worker a moment, then refetch so the URLs appear if they
      // landed quickly. Not a guarantee — Drive search + Doc fetch can
      // take seconds.
      setTimeout(onChanged, 2_000);
    },
    onError: (e) => toast.error(formatErr(e, 'Could not refresh')),
  });

  return (
    <Card>
      <CardContent className="space-y-3 pt-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-medium">{meeting.title}</h3>
              {linkStatus === 'suggested' ? (
                <Badge variant="outline" className="border-amber-500/40 text-amber-600 dark:text-amber-400">
                  Needs review
                </Badge>
              ) : linkStatus === 'confirmed' ? (
                <Badge variant="outline" className="border-emerald-500/40 text-emerald-600 dark:text-emerald-400">
                  Linked
                </Badge>
              ) : null}
              {meeting.artifactsPartial ? (
                <Badge
                  variant="outline"
                  className="border-muted-foreground/30 text-xs text-muted-foreground"
                >
                  Partial artifacts
                </Badge>
              ) : null}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {start.toLocaleString()} · {status}
            </p>
            {meeting.summaryExcerpt ? (
              <p className="mt-2 text-sm text-foreground/90 line-clamp-3">
                <Sparkles className="mr-1 inline h-3.5 w-3.5 text-blue-500" />
                {meeting.summaryExcerpt}
              </p>
            ) : null}
          </div>

          {isUpcoming ? null : (
            <ArtifactButtons meeting={meeting} />
          )}
        </div>

        {linkStatus === 'suggested' ? (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => accept.mutate()} disabled={accept.isPending}>
              <Check className="mr-1 h-3.5 w-3.5" /> Looks right
            </Button>
            <Button size="sm" variant="ghost" onClick={() => reject.mutate()} disabled={reject.isPending}>
              <Link2Off className="mr-1 h-3.5 w-3.5" /> Not this one
            </Button>
          </div>
        ) : linkStatus === 'confirmed' ? (
          <Button size="sm" variant="ghost" onClick={() => reject.mutate()} disabled={reject.isPending}>
            <Link2Off className="mr-1 h-3.5 w-3.5" /> Unlink
          </Button>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            {expanded ? 'Hide' : 'Show'} attendees
          </button>
          {!isUpcoming ? (
            <button
              onClick={() => refresh.mutate()}
              disabled={refresh.isPending}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
              title="Re-check Drive for the recording, summary, and transcript"
            >
              <RefreshCw className={`h-3 w-3 ${refresh.isPending ? 'animate-spin' : ''}`} />
              {refresh.isPending ? 'Refreshing…' : 'Refresh artifacts'}
            </button>
          ) : null}
        </div>

        {expanded ? (
          <div className="rounded-md border bg-muted/30 p-2 text-xs">
            {meeting.attendees.length === 0 ? (
              <p className="text-muted-foreground">No attendees recorded.</p>
            ) : (
              <ul className="space-y-1">
                {meeting.attendees.map((a) => (
                  <li key={a.id} className="flex items-center gap-2">
                    <span>{a.name ?? a.email}</span>
                    {a.contact ? (
                      <span className="text-muted-foreground">
                        ↔ contact #{a.contact.id}
                      </span>
                    ) : null}
                    {a.user ? (
                      <span className="text-muted-foreground">(internal)</span>
                    ) : null}
                    {a.responseStatus ? (
                      <span className="ml-auto text-muted-foreground">{a.responseStatus}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// The three big buttons. This is the feature: one click → Drive opens
// the recording / summary / transcript in a new tab. Disabled state for
// missing artifacts intentionally still renders so the rep can tell
// "this meeting just hasn't produced one yet."
function ArtifactButtons({ meeting }: { meeting: MeetingDto }) {
  return (
    <div className="flex shrink-0 flex-wrap gap-1.5">
      <ArtifactButton
        href={meeting.recordingUrl}
        label="Recording"
        icon={<Video className="h-3.5 w-3.5" />}
      />
      <ArtifactButton
        href={meeting.summaryDocUrl}
        label="Summary"
        icon={<Sparkles className="h-3.5 w-3.5" />}
      />
      <ArtifactButton
        href={meeting.transcriptDocUrl}
        label="Transcript"
        icon={<FileText className="h-3.5 w-3.5" />}
      />
    </div>
  );
}

function ArtifactButton({
  href,
  label,
  icon,
}: {
  href: string | null;
  label: string;
  icon: React.ReactNode;
}) {
  if (!href) {
    return (
      <span
        className="inline-flex select-none items-center gap-1 rounded-md border border-dashed border-border/60 px-2 py-1 text-xs text-muted-foreground/70"
        title={`${label} not available yet`}
      >
        {icon}
        {label}
      </span>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-background px-2 py-1 text-xs font-medium hover:border-foreground/40 hover:bg-muted"
    >
      {icon}
      {label}
    </a>
  );
}

function ActionItemsInbox({
  dealId,
  tasks,
}: {
  dealId: number;
  tasks: TaskDto[];
}) {
  const qc = useQueryClient();
  const decide = useMutation({
    mutationFn: ({
      meetingId,
      taskId,
      action,
    }: {
      meetingId: number;
      taskId: number;
      action: 'accept' | 'dismiss';
    }) =>
      api.post<{ task: TaskDto }>(`/meetings/${meetingId}/tasks/${taskId}/action`, { action }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['meeting-inbox', dealId] });
      void qc.invalidateQueries({ queryKey: ['deal', dealId] });
    },
    onError: (e) => toast.error(formatErr(e, 'Could not update action item')),
  });

  return (
    <Card className="border-amber-500/30">
      <CardContent className="space-y-3 pt-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <AlertCircle className="h-4 w-4 text-amber-500" />
          Action items from meetings — {tasks.length} need{tasks.length === 1 ? 's' : ''} review
        </div>
        <ul className="space-y-2">
          {tasks.map((t) => (
            <li
              key={t.id}
              className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-sm"
            >
              <span className="min-w-0 flex-1">
                {t.customerCommitment ? (
                  <Badge
                    variant="outline"
                    className="mr-2 border-purple-500/40 text-xs text-purple-600 dark:text-purple-400"
                  >
                    Customer
                  </Badge>
                ) : null}
                {t.title}
                {t.assignee ? (
                  <span className="ml-2 text-xs text-muted-foreground">
                    → {t.assignee.name}
                  </span>
                ) : null}
              </span>
              <span className="text-xs text-muted-foreground">
                {t.createdAt ? relativeTime(t.createdAt) : null}
              </span>
              <div className="flex gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    decide.mutate({
                      meetingId: t.sourceMeetingId!,
                      taskId: t.id,
                      action: 'accept',
                    })
                  }
                  disabled={decide.isPending}
                >
                  <Check className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    decide.mutate({
                      meetingId: t.sourceMeetingId!,
                      taskId: t.id,
                      action: 'dismiss',
                    })
                  }
                  disabled={decide.isPending}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function formatErr(e: unknown, fallback: string): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return fallback;
}
