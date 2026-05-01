// Inline rename + recolor + delete UI for a tag. Opens as a Radix Popover
// anchored to whatever trigger the caller renders. Used both inside the
// TagPicker (per-row pencil) and from chips on detail pages.

import { Trash2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { toast } from 'sonner';
import type { TagDto } from '@/types';
import { TAG_PALETTE } from './tagPalette';
import { useDeleteTag, useTags, useUpdateTag } from './useTags';

interface Props {
  tag: TagDto;
  /** The trigger element (chip, pencil button, etc.). Receives no ref. */
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  align?: 'start' | 'center' | 'end';
  /**
   * Called after a successful delete. Lets the caller (e.g. TagPicker) drop
   * the deleted tag from its selection state so a subsequent save doesn't
   * send a dead tagId. Cache invalidation alone isn't enough — pickers hold
   * the selection in parent-owned state outside the cache.
   */
  onDeleted?: (tagId: number) => void;
}

export function TagEditPopover({
  tag,
  children,
  open,
  onOpenChange,
  align = 'start',
  onDeleted,
}: Props) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = open !== undefined;
  const isOpen = isControlled ? open : internalOpen;
  const setOpen = (v: boolean) => {
    if (!isControlled) setInternalOpen(v);
    onOpenChange?.(v);
  };

  return (
    <Popover open={isOpen} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align={align} className="w-72 p-3">
        {isOpen ? (
          <Body
            tag={tag}
            onClose={() => setOpen(false)}
            onDeleted={onDeleted}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function Body({
  tag,
  onClose,
  onDeleted,
}: {
  tag: TagDto;
  onClose: () => void;
  onDeleted?: (tagId: number) => void;
}) {
  const [name, setName] = useState(tag.name);
  const [color, setColor] = useState(tag.color);
  const [showConfirmDelete, setShowConfirmDelete] = useState(false);
  const { data: countsData } = useTags();
  const update = useUpdateTag();
  const remove = useDeleteTag();

  // Reset local state when the tag identity changes (caller reusing the
  // popover across different tags).
  useEffect(() => {
    setName(tag.name);
    setColor(tag.color);
  }, [tag.id, tag.name, tag.color]);

  const counts = countsData?.tags.find((t) => t.id === tag.id)?.counts;
  const dirty = name.trim() !== tag.name || color !== tag.color;

  const onSave = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const patch: { name?: string; color?: string } = {};
    if (trimmed !== tag.name) patch.name = trimmed;
    if (color !== tag.color) patch.color = color;
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    try {
      await update.mutateAsync({ id: tag.id, patch });
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        toast.error('A tag with that name already exists.');
      } else {
        toast.error((e as Error).message);
      }
    }
  };

  const onDelete = async () => {
    try {
      await remove.mutateAsync(tag.id);
      toast.success('Tag deleted');
      onDeleted?.(tag.id);
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <div className="space-y-3">
      <div>
        <label className="mb-1 block text-xs font-medium text-muted-foreground">Name</label>
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void onSave();
            }
          }}
          maxLength={40}
          className="h-8"
        />
      </div>
      <div>
        <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Color</label>
        <div className="flex flex-wrap items-center gap-1.5">
          {TAG_PALETTE.map((swatch) => (
            <button
              key={swatch}
              type="button"
              aria-label={`Choose color ${swatch}`}
              onClick={() => setColor(swatch)}
              style={{ background: swatch }}
              className={`h-6 w-6 rounded-full ring-offset-background transition focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1 ${
                color === swatch ? 'ring-2 ring-ring' : ''
              }`}
            />
          ))}
          <input
            type="color"
            aria-label="Custom color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            className="h-6 w-6 cursor-pointer rounded-full border-0 bg-transparent p-0"
          />
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 pt-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={() => setShowConfirmDelete(true)}
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete
        </Button>
        <div className="flex gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!dirty || !name.trim() || update.isPending}
            onClick={() => void onSave()}
          >
            Save
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={showConfirmDelete}
        onOpenChange={setShowConfirmDelete}
        title={`Delete tag "${tag.name}"?`}
        description={
          counts
            ? `Will detach from ${counts.deals} deal${counts.deals === 1 ? '' : 's'}, ${counts.companies} compan${counts.companies === 1 ? 'y' : 'ies'}, and ${counts.contacts} contact${counts.contacts === 1 ? '' : 's'}.`
            : 'The tag is removed from every record it was attached to.'
        }
        confirmLabel="Delete tag"
        busy={remove.isPending}
        onConfirm={onDelete}
      />
    </div>
  );
}
