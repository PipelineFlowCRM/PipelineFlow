import type { TagDto } from '@/types';
import { TagChip } from './TagChip';

interface TagsCellProps {
  tags?: TagDto[];
  /** Max chips to render before collapsing the rest into a +N indicator. */
  max?: number;
}

export function TagsCell({ tags, max = 2 }: TagsCellProps) {
  if (!tags || tags.length === 0) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  const visible = tags.slice(0, max);
  const overflow = tags.length - visible.length;
  return (
    <div className="flex flex-nowrap items-center gap-1 overflow-hidden">
      {visible.map((t) => (
        <TagChip key={t.id} tag={t} className="shrink-0" />
      ))}
      {overflow > 0 ? (
        <span className="shrink-0 text-[10px] font-medium text-muted-foreground">
          +{overflow}
        </span>
      ) : null}
    </div>
  );
}
