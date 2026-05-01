import type React from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import {
  KanbanSquare, KeyRound, SlidersHorizontal, Tag, UserCircle2, Webhook,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

type SectionLink = {
  to: string;
  label: string;
  icon: LucideIcon;
};

type SectionGroup = {
  // Group label shown above the section list on desktop. Mobile flattens
  // (with a thin divider between groups in the horizontal scroller).
  label: string;
  items: SectionLink[];
};

const SECTION_GROUPS: SectionGroup[] = [
  {
    label: 'Personal',
    items: [
      { to: '/settings/profile', label: 'Profile', icon: UserCircle2 },
    ],
  },
  {
    label: 'Workspace',
    items: [
      { to: '/settings/stages', label: 'Pipeline stages', icon: KanbanSquare },
      { to: '/settings/tags', label: 'Tags', icon: Tag },
      { to: '/settings/custom-fields', label: 'Custom fields', icon: SlidersHorizontal },
      { to: '/settings/webhooks', label: 'Webhooks', icon: Webhook },
      { to: '/settings/api-tokens', label: 'API tokens', icon: KeyRound },
    ],
  },
];

export function SettingsLayout() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">Workspace-level configuration.</p>
      </header>

      {/*
        Two surfaces, one source of truth:
        - md+: vertical nav rail on the left, content on the right.
        - <md: horizontal scrollable tabs above content.
        Both are NavLinks so deep-linking, browser back, and bookmarks
        all work the same way they do for top-level routes.
      */}
      <div className="grid gap-5 md:grid-cols-[220px_minmax(0,1fr)] md:gap-6">
        <DesktopNav />
        <MobileTabs />
        <main className="min-w-0">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function DesktopNav() {
  return (
    <nav
      aria-label="Settings sections"
      className="hidden md:block"
    >
      <div className="sticky top-4 space-y-4">
        {SECTION_GROUPS.map((group) => (
          <div key={group.label} className="space-y-1">
            <div className="px-3 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70">
              {group.label}
            </div>
            <ul className="space-y-0.5">
              {group.items.map((s) => (
                <li key={s.to}>
                  <NavLink
                    to={s.to}
                    className={({ isActive }) =>
                      cn(
                        'group relative flex items-center gap-2.5 rounded-md px-3 py-2 text-[13.5px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
                        isActive &&
                          'bg-accent text-foreground shadow-inset-highlight before:absolute before:inset-y-1.5 before:left-0 before:w-[3px] before:rounded-r-full before:bg-gradient-brand',
                      )
                    }
                  >
                    <s.icon className="h-4 w-4 shrink-0" strokeWidth={2} />
                    {s.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}

function MobileTabs() {
  return (
    <nav
      aria-label="Settings sections"
      // Border-b on the nav draws the inactive baseline. Active tabs
      // overlap it with a brand-gradient pill anchored to each link.
      className="md:hidden -mx-3 border-b border-border/70 sm:-mx-4"
    >
      <ul
        className="flex items-center gap-1 overflow-x-auto px-3 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden snap-x snap-mandatory sm:px-4"
      >
        {SECTION_GROUPS.flatMap((group, gi) => {
          const items: React.ReactNode[] = [];
          // Thin vertical divider before every group except the first.
          // aria-hidden so screen readers don't announce a "separator"
          // between two adjacent nav links — the link list itself is
          // already gated by the <nav aria-label> landmark.
          if (gi > 0) {
            items.push(
              <li
                key={`sep-${group.label}`}
                aria-hidden="true"
                className="mx-1 h-5 w-px shrink-0 bg-border/70"
              />,
            );
          }
          for (const s of group.items) {
            items.push(
              <li key={s.to} className="snap-start shrink-0">
                <NavLink
                  to={s.to}
                  className={({ isActive }) =>
                    cn(
                      // `relative` anchors the active underline to *this*
                      // link, not to the nav. Without it, after:bottom
                      // would resolve against the nav and the bar would
                      // float in the wrong place.
                      'relative inline-flex items-center gap-2 whitespace-nowrap px-3 py-2.5 text-[13.5px] font-medium text-muted-foreground transition-colors hover:text-foreground',
                      isActive &&
                        'text-foreground after:absolute after:inset-x-2 after:-bottom-px after:h-[2px] after:rounded-full after:bg-gradient-brand',
                    )
                  }
                >
                  <s.icon className="h-4 w-4 shrink-0" strokeWidth={2} />
                  {s.label}
                </NavLink>
              </li>,
            );
          }
          return items;
        })}
      </ul>
    </nav>
  );
}
