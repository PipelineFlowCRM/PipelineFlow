import { cn } from '@/lib/utils';

export function StageBadge({
  name, color, className,
}: {
  name: string;
  color: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset',
        className,
      )}
      style={{
        background: `${color}14`,
        color,
        // ring uses ~25% of the stage color so the chip reads on every background
        boxShadow: `inset 0 0 0 1px ${color}33`,
      }}
    >
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ background: color, boxShadow: `0 0 0 2px ${color}26` }}
      />
      {name}
    </span>
  );
}
