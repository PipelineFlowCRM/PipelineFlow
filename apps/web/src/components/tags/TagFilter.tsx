// Multi-tag filter for list views. Popover-anchored cmdk multi-select with an
// AND/OR toggle. The parent owns the (tagIds, tagOp) state so it can mirror
// to URL params and share the value with the API query.

import { useEffect, useMemo, useState } from 'react';
import { Command } from 'cmdk';
import { Check, Tags } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import type { TagDto } from '@/types';
import { TagChip } from './TagChip';
import { useTags } from './useTags';

interface Props {
  selectedIds: number[];
  op: 'and' | 'or';
  onChange: (next: { ids: number[]; op: 'and' | 'or' }) => void;
}

export function TagFilter({ selectedIds, op, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const { data } = useTags();

  const sorted = useMemo(() => {
    const tags = data?.tags ?? [];
    return [...tags].sort((a, b) => {
      const ad = a.counts?.total ?? 0;
      const bd = b.counts?.total ?? 0;
      if (ad !== bd) return bd - ad;
      return a.name.localeCompare(b.name);
    });
  }, [data]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter((t) => t.name.toLowerCase().includes(q));
  }, [sorted, query]);

  const selected = useMemo(() => {
    const set = new Set(selectedIds);
    return sorted.filter((t) => set.has(t.id));
  }, [sorted, selectedIds]);

  // Drop ids that no longer exist in the live tag list — happens when a
  // selected tag is deleted elsewhere (Settings, another tab). Filter never
  // creates tags, so there's no optimistic-add race here.
  useEffect(() => {
    if (!data || selectedIds.length === 0) return;
    const liveIds = new Set(data.tags.map((t) => t.id));
    const survivors = selectedIds.filter((id) => liveIds.has(id));
    if (survivors.length !== selectedIds.length) {
      onChange({ ids: survivors, op });
    }
  }, [data, selectedIds, op, onChange]);

  const toggle = (tag: TagDto) => {
    if (selectedIds.includes(tag.id)) {
      onChange({ ids: selectedIds.filter((id) => id !== tag.id), op });
    } else {
      onChange({ ids: [...selectedIds, tag.id], op });
    }
  };

  const remove = (id: number) => {
    onChange({ ids: selectedIds.filter((x) => x !== id), op });
  };

  const clear = () => {
    onChange({ ids: [], op });
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm">
            <Tags className="mr-1 h-4 w-4" />
            Tags
            {selectedIds.length > 0 ? (
              <span className="ml-1 rounded-full bg-primary/10 px-1.5 text-[10px] font-semibold text-primary">
                {selectedIds.length}
              </span>
            ) : null}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-0">
          {selectedIds.length >= 2 ? (
            <div className="flex items-center gap-2 border-b px-3 py-2 text-xs">
              <span className="text-muted-foreground">Match</span>
              <ToggleAndOr
                value={op}
                onChange={(next) => onChange({ ids: selectedIds, op: next })}
              />
            </div>
          ) : null}
          <Command shouldFilter={false} loop>
            <div className="border-b px-2">
              <Command.Input
                value={query}
                onValueChange={setQuery}
                placeholder="Search tags…"
                className="flex h-9 w-full bg-transparent py-2 text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
            <Command.List className="max-h-64 overflow-y-auto p-1">
              <Command.Empty className="py-4 text-center text-xs text-muted-foreground">
                No tags found.
              </Command.Empty>
              {filtered.map((tag) => {
                const isSelected = selectedIds.includes(tag.id);
                return (
                  <Command.Item
                    key={tag.id}
                    value={tag.name}
                    onSelect={() => toggle(tag)}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground"
                  >
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ background: tag.color }}
                    />
                    <span className="flex-1 truncate">{tag.name}</span>
                    {isSelected ? (
                      <Check className="h-3.5 w-3.5 text-muted-foreground" />
                    ) : null}
                  </Command.Item>
                );
              })}
            </Command.List>
            {selectedIds.length > 0 ? (
              <div className="border-t p-1">
                <button
                  type="button"
                  onClick={clear}
                  className="w-full rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  Clear selection
                </button>
              </div>
            ) : null}
          </Command>
        </PopoverContent>
      </Popover>
      {selected.map((t) => (
        <TagChip key={t.id} tag={t} onRemove={() => remove(t.id)} />
      ))}
      {selected.length >= 2 ? (
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {op === 'and' ? 'all of these' : 'any of these'}
        </span>
      ) : null}
    </div>
  );
}

function ToggleAndOr({
  value,
  onChange,
}: {
  value: 'and' | 'or';
  onChange: (v: 'and' | 'or') => void;
}) {
  return (
    <div className="inline-flex rounded-md border bg-background p-0.5">
      {(['or', 'and'] as const).map((o) => (
        <button
          key={o}
          type="button"
          onClick={() => onChange(o)}
          className={cn(
            'rounded-sm px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide transition',
            value === o
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {o === 'or' ? 'Any' : 'All'}
        </button>
      ))}
    </div>
  );
}

