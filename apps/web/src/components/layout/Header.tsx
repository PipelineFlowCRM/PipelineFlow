import { useNavigate } from 'react-router-dom';
import { LogOut, Menu, Moon, Search, Sun, User as UserIcon, Zap } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAuth } from '@/hooks/useAuth';
import { useTheme } from '@/hooks/useTheme';
import { initials } from '@/lib/utils';

export function Header({
  onSearchClick,
  onQuickLeadClick,
  onMenuClick,
}: {
  onSearchClick: () => void;
  onQuickLeadClick: () => void;
  onMenuClick: () => void;
}) {
  const { user, logout } = useAuth();
  const { resolved, setTheme } = useTheme();
  const navigate = useNavigate();

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border/70 bg-background/70 px-3 backdrop-blur-xl sm:gap-3 sm:px-4 md:px-6">
      <Button
        variant="ghost"
        size="icon"
        aria-label="Open menu"
        onClick={onMenuClick}
        className="md:hidden"
      >
        <Menu className="h-5 w-5" />
      </Button>
      <button
        onClick={onSearchClick}
        aria-label="Search"
        className="group flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border border-border/80 bg-card/60 px-3 text-[13px] text-muted-foreground shadow-soft transition-all hover:border-border hover:bg-accent hover:text-foreground sm:max-w-md"
      >
        <Search className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">
          <span className="sm:hidden">Search…</span>
          <span className="hidden sm:inline">Search deals, companies, contacts…</span>
        </span>
        <kbd className="ml-auto hidden items-center gap-0.5 rounded border border-border/80 bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium tabular text-muted-foreground sm:inline-flex">
          ⌘K
        </kbd>
      </button>
      <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
        <Button
          size="sm"
          onClick={onQuickLeadClick}
          className="gap-1.5 bg-gradient-brand text-white shadow-glow hover:opacity-90"
        >
          <Zap className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Quick lead</span>
          <kbd className="ml-1 hidden rounded border border-white/25 bg-white/10 px-1 py-0 text-[10px] font-medium tabular text-white/80 sm:inline-block">
            C
          </kbd>
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Toggle theme"
          onClick={() => setTheme(resolved === 'dark' ? 'light' : 'dark')}
        >
          {resolved === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </Button>
        {user ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="rounded-full focus:outline-none focus:ring-2 focus:ring-ring">
                <Avatar className="h-8 w-8">
                  {user.avatarUrl ? <AvatarImage src={user.avatarUrl} alt={user.name} /> : null}
                  <AvatarFallback color={user.avatarColor}>{initials(user.name)}</AvatarFallback>
                </Avatar>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>
                <div className="font-medium">{user.name}</div>
                <div className="text-xs text-muted-foreground">{user.email}</div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => navigate('/settings/profile')}>
                <UserIcon className="h-4 w-4" /> Profile
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={async () => {
                  await logout();
                  navigate('/login');
                }}
              >
                <LogOut className="h-4 w-4" /> Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </header>
  );
}
