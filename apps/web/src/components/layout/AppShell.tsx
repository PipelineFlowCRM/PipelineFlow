import { useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { MobileSidebar, Sidebar } from './Sidebar';
import { Header } from './Header';
import { CommandPalette } from '@/components/CommandPalette';
import { QuickLeadDialog } from '@/components/QuickLeadDialog';

export function AppShell() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [quickLeadOpen, setQuickLeadOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isInput(e.target)) return;
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      if (e.key === '/') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      if (e.key === 'c' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        setQuickLeadOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <MobileSidebar open={mobileNavOpen} onOpenChange={setMobileNavOpen} />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Header
          onSearchClick={() => setPaletteOpen(true)}
          onQuickLeadClick={() => setQuickLeadOpen(true)}
          onMenuClick={() => setMobileNavOpen(true)}
        />
        <main className="flex-1 overflow-y-auto px-3 py-4 sm:px-4 sm:py-6 md:px-8">
          <Outlet />
        </main>
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <QuickLeadDialog open={quickLeadOpen} onOpenChange={setQuickLeadOpen} />
    </div>
  );
}

function isInput(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
}
