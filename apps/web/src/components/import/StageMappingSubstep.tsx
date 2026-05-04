import { useQuery } from '@tanstack/react-query';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { api } from '@/lib/api';
import type { StageDto } from '@/types';

interface Props {
  // Distinct source-stage strings observed in the CSV. Computed by the
  // wizard from sample rows or surfaced after a dry-run.
  distinctStages: string[];
  stageMapping: Record<string, number>;
  onChange: (next: Record<string, number>) => void;
}

const UNMAPPED = '__unmapped__';

export function StageMappingSubstep({ distinctStages, stageMapping, onChange }: Props) {
  const { data } = useQuery({
    queryKey: ['stages'],
    queryFn: () => api.get<{ stages: StageDto[] }>('/stages'),
  });
  const stages = data?.stages ?? [];

  if (distinctStages.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border/70 p-3 text-xs text-muted-foreground">
        No source stage values detected yet. Run a dry-run first if your CSV
        actually has stages — every Deal needs one.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="text-xs text-muted-foreground">
        Map each source stage to a PipelineFlow stage. Every distinct value
        must be mapped before commit.
      </div>
      <div className="overflow-hidden rounded-md border border-border/70">
        <div className="grid grid-cols-[1fr_240px] gap-0 bg-muted/40 px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <div>Source stage</div>
          <div>PipelineFlow stage</div>
        </div>
        {distinctStages.map((src) => {
          const mappedId = stageMapping[src];
          const isUnmapped = mappedId == null;
          return (
            <div
              key={src}
              className="grid grid-cols-[1fr_240px] items-center gap-3 border-t border-border/70 px-3 py-2"
            >
              <div className="truncate text-sm font-medium" title={src}>
                {src}
              </div>
              <Select
                value={mappedId != null ? String(mappedId) : UNMAPPED}
                onValueChange={(v) => {
                  const next = { ...stageMapping };
                  if (v === UNMAPPED) delete next[src];
                  else next[src] = Number(v);
                  onChange(next);
                }}
              >
                <SelectTrigger className={isUnmapped ? 'text-amber-300' : ''}>
                  <SelectValue placeholder="Unmapped" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={UNMAPPED}>
                    <span className="text-muted-foreground">Unmapped</span>
                  </SelectItem>
                  {stages.map((s) => (
                    <SelectItem key={s.id} value={String(s.id)}>
                      <span className="inline-flex items-center gap-2">
                        <span
                          className="h-2 w-2 rounded-full"
                          style={{ backgroundColor: s.color }}
                        />
                        {s.name}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          );
        })}
      </div>
    </div>
  );
}
