import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, Sparkles, Video } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import type { MeetingDto } from '@/types';

// Connect Meeting dialog. Used from the deal page Meetings tab when the
// auto-link matcher missed a meeting (title-based disambiguation can't
// catch every "30min with Dispatch Scout" naming convention). The rep
// picks a meeting from a list of candidates; we link it via the existing
// PATCH /meetings/:id/link endpoint with the deal id, and the API
// hydrates the contact / company from the deal automatically.
//
// Default candidate set is "unlinked or suggested" — confirmed-elsewhere
// meetings are out by default so the dialog stays focused. The "Show all
// meetings" toggle drops that filter for the rare cases where a rep
// needs to re-attach.

interface Props {
  dealId: number;
  dealTitle: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ConnectMeetingDialog({ dealId, dealTitle, open, onOpenChange }: Props) {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [showAll, setShowAll] = useState(false);

  // Pull a fresh candidate list each time the dialog opens. Don't bother
  // debouncing the search input — the result set is small enough that
  // we filter client-side; only refetch when the show-all toggle flips.
  const { data, isLoading } = useQuery({
    queryKey: ['meetings', 'candidates', { showAll }],
    queryFn: () => {
      const params = new URLSearchParams();
      if (!showAll) params.set('unlinkedOnly', 'true');
      params.set('limit', '100');
      return api.get<{ meetings: MeetingDto[] }>(`/meetings?${params.toString()}`);
    },
    enabled: open,
  });

  const filtered = useMemo(() => {
    const list = data?.meetings ?? [];
    if (!search.trim()) return list;
    const s = search.trim().toLowerCase();
    return list.filter((m) => m.title.toLowerCase().includes(s));
  }, [data, search]);

  const link = useMutation({
    mutationFn: (meetingId: number) =>
      api.patch<{ meeting: MeetingDto }>(`/meetings/${meetingId}/link`, {
        linkStatus: 'confirmed',
        primaryDealId: dealId,
      }),
    onSuccess: () => {
      toast.success('Meeting linked to deal');
      // The deal page's Meetings tab + the candidates list both need
      // refetching. Invalidate broadly — the keys are scoped enough
      // that only the meetings UI repaints.
      void qc.invalidateQueries({ queryKey: ['meetings'] });
      void qc.invalidateQueries({ queryKey: ['meeting-inbox', dealId] });
      onOpenChange(false);
    },
    onError: (e) => toast.error(formatErr(e, 'Could not link meeting')),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Connect a meeting to {dealTitle}</DialogTitle>
          <DialogDescription>
            Pick a meeting to attach. Recording, summary, and transcript
            links (when available) come along automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter by title…"
              className="pl-8"
            />
          </div>

          <div className="flex items-center justify-between rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs">
            <Label htmlFor="show-all-meetings" className="cursor-pointer">
              Show meetings already linked to other deals
            </Label>
            <Switch
              id="show-all-meetings"
              checked={showAll}
              onCheckedChange={setShowAll}
            />
          </div>

          <div className="max-h-[50vh] space-y-1 overflow-y-auto">
            {isLoading ? (
              <p className="py-4 text-center text-sm text-muted-foreground">Loading…</p>
            ) : filtered.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">
                {search
                  ? 'No meetings match that search.'
                  : showAll
                  ? 'No meetings ingested yet.'
                  : 'No unlinked meetings. Toggle "Show meetings already linked" to widen the list.'}
              </p>
            ) : (
              filtered.map((m) => (
                <CandidateRow
                  key={m.id}
                  meeting={m}
                  onPick={() => link.mutate(m.id)}
                  busy={link.isPending && link.variables === m.id}
                />
              ))
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CandidateRow({
  meeting,
  onPick,
  busy,
}: {
  meeting: MeetingDto;
  onPick: () => void;
  busy: boolean;
}) {
  const start = new Date(meeting.scheduledStart);
  const past = start.getTime() < Date.now();
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={busy}
      className="flex w-full flex-col gap-1 rounded-md border border-border/60 px-3 py-2 text-left transition hover:border-foreground/40 hover:bg-muted disabled:opacity-50"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{meeting.title}</span>
        <span className="text-xs text-muted-foreground">{start.toLocaleString()}</span>
        {meeting.recordingUrl ? (
          <Badge variant="outline" className="border-border/60 text-[10px]">
            <Video className="mr-1 h-3 w-3" /> Recording
          </Badge>
        ) : null}
        {meeting.summaryDocUrl ? (
          <Badge variant="outline" className="border-border/60 text-[10px]">
            <Sparkles className="mr-1 h-3 w-3" /> Summary
          </Badge>
        ) : null}
        {meeting.linkStatus === 'confirmed' && meeting.primaryDeal ? (
          <Badge variant="outline" className="border-emerald-500/40 text-[10px] text-emerald-600 dark:text-emerald-400">
            Linked to {meeting.primaryDeal.title}
          </Badge>
        ) : null}
      </div>
      <div className="text-xs text-muted-foreground">
        {past ? 'Past' : 'Upcoming'} · {meeting.attendees.length} attendee
        {meeting.attendees.length === 1 ? '' : 's'}
        {meeting.summaryExcerpt ? ` · ${truncate(meeting.summaryExcerpt, 100)}` : ''}
      </div>
    </button>
  );
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function formatErr(e: unknown, fallback: string): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return fallback;
}
