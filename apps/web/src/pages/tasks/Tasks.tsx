import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import interactionPlugin from '@fullcalendar/interaction';
import { Calendar, Check, ListChecks, Trash2, Trophy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api } from '@/lib/api';
import { formatMoneyShort } from '@/lib/utils';
import type { DealDto, TaskDto } from '@/types';

export function Tasks() {
  const [tab, setTab] = useState('list');
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Tasks</h1>
        <p className="text-sm text-muted-foreground">Everything that needs your attention.</p>
      </div>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="list"><ListChecks className="mr-1 h-3.5 w-3.5" /> List</TabsTrigger>
          <TabsTrigger value="calendar"><Calendar className="mr-1 h-3.5 w-3.5" /> Calendar</TabsTrigger>
        </TabsList>
        <TabsContent value="list"><TaskList /></TabsContent>
        <TabsContent value="calendar"><TaskCalendar /></TabsContent>
      </Tabs>
    </div>
  );
}

function TaskList() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['tasks', 'mine'],
    queryFn: () => api.get<{ tasks: TaskDto[] }>('/tasks?mine=true'),
  });
  const toggle = useMutation({
    mutationFn: (id: number) => api.post(`/tasks/${id}/toggle`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks'] }),
  });
  const del = useMutation({
    mutationFn: (id: number) => api.delete(`/tasks/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks'] }),
  });

  const pending = data?.tasks.filter((t) => t.status === 'pending') ?? [];
  const done = data?.tasks.filter((t) => t.status === 'completed') ?? [];

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader><CardTitle className="text-base">Open ({pending.length})</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {pending.length === 0 ? <p className="text-sm text-muted-foreground">All clear.</p> : null}
          {pending.map((t) => (
            <Row key={t.id} task={t} onToggle={() => toggle.mutate(t.id)} onDelete={() => del.mutate(t.id)} />
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">Completed ({done.length})</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {done.map((t) => (
            <Row key={t.id} task={t} onToggle={() => toggle.mutate(t.id)} onDelete={() => del.mutate(t.id)} />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function Row({
  task, onToggle, onDelete,
}: {
  task: TaskDto;
  onToggle: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-md border p-2 text-sm">
      <button
        onClick={onToggle}
        className={`grid h-5 w-5 place-items-center rounded border ${task.status === 'completed' ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'}`}
      >
        {task.status === 'completed' ? <Check className="h-3 w-3" /> : null}
      </button>
      <div className="flex-1 min-w-0">
        <div className={`truncate ${task.status === 'completed' ? 'text-muted-foreground line-through' : ''}`}>
          {task.title}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {task.deal ? <Link to={`/deals/${task.deal.id}`} className="hover:underline">{task.deal.title}</Link> : null}
          {task.dueDate ? <span className="ml-2">due {task.dueDate}</span> : null}
        </div>
      </div>
      <Button variant="ghost" size="icon" onClick={onDelete}><Trash2 /></Button>
    </div>
  );
}

type CalEventKind = 'task-pending' | 'task-done' | 'win';

const KIND_ORDER: Record<CalEventKind, number> = { win: 0, 'task-pending': 1, 'task-done': 2 };

/** Convert an ISO timestamp to YYYY-MM-DD in the user's local timezone.
 *  closedAt is a UTC datetime, so a naive slice(0,10) would shift the
 *  milestone by a day for users west of UTC after ~4pm local time. */
function localDateOf(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA');
}

function TaskCalendar() {
  const navigate = useNavigate();
  const { data: tasksData } = useQuery({
    queryKey: ['tasks', 'all'],
    queryFn: () => api.get<{ tasks: TaskDto[] }>('/tasks'),
    staleTime: 30_000,
  });
  const { data: dealsData } = useQuery({
    queryKey: ['deals', 'calendar'],
    queryFn: () => api.get<{ deals: DealDto[] }>('/deals'),
    staleTime: 30_000,
  });

  let pendingCount = 0;
  let doneCount = 0;
  const taskEvents = (tasksData?.tasks ?? [])
    .filter((t) => t.dueDate)
    .map((t) => {
      const kind: CalEventKind = t.status === 'completed' ? 'task-done' : 'task-pending';
      if (kind === 'task-done') doneCount += 1; else pendingCount += 1;
      return {
        id: `task-${t.id}`,
        title: t.title,
        start: t.dueDate!,
        allDay: true,
        url: t.deal ? `/deals/${t.deal.id}` : undefined,
        extendedProps: { kind },
      };
    });

  const winEvents = (dealsData?.deals ?? [])
    .filter((d) => d.stage?.isWon && d.closedAt)
    .map((d) => ({
      id: `win-${d.id}`,
      title: d.title,
      start: localDateOf(d.closedAt!),
      allDay: true,
      url: `/deals/${d.id}`,
      extendedProps: {
        kind: 'win' as CalEventKind,
        amount: formatMoneyShort(d.amount),
      },
    }));

  const events = [...winEvents, ...taskEvents];

  return (
    <div className="flex flex-col gap-3 pb-2">
      <CalendarLegend pending={pendingCount} done={doneCount} wins={winEvents.length} />
      <div className="surface-elevated h-[calc(100dvh-18rem)] min-h-[480px] overflow-hidden rounded-xl p-2 sm:p-3 md:p-5">
        <FullCalendar
          plugins={[dayGridPlugin, interactionPlugin]}
          initialView="dayGridMonth"
          headerToolbar={{ left: 'prev,next today', center: 'title', right: 'dayGridMonth,dayGridWeek' }}
          buttonText={{ today: 'Today', month: 'Month', week: 'Week' }}
          events={events}
          height="100%"
          expandRows
          dayMaxEvents={true}
          fixedWeekCount={false}
          eventOrder={(a: unknown, b: unknown) => {
            const ak = (a as { extendedProps: { kind: CalEventKind } }).extendedProps.kind;
            const bk = (b as { extendedProps: { kind: CalEventKind } }).extendedProps.kind;
            return KIND_ORDER[ak] - KIND_ORDER[bk];
          }}
          eventClassNames={(arg) => `cal-event cal-event-${arg.event.extendedProps.kind as CalEventKind}`}
          eventContent={(arg) => {
            const kind = arg.event.extendedProps.kind as CalEventKind;
            if (kind === 'win') {
              return (
                <div className="cal-win-chip">
                  <Trophy className="cal-event-icon" aria-hidden />
                  <span className="cal-event-title">{arg.event.title}</span>
                  <span className="cal-event-amount tabular">{arg.event.extendedProps.amount as string}</span>
                </div>
              );
            }
            return (
              <div className="cal-task-chip">
                <span className="cal-task-dot" aria-hidden />
                <span className="cal-event-title">{arg.event.title}</span>
              </div>
            );
          }}
          eventClick={(info) => {
            if (info.event.url) {
              info.jsEvent.preventDefault();
              navigate(info.event.url);
            }
          }}
        />
      </div>
    </div>
  );
}

function CalendarLegend({ pending, done, wins }: { pending: number; done: number; wins: number }) {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-1 text-xs text-muted-foreground">
      <LegendItem
        swatch={<span className="h-2.5 w-2.5 rounded-full" style={{ background: 'hsl(var(--brand))' }} />}
        label="Pending tasks"
        count={pending}
      />
      <LegendItem
        swatch={<span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/40 ring-1 ring-border" />}
        label="Completed tasks"
        count={done}
      />
      <LegendItem
        swatch={
          <span className="grid h-4 w-4 place-items-center rounded-full text-white shadow-sm"
                style={{ background: 'var(--gradient-brand)' }}>
            <Trophy className="h-2.5 w-2.5" aria-hidden />
          </span>
        }
        label="Won deals"
        count={wins}
      />
    </div>
  );
}

function LegendItem({ swatch, label, count }: { swatch: ReactNode; label: string; count: number }) {
  return (
    <span className="inline-flex items-center gap-2">
      {swatch}
      <span>{label}</span>
      <span className="tabular text-foreground/70">{count}</span>
    </span>
  );
}
