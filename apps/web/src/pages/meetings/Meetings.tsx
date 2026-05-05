import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import interactionPlugin from '@fullcalendar/interaction';
import {
  Calendar as CalendarIcon,
  FileText,
  ListChecks,
  Search,
  Sparkles,
  Video,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api';
import type { MeetingDto } from '@/types';

// Top-level Meetings page — paired with /tasks. Two views:
//   - List (default): a flat sortable table of recent meetings, with
//     the three artifact buttons inline so the rep can hop straight to
//     the recording / summary / transcript.
//   - Calendar: a month/week grid that pins each meeting at its start
//     time. Clicking a meeting opens its primary deal page (where the
//     full detail view lives) — same pattern as the Tasks calendar.
//
// We deliberately don't show every meeting in the workspace — the
// /api/meetings endpoint already caps results and applies tenant scope.
// 100 here is the working set you'd actually want to see.

export function Meetings() {
  const [tab, setTab] = useState('list');
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Meetings</h1>
        <p className="text-sm text-muted-foreground">
          Calendar events synced from Google. Recording, Gemini summary, and
          transcript links land here automatically once Meet finishes
          processing the call.
        </p>
      </div>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="list">
            <ListChecks className="mr-1 h-3.5 w-3.5" /> List
          </TabsTrigger>
          <TabsTrigger value="calendar">
            <CalendarIcon className="mr-1 h-3.5 w-3.5" /> Calendar
          </TabsTrigger>
        </TabsList>
        <TabsContent value="list">
          <MeetingsList />
        </TabsContent>
        <TabsContent value="calendar">
          <MeetingsCalendar />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function MeetingsList() {
  const [search, setSearch] = useState('');
  const { data, isLoading } = useQuery({
    queryKey: ['meetings', 'all'],
    queryFn: () =>
      api.get<{ meetings: MeetingDto[] }>('/meetings?limit=100'),
  });

  const filtered = useMemo(() => {
    const list = data?.meetings ?? [];
    if (!search.trim()) return list;
    const s = search.trim().toLowerCase();
    return list.filter((m) => {
      if (m.title.toLowerCase().includes(s)) return true;
      if (m.primaryDeal?.title.toLowerCase().includes(s)) return true;
      if (m.primaryCompany?.name.toLowerCase().includes(s)) return true;
      return m.attendees.some((a) =>
        (a.name ?? a.email).toLowerCase().includes(s),
      );
    });
  }, [data, search]);

  return (
    <div className="space-y-3">
      <div className="relative max-w-md">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Filter by title, deal, company, or attendee…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-8"
        />
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {search
            ? 'No meetings match that filter.'
            : 'No meetings yet. Connect Google Calendar from Settings → Integrations.'}
        </p>
      ) : (
        <div className="overflow-hidden rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">When</th>
                <th className="px-3 py-2 font-medium">Title</th>
                <th className="px-3 py-2 font-medium">Linked to</th>
                <th className="px-3 py-2 font-medium">Artifacts</th>
                <th className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((m) => (
                <Row key={m.id} meeting={m} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Row({ meeting }: { meeting: MeetingDto }) {
  const start = new Date(meeting.scheduledStart);
  return (
    <tr className="border-t">
      <td className="px-3 py-2 align-top">
        <div className="font-mono text-xs">
          {start.toLocaleDateString()} {start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </div>
      </td>
      <td className="px-3 py-2 align-top">
        <div className="font-medium">{meeting.title}</div>
        {meeting.summaryExcerpt ? (
          <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
            {meeting.summaryExcerpt}
          </div>
        ) : null}
      </td>
      <td className="px-3 py-2 align-top">
        {meeting.primaryDeal ? (
          <Link
            to={`/deals/${meeting.primaryDeal.id}`}
            className="text-primary hover:underline"
          >
            {meeting.primaryDeal.title}
          </Link>
        ) : meeting.primaryContact ? (
          <Link
            to={`/contacts/${meeting.primaryContact.id}`}
            className="text-primary hover:underline"
          >
            {meeting.primaryContact.firstName} {meeting.primaryContact.lastName}
          </Link>
        ) : meeting.primaryCompany ? (
          <Link
            to={`/companies/${meeting.primaryCompany.id}`}
            className="text-primary hover:underline"
          >
            {meeting.primaryCompany.name}
          </Link>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-3 py-2 align-top">
        <div className="flex flex-wrap gap-1">
          <ArtifactPill href={meeting.recordingUrl} icon={<Video className="h-3 w-3" />} label="Rec" />
          <ArtifactPill href={meeting.summaryDocUrl} icon={<Sparkles className="h-3 w-3" />} label="Sum" />
          <ArtifactPill href={meeting.transcriptDocUrl} icon={<FileText className="h-3 w-3" />} label="Tr" />
        </div>
      </td>
      <td className="px-3 py-2 align-top">
        <StatusBadge status={meeting.linkStatus} />
      </td>
    </tr>
  );
}

function ArtifactPill({
  href,
  icon,
  label,
}: {
  href: string | null;
  icon: React.ReactNode;
  label: string;
}) {
  if (!href) {
    return (
      <span className="inline-flex items-center gap-1 rounded border border-dashed border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground/70">
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
      onClick={(e) => e.stopPropagation()}
      className="inline-flex items-center gap-1 rounded border border-border/70 bg-background px-1.5 py-0.5 text-[10px] hover:border-foreground/40 hover:bg-muted"
    >
      {icon}
      {label}
    </a>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'confirmed') {
    return (
      <Badge variant="outline" className="border-emerald-500/40 text-emerald-600 dark:text-emerald-400">
        Linked
      </Badge>
    );
  }
  if (status === 'suggested') {
    return (
      <Badge variant="outline" className="border-amber-500/40 text-amber-600 dark:text-amber-400">
        Needs review
      </Badge>
    );
  }
  if (status === 'rejected') {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        Rejected
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-muted-foreground">
      Unlinked
    </Badge>
  );
}

function MeetingsCalendar() {
  const navigate = useNavigate();
  const { data } = useQuery({
    queryKey: ['meetings', 'calendar'],
    queryFn: () =>
      api.get<{ meetings: MeetingDto[] }>('/meetings?limit=200'),
    staleTime: 30_000,
  });

  const events = (data?.meetings ?? []).map((m) => ({
    id: `meeting-${m.id}`,
    title: m.title,
    start: m.scheduledStart,
    end: m.scheduledEnd,
    extendedProps: {
      hasRecording: Boolean(m.recordingUrl),
      hasSummary: Boolean(m.summaryDocUrl),
      linkStatus: m.linkStatus,
      meetingId: m.id,
      // Pre-resolve the click target. A meeting with a deal goes to the
      // deal page; otherwise contact, otherwise company. A meeting with
      // no link gets nowhere — clicking is a no-op rather than a 404.
      navigateTo:
        m.primaryDeal?.id != null
          ? `/deals/${m.primaryDeal.id}`
          : m.primaryContact?.id != null
          ? `/contacts/${m.primaryContact.id}`
          : m.primaryCompany?.id != null
          ? `/companies/${m.primaryCompany.id}`
          : null,
    },
  }));

  return (
    <div className="surface-elevated h-[calc(100dvh-18rem)] min-h-[480px] overflow-hidden rounded-xl p-2 sm:p-3 md:p-5">
      <FullCalendar
        plugins={[dayGridPlugin, interactionPlugin]}
        initialView="dayGridMonth"
        headerToolbar={{
          left: 'prev,next today',
          center: 'title',
          right: 'dayGridMonth,dayGridWeek',
        }}
        buttonText={{ today: 'Today', month: 'Month', week: 'Week' }}
        events={events}
        height="100%"
        expandRows
        dayMaxEvents
        eventClick={(info) => {
          info.jsEvent.preventDefault();
          const target = info.event.extendedProps.navigateTo as string | null;
          if (target) navigate(target);
        }}
      />
    </div>
  );
}
