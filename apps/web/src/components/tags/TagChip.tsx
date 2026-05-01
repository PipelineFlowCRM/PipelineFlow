import { forwardRef } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TagDto } from '@/types';

interface TagChipOwnProps {
  tag: TagDto;
  onRemove?: (e: React.MouseEvent) => void;
  size?: 'sm' | 'md';
  /** Render the trigger as a button (otherwise a span) — set when clickable. */
  interactive?: boolean;
}

type TagChipProps = TagChipOwnProps &
  Omit<React.HTMLAttributes<HTMLElement>, 'children'> & {
    type?: 'button' | 'submit' | 'reset';
  };

const SIZES = {
  sm: 'px-2 py-0.5 text-xs',
  md: 'px-2.5 py-1 text-sm',
} as const;

// Forwards refs and spreads all incoming props so this works as a Radix
// `<PopoverTrigger asChild>` child. Without forwardRef + prop-spread, Radix
// can't anchor the popover to the chip and clicks don't open it.
export const TagChip = forwardRef<HTMLElement, TagChipProps>(function TagChip(
  { tag, onRemove, size = 'sm', interactive, className, onClick, type, ...rest },
  ref,
) {
  const isButton = interactive ?? Boolean(onClick);
  const content = (
    <>
      {tag.name}
      {onRemove ? (
        <button
          type="button"
          aria-label={`Remove ${tag.name}`}
          onClick={(e) => {
            e.stopPropagation();
            onRemove(e);
          }}
          className="ml-0.5 -mr-0.5 grid h-3.5 w-3.5 place-items-center rounded-full opacity-60 transition hover:opacity-100"
        >
          <X className="h-3 w-3" />
        </button>
      ) : null}
    </>
  );
  const sharedClass = cn(
    'inline-flex items-center gap-1 rounded-full font-medium',
    SIZES[size],
    isButton &&
      'cursor-pointer transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
    className,
  );
  const style = { background: `${tag.color}1f`, color: tag.color };
  if (isButton) {
    return (
      <button
        ref={ref as React.Ref<HTMLButtonElement>}
        type={type ?? 'button'}
        onClick={onClick}
        style={style}
        className={sharedClass}
        {...rest}
      >
        {content}
      </button>
    );
  }
  return (
    <span
      ref={ref as React.Ref<HTMLSpanElement>}
      onClick={onClick}
      style={style}
      className={sharedClass}
      {...rest}
    >
      {content}
    </span>
  );
});
