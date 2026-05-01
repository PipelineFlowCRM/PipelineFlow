import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  closestCorners,
  DndContext,
  DragEndEvent,
  DragOverEvent,
  DragOverlay,
  DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  UniqueIdentifier,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Plus } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import type { DealDto } from '@/types';
import { TagChip } from '@/components/tags/TagChip';
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

// Tokens disambiguate deal vs stage ids in dnd-kit's flat namespace.
const dealToken = (id: number) => `deal-${id}`;
const stageToken = (id: number) => `stage-${id}`;
function parseToken(token: UniqueIdentifier): { kind: 'deal' | 'stage'; id: number } | null {
  const s = String(token);
  const prefix = s.startsWith('deal-') ? 'deal' : s.startsWith('stage-') ? 'stage' : null;
  if (!prefix) return null;
  const id = Number(s.slice(prefix.length + 1));
  if (!Number.isFinite(id)) return null;
  return { kind: prefix, id };
}

export function Pipeline() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['board'],
    queryFn: () => api.get<{ stages: BoardStage[] }>('/deals/board'),
  });

  // Mirror server data into local state so we can show drop-target previews
  // (cross-column moves) live during a drag.
  const [stages, setStages] = useState<BoardStage[]>([]);
  const stagesRef = useRef(stages);
  stagesRef.current = stages;
  const [activeDealId, setActiveDealId] = useState<number | null>(null);
  const isDraggingRef = useRef(false);
  // Snapshot taken at drag start so we can restore on mutation error without
  // racing the React Query cache.
  const preDragStagesRef = useRef<BoardStage[] | null>(null);
  useEffect(() => {
    if (!isDraggingRef.current && data?.stages) setStages(data.stages);
  }, [data?.stages]);

  const moveMut = useMutation({
    mutationFn: ({ dealId, stageId, position }: { dealId: number; stageId: number; position: number }) =>
      api.post(`/deals/${dealId}/move`, { stageId, position }),
    onError: (err) => {
      toast.error((err as Error).message || 'Failed to move deal');
      const snapshot = preDragStagesRef.current ?? data?.stages;
      if (snapshot) setStages(snapshot);
    },
    onSettled: () => {
      preDragStagesRef.current = null;
      qc.invalidateQueries({ queryKey: ['board'] });
    },
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const activeDeal = activeDealId
    ? stages.flatMap((s) => s.deals).find((d) => d.id === activeDealId) ?? null
    : null;

  function onDragStart(e: DragStartEvent) {
    const t = parseToken(e.active.id);
    if (t?.kind !== 'deal') return;
    isDraggingRef.current = true;
    preDragStagesRef.current = stagesRef.current;
    setActiveDealId(t.id);
  }

  function onDragOver(e: DragOverEvent) {
    const { active, over } = e;
    if (!over) return;
    const activeT = parseToken(active.id);
    const overT = parseToken(over.id);
    if (activeT?.kind !== 'deal' || !overT) return;

    setStages((current) => {
      const fromStage = current.find((s) => s.deals.some((d) => d.id === activeT.id));
      const movingDeal = fromStage?.deals.find((d) => d.id === activeT.id);
      if (!fromStage || !movingDeal) return current;

      const toStage =
        overT.kind === 'stage'
          ? current.find((s) => s.id === overT.id)
          : current.find((s) => s.deals.some((d) => d.id === overT.id));
      if (!toStage) return current;

      // Same-stage reordering is handled visually by SortableContext and
      // committed in onDragEnd — don't mutate state here.
      if (fromStage.id === toStage.id) return current;

      const insertAt =
        overT.kind === 'stage'
          ? toStage.deals.length
          : toStage.deals.findIndex((d) => d.id === overT.id);

      return current.map((s) => {
        if (s.id === fromStage.id) return { ...s, deals: s.deals.filter((d) => d.id !== activeT.id) };
        if (s.id === toStage.id) {
          const next = [...s.deals];
          next.splice(insertAt, 0, movingDeal);
          return { ...s, deals: next };
        }
        return s;
      });
    });
  }

  function onDragEnd(e: DragEndEvent) {
    isDraggingRef.current = false;
    setActiveDealId(null);

    const { active, over } = e;
    if (!over) return;
    const activeT = parseToken(active.id);
    const overT = parseToken(over.id);
    if (activeT?.kind !== 'deal' || !overT) return;

    const current = stagesRef.current;
    const stage = current.find((s) => s.deals.some((d) => d.id === activeT.id));
    if (!stage) return;
    const oldIndex = stage.deals.findIndex((d) => d.id === activeT.id);

    // Same-column reorder: arrayMove based on the card under the cursor.
    let newIndex = oldIndex;
    if (overT.kind === 'deal' && overT.id !== activeT.id) {
      const idx = stage.deals.findIndex((d) => d.id === overT.id);
      if (idx !== -1) newIndex = idx;
    }

    if (oldIndex !== newIndex) {
      setStages((prev) =>
        prev.map((s) =>
          s.id === stage.id ? { ...s, deals: arrayMove(s.deals, oldIndex, newIndex) } : s,
        ),
      );
    }

    // Decide whether the change is a true move vs. a no-op landing in the
    // original spot. Compare to server state.
    const original = data?.stages.find((s) => s.deals.some((d) => d.id === activeT.id));
    const originalIdx = original?.deals.findIndex((d) => d.id === activeT.id) ?? -1;
    const stageChanged = !original || original.id !== stage.id;
    if (stageChanged || originalIdx !== newIndex) {
      moveMut.mutate({ dealId: activeT.id, stageId: stage.id, position: newIndex });
    }
  }

  function onDragCancel() {
    isDraggingRef.current = false;
    setActiveDealId(null);
    if (data?.stages) setStages(data.stages);
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

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
      >
        <div className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-2 md:-mx-8 md:px-8">
          {stages.map((s) => (
            <Column key={s.id} stage={s} />
          ))}
        </div>
        <DragOverlay>{activeDeal ? <DealCardView deal={activeDeal} dragging /> : null}</DragOverlay>
      </DndContext>
    </div>
  );
}

function Column({ stage }: { stage: BoardStage }) {
  const { setNodeRef, isOver } = useDroppable({ id: stageToken(stage.id) });
  const total = stage.deals.reduce((s, d) => s + d.amount, 0);
  return (
    <div
      ref={setNodeRef}
      className={`flex w-72 shrink-0 flex-col rounded-xl transition-colors ${
        isOver ? 'bg-accent' : 'bg-muted/50'
      }`}
    >
      <div className="flex items-center justify-between px-3 pt-3 pb-2">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full" style={{ background: stage.color }} />
          <span className="text-[13px] font-semibold tracking-tight">{stage.name}</span>
          <span className="text-[11px] tabular text-muted-foreground">{stage.deals.length}</span>
        </div>
        <span className="text-[11px] tabular text-muted-foreground">{formatMoneyShort(total)}</span>
      </div>
      <SortableContext
        id={stageToken(stage.id)}
        items={stage.deals.map((d) => dealToken(d.id))}
        strategy={verticalListSortingStrategy}
      >
        <div className="flex min-h-[140px] flex-1 flex-col gap-2 px-2 pb-2">
          {stage.deals.map((d) => (
            <SortableDealCard key={d.id} deal={d} />
          ))}
          {stage.deals.length === 0 ? (
            <div className="flex flex-1 items-center justify-center px-4 py-6 text-center text-[11px] text-muted-foreground/70">
              Drop deals here
            </div>
          ) : null}
        </div>
      </SortableContext>
    </div>
  );
}

function SortableDealCard({ deal }: { deal: DealDto }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: dealToken(deal.id),
  });
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0 : undefined,
      }}
      {...attributes}
      {...listeners}
    >
      <DealCardView deal={deal} suppressLinkNav={isDragging} />
    </div>
  );
}

function DealCardView({
  deal,
  dragging,
  suppressLinkNav,
}: {
  deal: DealDto;
  dragging?: boolean;
  suppressLinkNav?: boolean;
}) {
  return (
    <Card
      className={`group cursor-grab select-none border-0 bg-card p-3 shadow-soft transition-shadow duration-150 hover:shadow-elevated active:cursor-grabbing ${
        dragging ? 'rotate-[0.6deg] shadow-elevated' : ''
      }`}
    >
      <Link
        to={`/deals/${deal.id}`}
        className="block"
        onClick={(e) => {
          if (suppressLinkNav) e.preventDefault();
        }}
      >
        <div className="text-[13.5px] font-medium leading-snug">{deal.title}</div>
        <div className="mt-1 truncate text-[11.5px] text-muted-foreground">{deal.company?.name ?? '—'}</div>
        <div className="mt-2.5 flex items-center justify-between">
          <span className="text-[12px] font-medium tabular">{formatMoney(deal.amount)}</span>
          <span className="text-[10.5px] tabular text-muted-foreground">{deal.probability}%</span>
        </div>
        {deal.tags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {deal.tags.slice(0, 3).map((t) => (
              <TagChip key={t.id} tag={t} />
            ))}
          </div>
        )}
      </Link>
    </Card>
  );
}
