// Search-and-create tag picker. cmdk-based popover; type to filter, Enter or
// click "Create '<query>'" to mint a new tag (auto-coloured from the palette);
// click an item to toggle membership; hover-pencil to inline-edit (rename /
// recolor / delete) without leaving the picker.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Command } from 'cmdk';
import { Check, Pencil, Plus, Tag as TagIcon } from 'lucide-react';
import { ApiError } from '@/lib/api';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import type { TagDto, TaggableEntity, TagWithCountsDto } from '@/types';
import { TagChip } from './TagChip';
import { TagEditPopover } from './TagEditPopover';
import { pickColorFor } from './tagPalette';
import { useCreateTag, useTags } from './useTags';

interface TagPickerProps {
  value: TagDto[];
  onChange: (next: TagDto[]) => void;
  // entityType is reserved for future analytics + per-entity recents; kept on
  // the API now so callers don't need to wire it later.
  entityType: TaggableEntity;
  placeholder?: string;
  disabled?: boolean;
  align?: 'start' | 'center' | 'end';
  className?: string;
}

export function TagPicker({
  value,
  onChange,
  placeholder = 'Add tag…',
  disabled,
  align = 'start',
  className,
}: TagPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const { data, isLoading } = useTags();
  const createTag = useCreateTag();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  // Sort: usage-desc, then alpha. (Picker's "recents-first" UX.)
  const sortedAll: TagWithCountsDto[] = useMemo(() => {
    const tags = data?.tags ?? [];
    return [...tags].sort((a, b) => {
      const ad = a.counts?.total ?? 0;
      const bd = b.counts?.total ?? 0;
      if (ad !== bd) return bd - ad;
      return a.name.localeCompare(b.name);
    });
  }, [data]);

  const selectedIds = useMemo(() => new Set(value.map((t) => t.id)), [value]);
  const queryTrimmed = query.trim();
  const queryLower = queryTrimmed.toLowerCase();
  const filtered = useMemo(() => {
    if (!queryTrimmed) return sortedAll;
    return sortedAll.filter((t) => t.name.toLowerCase().includes(queryLower));
  }, [sortedAll, queryTrimmed, queryLower]);
  const exactMatch = useMemo(
    () => sortedAll.some((t) => t.name.toLowerCase() === queryLower),
    [sortedAll, queryLower],
  );
  const canCreate = queryTrimmed.length > 0 && !exactMatch;

  const toggle = (tag: TagDto) => {
    if (selectedIds.has(tag.id)) {
      onChange(value.filter((t) => t.id !== tag.id));
    } else {
      onChange([...value, tag]);
    }
  };

  const handleCreate = async () => {
    const name = queryTrimmed;
    if (!name) return;
    try {
      const result = await createTag.mutateAsync({ name, color: pickColorFor(name) });
      if (!selectedIds.has(result.tag.id)) {
        onChange([...value, result.tag]);
      }
      setQuery('');
      // Re-focus input so the user can keep typing.
      inputRef.current?.focus();
    } catch (e) {
      if (e instanceof ApiError) {
        toast.error(e.message);
      } else {
        toast.error('Failed to create tag');
      }
    }
  };

  const handleRemove = (tag: TagDto) => {
    onChange(value.filter((t) => t.id !== tag.id));
  };

  // Drop a tag from selection when it's deleted from inside the picker's
  // edit popover — otherwise the parent entity's save would send a dead
  // tagId and the API would 404.
  const handleDeleted = (tagId: number) => {
    if (selectedIds.has(tagId)) {
      onChange(value.filter((t) => t.id !== tagId));
    }
  };

  return (
    <Popover open={open} onOpenChange={(v) => !disabled && setOpen(v)}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            'flex min-h-9 w-full flex-wrap items-center gap-1 rounded-md border border-input bg-background px-2 py-1.5 text-left text-sm shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50',
            className,
          )}
        >
          {value.length === 0 ? (
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Plus className="h-3.5 w-3.5" />
              {placeholder}
            </span>
          ) : (
            value.map((tag) => (
              <TagChip
                key={tag.id}
                tag={tag}
                onRemove={() => handleRemove(tag)}
              />
            ))
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align={align} className="w-72 p-0" onOpenAutoFocus={(e) => {
        // Let cmdk handle focus inside its input.
        e.preventDefault();
        inputRef.current?.focus();
      }}>
        <Command shouldFilter={false} loop>
          <div className="flex items-center border-b px-2">
            <TagIcon className="mr-2 h-3.5 w-3.5 text-muted-foreground" />
            <Command.Input
              ref={inputRef}
              value={query}
              onValueChange={setQuery}
              placeholder="Search or create…"
              className="flex h-9 w-full bg-transparent py-2 text-sm outline-none placeholder:text-muted-foreground"
              onKeyDown={(e) => {
                if (e.key === 'Backspace' && query === '' && value.length > 0) {
                  e.preventDefault();
                  onChange(value.slice(0, -1));
                }
              }}
            />
          </div>
          <Command.List className="max-h-64 overflow-y-auto p-1">
            {isLoading ? (
              <div className="py-4 text-center text-xs text-muted-foreground">Loading…</div>
            ) : null}
            <Command.Empty className="py-4 text-center text-xs text-muted-foreground">
              {canCreate ? null : 'No tags found.'}
            </Command.Empty>
            {filtered.map((tag) => (
              <PickerRow
                key={tag.id}
                tag={tag}
                selected={selectedIds.has(tag.id)}
                onToggle={() => toggle(tag)}
                onDeleted={handleDeleted}
              />
            ))}
            {canCreate ? (
              <Command.Item
                value={`__create__${queryTrimmed}`}
                onSelect={() => void handleCreate()}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground"
              >
                <Plus className="h-3.5 w-3.5" />
                Create &ldquo;{queryTrimmed}&rdquo;
              </Command.Item>
            ) : null}
          </Command.List>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function PickerRow({
  tag,
  selected,
  onToggle,
  onDeleted,
}: {
  tag: TagDto;
  selected: boolean;
  onToggle: () => void;
  onDeleted: (tagId: number) => void;
}) {
  const [editOpen, setEditOpen] = useState(false);
  return (
    <Command.Item
      value={tag.name}
      onSelect={onToggle}
      className="group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground"
    >
      <span
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ background: tag.color }}
      />
      <span className="flex-1 truncate">{tag.name}</span>
      {selected ? <Check className="h-3.5 w-3.5 text-muted-foreground" /> : null}
      <TagEditPopover
        tag={tag}
        open={editOpen}
        onOpenChange={setEditOpen}
        align="end"
        onDeleted={onDeleted}
      >
        <button
          type="button"
          aria-label={`Edit ${tag.name}`}
          onClick={(e) => {
            e.stopPropagation();
            setEditOpen(true);
          }}
          onPointerDown={(e) => {
            // Stop cmdk from interpreting this as a row select.
            e.stopPropagation();
          }}
          className={cn(
            'rounded p-1 text-muted-foreground opacity-0 transition group-aria-selected:opacity-100 hover:bg-background hover:text-foreground',
            editOpen && 'opacity-100',
          )}
        >
          <Pencil className="h-3 w-3" />
        </button>
      </TagEditPopover>
    </Command.Item>
  );
}
