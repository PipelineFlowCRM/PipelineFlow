import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DndContext, DragEndEvent, DragOverlay, DragStartEvent, PointerSensor, useDraggable, useDroppable,
  useSensor, useSensors,
} from '@dnd-kit/core';
import { Plus } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api';
import type { DealDto } from '@/types';
import { formatMoney, formatMoneyShort } from '@/lib/utils';
import { toast } from 'sonner';

interface BoardStage {
  id: number;
  name: string;
  color: string;
  order: number;
  isWon: boolean;
  isLost: boolean;
  deals: DealDto[];
}

export function Pipeline() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['board'],
    queryFn: () => api.get<{ stages: BoardStage[] }>('/deals/board'),
  });

  const moveMut = useMutation({
    mutationFn: ({ dealId, stageId }: { dealId: number; stageId: number }) =>
      api.post(`/deals/${dealId}/move`, { stageId }),
    onMutate: async ({ dealId, stageId }) => {
      await qc.cancelQueries({ queryKey: ['board'] });
      const prev = qc.getQueryData<{ stages: BoardStage[] }>(['board']);
      qc.setQueryData<{ stages: BoardStage[] } | undefined>(['board'], (old) => {
        if (!old) return old;
        let moved: DealDto | undefined;
        const stages = old.stages.map((s) => {
          const has = s.deals.find((d) => d.id === dealId);
          if (has) {
            moved = has;
            return { ...s, deals: s.deals.filter((d) => d.id !== dealId) };
          }
          return s;
        });
        if (!moved) return old;
        return {
          stages: stages.map((s) =>
            s.id === stageId ? { ...s, deals: [moved!, ...s.deals] } : s,
          ),
        };
      });
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(['board'], ctx.prev);
      toast.error((err as Error).message || 'Failed to move deal');
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['board'] }),
  });

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const [activeDeal, setActiveDeal] = useState<DealDto | null>(null);

  const stages = data?.stages ?? [];
  const dealById = useMemo(() => {
    const m = new Map<number, DealDto>();
    for (const s of stages) for (const d of s.deals) m.set(d.id, d);
    return m;
  }, [stages]);

  function onStart(e: DragStartEvent) {
    const id = Number(e.active.id);
    setActiveDeal(dealById.get(id) ?? null);
  }
  function onEnd(e: DragEndEvent) {
    setActiveDeal(null);
    if (!e.over) return;
    const dealId = Number(e.active.id);
    const stageId = Number(e.over.id);
    const deal = dealById.get(dealId);
    if (!deal || deal.stageId === stageId) return;
    moveMut.mutate({ dealId, stageId });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Pipeline</h1>
          <p className="text-sm text-muted-foreground">Drag deals across stages to update them.</p>
        </div>
        <Button asChild>
          <Link to="/deals/new"><Plus /> New deal</Link>
        </Button>
      </div>

      <DndContext sensors={sensors} onDragStart={onStart} onDragEnd={onEnd}>
        <div className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-2 md:-mx-8 md:px-8">
          {stages.map((s) => (
            <Column key={s.id} stage={s} />
          ))}
        </div>
        <DragOverlay>{activeDeal ? <DealCard deal={activeDeal} dragging /> : null}</DragOverlay>
      </DndContext>
    </div>
  );
}

function Column({ stage }: { stage: BoardStage }) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });
  const total = stage.deals.reduce((s, d) => s + d.amount, 0);
  return (
    <div className="flex w-72 shrink-0 flex-col rounded-xl border border-border/70 bg-card/40 shadow-soft">
      <div className="flex items-center justify-between border-b border-border/60 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span
            className="h-2 w-2 rounded-full"
            style={{ background: stage.color, boxShadow: `0 0 0 3px ${stage.color}24` }}
          />
          <span className="text-[13px] font-semibold tracking-tight">{stage.name}</span>
          <Badge
            variant="secondary"
            className="h-5 rounded-full bg-muted px-1.5 text-[10px] font-medium tabular text-muted-foreground"
          >
            {stage.deals.length}
          </Badge>
        </div>
        <span className="text-[11px] tabular text-muted-foreground">{formatMoneyShort(total)}</span>
      </div>
      <div
        ref={setNodeRef}
        className={`flex min-h-[140px] flex-col gap-2 p-2 transition-colors ${isOver ? 'bg-accent/40' : ''}`}
      >
        {stage.deals.map((d) => (
          <DealCard key={d.id} deal={d} />
        ))}
        {stage.deals.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/60 p-4 text-center text-[11px] text-muted-foreground">
            Drop deals here
          </div>
        ) : null}
      </div>
    </div>
  );
}

function DealCard({ deal, dragging }: { deal: DealDto; dragging?: boolean }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: deal.id });
  const style = transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : {};
  return (
    <Card
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={`group cursor-grab select-none border-border/70 bg-card p-3 shadow-soft transition-all hover:-translate-y-px hover:border-border hover:shadow-elevated active:cursor-grabbing ${
        dragging || isDragging ? 'rotate-[0.6deg] opacity-90 shadow-elevated' : ''
      }`}
    >
      <Link to={`/deals/${deal.id}`} className="block" onClick={(e) => isDragging && e.preventDefault()}>
        <div className="text-[13.5px] font-medium leading-snug">{deal.title}</div>
        <div className="mt-1 truncate text-[11.5px] text-muted-foreground">{deal.company?.name ?? '—'}</div>
        <div className="mt-2.5 flex items-center justify-between">
          <span className="text-[12px] font-medium tabular">{formatMoney(deal.amount)}</span>
          <span className="text-[10.5px] tabular text-muted-foreground">{deal.probability}%</span>
        </div>
        {deal.tags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {deal.tags.slice(0, 3).map((t) => (
              <span
                key={t.id}
                className="rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset"
                style={{ background: `${t.color}14`, color: t.color, boxShadow: `inset 0 0 0 1px ${t.color}33` }}
              >
                {t.name}
              </span>
            ))}
          </div>
        )}
      </Link>
    </Card>
  );
}
