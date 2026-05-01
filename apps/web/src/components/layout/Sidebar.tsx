import { useEffect } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import {
  Building2, CalendarRange, Cog, Contact2, KanbanSquare, LayoutDashboard, ListChecks,
  PieChart, X,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/pipeline', label: 'Pipeline', icon: KanbanSquare },
  { to: '/deals', label: 'Deals', icon: ListChecks },
  { to: '/companies', label: 'Companies', icon: Building2 },
  { to: '/contacts', label: 'Contacts', icon: Contact2 },
  { to: '/tasks', label: 'Tasks', icon: CalendarRange },
  { to: '/reports', label: 'Reports', icon: PieChart },
];

// Profile lives under /settings/profile now (Personal group in the
// settings nav rail) — the single Settings entry covers both personal
// and workspace-level configuration.
const SECONDARY = [
  { to: '/settings', label: 'Settings', icon: Cog },
];

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <>
      <div className="pointer-events-none absolute inset-0 mesh opacity-50" />
      <div className="relative px-3 pb-5">
        <div className="flex items-center gap-2.5">
          <img src="/logo-icon.svg" alt="" className="h-8 w-8 rounded-lg shadow-glow" />
          <div className="text-[15px] font-semibold tracking-tight">
            Pipeline<span className="text-gradient font-extrabold">Flow</span>
          </div>
        </div>
      </div>
      <nav className="relative flex-1 space-y-0.5 overflow-y-auto">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                'group relative flex items-center gap-2.5 rounded-md px-3 py-2 text-[13.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
                isActive &&
                  'bg-accent text-foreground shadow-inset-highlight before:absolute before:inset-y-1.5 before:left-0 before:w-[3px] before:rounded-r-full before:bg-gradient-brand',
              )
            }
          >
            <item.icon className="h-[16px] w-[16px]" strokeWidth={2} />
            {item.label}
          </NavLink>
        ))}
      </nav>
      <div className="relative mt-2 space-y-0.5 border-t border-border/70 pt-2">
        {SECONDARY.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-2.5 rounded-md px-3 py-2 text-[13.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
                isActive && 'bg-accent text-foreground',
              )
            }
          >
            <item.icon className="h-[16px] w-[16px]" strokeWidth={2} />
            {item.label}
          </NavLink>
        ))}
      </div>
    </>
  );
}

export function Sidebar() {
  return (
    <aside className="relative hidden h-screen w-60 shrink-0 flex-col border-r border-border/80 bg-card/40 px-3 py-4 backdrop-blur md:flex">
      <SidebarContent />
    </aside>
  );
}

export function MobileSidebar({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const location = useLocation();
  // Close drawer on route change so navigating to a page dismisses it.
  useEffect(() => {
    if (open) onOpenChange(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 md:hidden"
        />
        <DialogPrimitive.Content
          className="fixed inset-y-0 left-0 z-50 flex h-full w-64 max-w-[80vw] flex-col border-r border-border/80 bg-card px-3 py-4 shadow-elevated outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left md:hidden"
        >
          <DialogPrimitive.Title className="sr-only">Navigation</DialogPrimitive.Title>
          <DialogPrimitive.Close
            aria-label="Close menu"
            className="absolute right-2 top-2 z-10 grid h-8 w-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <X className="h-4 w-4" />
          </DialogPrimitive.Close>
          <SidebarContent onNavigate={() => onOpenChange(false)} />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
