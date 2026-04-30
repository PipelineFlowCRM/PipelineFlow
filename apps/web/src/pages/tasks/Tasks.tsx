import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import interactionPlugin from '@fullcalendar/interaction';
import { Calendar, Check, ListChecks, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api } from '@/lib/api';
import type { TaskDto } from '@/types';

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

function TaskCalendar() {
  const { data } = useQuery({
    queryKey: ['tasks', 'all'],
    queryFn: () => api.get<{ tasks: TaskDto[] }>('/tasks'),
  });
  const events = (data?.tasks ?? [])
    .filter((t) => t.dueDate)
    .map((t) => ({
      id: String(t.id),
      title: t.title,
      start: t.dueDate!,
      url: t.deal ? `/deals/${t.deal.id}` : undefined,
      color: t.status === 'completed' ? '#94a3b8' : '#6366f1',
    }));
  return (
    <Card>
      <CardContent className="p-2 md:p-4">
        <FullCalendar
          plugins={[dayGridPlugin, interactionPlugin]}
          initialView="dayGridMonth"
          headerToolbar={{ left: 'prev,next today', center: 'title', right: 'dayGridMonth,dayGridWeek' }}
          events={events}
          height="auto"
          eventClick={(info) => {
            if (info.event.url) {
              info.jsEvent.preventDefault();
              window.location.href = info.event.url;
            }
          }}
        />
      </CardContent>
    </Card>
  );
}
