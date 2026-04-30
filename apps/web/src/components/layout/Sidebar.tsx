import { NavLink } from 'react-router-dom';
import {
  Building2, CalendarRange, Cog, Contact2, KanbanSquare, LayoutDashboard, ListChecks,
  PieChart, UserCircle2,
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

const SECONDARY = [
  { to: '/settings', label: 'Settings', icon: Cog },
  { to: '/profile', label: 'Profile', icon: UserCircle2 },
];

export function Sidebar() {
  return (
    <aside className="relative hidden h-screen w-60 shrink-0 flex-col border-r border-border/80 bg-card/40 px-3 py-4 backdrop-blur md:flex">
      {/* faint mesh wash behind the sidebar to give it personality */}
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
    </aside>
  );
}
