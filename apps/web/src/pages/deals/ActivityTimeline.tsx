import {
  Check, FilePlus2, FileX2, MessageSquarePlus, Pencil, Plus, Sparkles,
  Trophy, XCircle, type LucideIcon,
} from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { cn, initials } from '@/lib/utils';
import type { ActivityDto } from '@/types';

interface Props {
  activities: ActivityDto[];
}

// Each known `kind` maps to an icon + a color token that drives the dot,
// the tinted ring around it, and the kind tag. Unknown kinds (forward-
// compat with future event types or older rows) fall through to a neutral
// styling via the `defaults` entry.
type KindStyle = {
  icon: LucideIcon;
  // A Tailwind color stem like "emerald" / "blue" / "rose". The component
  // expands this into bg-{stem}-50, text-{stem}-600, ring-{stem}-200, etc.
  // Listed explicitly below so Tailwind's JIT picks up the class names —
  // dynamic interpolation alone wouldn't survive purge.
  tone: 'emerald' | 'blue' | 'amber' | 'rose' | 'violet' | 'sky' | 'slate';
  label: string;
};

const KIND_STYLES: Record<string, KindStyle> = {
  created: { icon: Sparkles, tone: 'violet', label: 'Created' },
  stage_changed: { icon: Pencil, tone: 'blue', label: 'Stage changed' },
  deal_won: { icon: Trophy, tone: 'emerald', label: 'Won' },
  deal_lost: { icon: XCircle, tone: 'rose', label: 'Lost' },
  note_added: { icon: MessageSquarePlus, tone: 'sky', label: 'Note' },
  task_added: { icon: Plus, tone: 'sky', label: 'Task' },
  task_completed: { icon: Check, tone: 'emerald', label: 'Task done' },
  file_added: { icon: FilePlus2, tone: 'amber', label: 'File added' },
  file_deleted: { icon: FileX2, tone: 'rose', label: 'File deleted' },
  field_updated: { icon: Pencil, tone: 'slate', label: 'Updated' },
};

const FALLBACK_STYLE: KindStyle = {
  icon: Pencil,
  tone: 'slate',
  label: 'Activity',
};

// Tailwind class lookups for each tone. Listed verbatim so the JIT can see
// every class string at build time — never construct these dynamically
// (`bg-${tone}-50`) or they'll get purged.
const TONE_CLASSES: Record<KindStyle['tone'], { dot: string; ring: string; chip: string }> = {
  emerald: {
    dot: 'bg-emerald-500 text-white',
    ring: 'ring-emerald-100 dark:ring-emerald-900/40',
    chip: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300',
  },
  blue: {
    dot: 'bg-blue-500 text-white',
    ring: 'ring-blue-100 dark:ring-blue-900/40',
    chip: 'bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-300',
  },
  amber: {
    dot: 'bg-amber-500 text-white',
    ring: 'ring-amber-100 dark:ring-amber-900/40',
    chip: 'bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300',
  },
  rose: {
    dot: 'bg-rose-500 text-white',
    ring: 'ring-rose-100 dark:ring-rose-900/40',
    chip: 'bg-rose-50 text-rose-700 dark:bg-rose-900/20 dark:text-rose-300',
  },
  violet: {
    dot: 'bg-violet-500 text-white',
    ring: 'ring-violet-100 dark:ring-violet-900/40',
    chip: 'bg-violet-50 text-violet-700 dark:bg-violet-900/20 dark:text-violet-300',
  },
  sky: {
    dot: 'bg-sky-500 text-white',
    ring: 'ring-sky-100 dark:ring-sky-900/40',
    chip: 'bg-sky-50 text-sky-700 dark:bg-sky-900/20 dark:text-sky-300',
  },
  slate: {
    dot: 'bg-slate-400 text-white',
    ring: 'ring-slate-100 dark:ring-slate-700',
    chip: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  },
};

// Group label for a given activity. Today/Yesterday read more naturally
// than the bare ISO date and are common in timeline UIs; older rows fall
// back to a localized full date.
function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const startOfToday = new Date(
    today.getFullYear(), today.getMonth(), today.getDate(),
  ).getTime();
  const startOfActivity = new Date(
    d.getFullYear(), d.getMonth(), d.getDate(),
  ).getTime();
  const dayDiff = Math.round((startOfToday - startOfActivity) / 86_400_000);
  if (dayDiff === 0) return 'Today';
  if (dayDiff === 1) return 'Yesterday';
  if (dayDiff > 0 && dayDiff < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  });
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function ActivityTimeline({ activities }: Props) {
  if (activities.length === 0) {
    return (
      <div className="rounded-lg border border-dashed bg-muted/30 p-8 text-center text-sm text-muted-foreground">
        No activity yet.
      </div>
    );
  }

  // Group consecutive entries by their day label. The activities array
  // arrives sorted desc by createdAt, so a single forward pass produces
  // the right grouping without re-sorting.
  const groups: { label: string; items: ActivityDto[] }[] = [];
  for (const a of activities) {
    const label = dayLabel(a.createdAt);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(a);
    else groups.push({ label, items: [a] });
  }

  return (
    <div className="space-y-6">
      {groups.map((group) => (
        <section key={group.label} className="space-y-3">
          <div className="flex items-center gap-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {group.label}
            </h3>
            <div className="h-px flex-1 bg-border" />
          </div>

          {/* Vertical rail behind the dots. The relative wrapper anchors
              an absolutely-positioned 1px line; each row's dot sits on top
              of it via the same horizontal offset. The line stops short
              of the last item so it doesn't dangle past the final dot. */}
          <div className="relative">
            <div
              aria-hidden="true"
              className="absolute left-[15px] top-2 bottom-2 w-px bg-border"
            />
            <ul className="space-y-3">
              {group.items.map((a) => (
                <TimelineRow key={a.id} activity={a} />
              ))}
            </ul>
          </div>
        </section>
      ))}
    </div>
  );
}

function TimelineRow({ activity }: { activity: ActivityDto }) {
  const style = KIND_STYLES[activity.kind] ?? FALLBACK_STYLE;
  const Icon = style.icon;
  const tone = TONE_CLASSES[style.tone];
  const actorName = activity.actor?.name ?? 'System';

  return (
    <li className="relative flex gap-4">
      {/* Dot — sits over the rail. Ring gives a soft halo so the colored
          dot reads even when the row is small. `shrink-0` keeps it round
          when the summary text is long. */}
      <div
        className={cn(
          'relative z-[1] mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-4',
          tone.dot,
          tone.ring,
        )}
        aria-hidden="true"
      >
        <Icon className="h-4 w-4" strokeWidth={2.25} />
      </div>

      {/* Body card — the day-group header above already carries the date,
          so each row only shows the clock time plus the absolute timestamp
          on hover via the title attribute. No hover state on the card
          itself: rows aren't (yet) interactive and the affordance was
          misleading. */}
      <div className="min-w-0 flex-1 rounded-lg border bg-card px-3 py-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span
            className={cn(
              'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wide',
              tone.chip,
            )}
          >
            {style.label}
          </span>
          <span className="truncate text-sm font-medium">{activity.summary}</span>
        </div>

        <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
          {/* The default AvatarFallback styling is `text-xs` (12px), which
              fills a 20px circle edge-to-edge for two-character initials.
              Drop the font size + tighten line-height so "DU"-style
              initials sit centered with a comfortable margin. */}
          <Avatar className="h-5 w-5">
            <AvatarFallback
              className="text-[9px] leading-none"
              color={activity.actor?.avatarColor ?? '#94a3b8'}
            >
              {initials(actorName)}
            </AvatarFallback>
          </Avatar>
          <span className="truncate">{actorName}</span>
          <span aria-hidden="true">·</span>
          <time
            dateTime={activity.createdAt}
            title={new Date(activity.createdAt).toLocaleString()}
            className="tabular-nums"
          >
            {timeLabel(activity.createdAt)}
          </time>
        </div>
      </div>
    </li>
  );
}
