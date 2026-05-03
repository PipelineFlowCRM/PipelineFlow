import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { ValidationError } from '@/lib/import/api';
import { cn } from '@/lib/utils';

interface Props {
  errors: ValidationError[];
}

const PAGE = 25;

export function ErrorRowList({ errors }: Props) {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(PAGE);

  if (errors.length === 0) return null;

  return (
    <div className="rounded-md border border-rose-500/30 bg-rose-500/5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm font-medium"
      >
        <span className="inline-flex items-center gap-2">
          {open ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
          {errors.length} error{errors.length === 1 ? '' : 's'}
        </span>
        <span className="text-xs text-muted-foreground">
          (showing {Math.min(shown, errors.length)} of {errors.length})
        </span>
      </button>
      {open ? (
        <div className="max-h-[360px] overflow-auto border-t border-rose-500/20">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-muted/40 text-left uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-1.5 font-medium">Row</th>
                <th className="px-3 py-1.5 font-medium">Column</th>
                <th className="px-3 py-1.5 font-medium">Value</th>
                <th className="px-3 py-1.5 font-medium">Reason</th>
              </tr>
            </thead>
            <tbody>
              {errors.slice(0, shown).map((e, i) => (
                <tr
                  key={`${e.row}-${i}`}
                  className={cn(
                    'border-t border-border/60',
                    e.row === 0 && 'bg-amber-500/5',
                  )}
                >
                  <td className="px-3 py-1.5 tabular-nums text-muted-foreground">
                    {e.row || '—'}
                  </td>
                  <td className="px-3 py-1.5 text-muted-foreground">
                    {e.column ?? '—'}
                  </td>
                  <td className="max-w-[180px] truncate px-3 py-1.5 font-mono text-[11px]">
                    {e.value ?? ''}
                  </td>
                  <td className="px-3 py-1.5">{e.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {shown < errors.length ? (
            <div className="border-t border-border/60 px-3 py-2 text-center">
              <button
                type="button"
                onClick={() => setShown((s) => s + PAGE)}
                className="text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                Show {Math.min(PAGE, errors.length - shown)} more
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
