import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Command } from 'cmdk';
import { Building2, Contact2, KanbanSquare, ListChecks, Plus, Search } from 'lucide-react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { api } from '@/lib/api';

interface SearchResult {
  deals: { id: number; title: string; subtitle: string }[];
  companies: { id: number; title: string; subtitle: string }[];
  contacts: { id: number; title: string; subtitle: string }[];
}

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchResult>({ deals: [], companies: [], contacts: [] });

  useEffect(() => {
    if (!open) setQ('');
  }, [open]);

  useEffect(() => {
    if (q.trim().length < 2) {
      setResults({ deals: [], companies: [], contacts: [] });
      return;
    }
    const t = setTimeout(() => {
      api.get<SearchResult>(`/search?q=${encodeURIComponent(q)}`).then(setResults).catch(() => undefined);
    }, 150);
    return () => clearTimeout(t);
  }, [q]);

  const go = (path: string) => {
    onOpenChange(false);
    navigate(path);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 sm:max-w-xl">
        <Command shouldFilter={false} className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground">
          <div className="flex items-center border-b px-3">
            <Search className="mr-2 h-4 w-4 text-muted-foreground" />
            <Command.Input
              autoFocus
              value={q}
              onValueChange={setQ}
              placeholder="Search deals, companies, contacts…"
              className="flex h-11 w-full rounded-md bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <Command.List className="max-h-[400px] overflow-y-auto p-2">
            <Command.Empty className="py-6 text-center text-sm text-muted-foreground">
              {q.trim().length < 2 ? 'Type to search…' : 'No results.'}
            </Command.Empty>
            <Command.Group heading="Quick actions">
              <Item onSelect={() => go('/deals/new')} icon={<Plus />}>New deal</Item>
              <Item onSelect={() => go('/pipeline')} icon={<KanbanSquare />}>Open pipeline</Item>
              <Item onSelect={() => go('/companies')} icon={<Building2 />}>Browse companies</Item>
              <Item onSelect={() => go('/contacts')} icon={<Contact2 />}>Browse contacts</Item>
            </Command.Group>
            {results.deals.length > 0 && (
              <Command.Group heading="Deals">
                {results.deals.map((d) => (
                  <Item key={`d${d.id}`} onSelect={() => go(`/deals/${d.id}`)} icon={<ListChecks />}>
                    <span className="flex-1 truncate">{d.title}</span>
                    <span className="ml-2 text-xs text-muted-foreground">{d.subtitle}</span>
                  </Item>
                ))}
              </Command.Group>
            )}
            {results.companies.length > 0 && (
              <Command.Group heading="Companies">
                {results.companies.map((c) => (
                  <Item key={`co${c.id}`} onSelect={() => go(`/companies/${c.id}`)} icon={<Building2 />}>
                    <span className="flex-1 truncate">{c.title}</span>
                    <span className="ml-2 text-xs text-muted-foreground">{c.subtitle}</span>
                  </Item>
                ))}
              </Command.Group>
            )}
            {results.contacts.length > 0 && (
              <Command.Group heading="Contacts">
                {results.contacts.map((c) => (
                  <Item key={`ct${c.id}`} onSelect={() => go(`/contacts/${c.id}`)} icon={<Contact2 />}>
                    <span className="flex-1 truncate">{c.title}</span>
                    <span className="ml-2 text-xs text-muted-foreground">{c.subtitle}</span>
                  </Item>
                ))}
              </Command.Group>
            )}
          </Command.List>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

function Item({
  onSelect, children, icon,
}: {
  onSelect: () => void;
  children: React.ReactNode;
  icon: React.ReactNode;
}) {
  return (
    <Command.Item
      onSelect={onSelect}
      className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground"
    >
      <span className="grid h-7 w-7 place-items-center rounded-md border bg-muted text-muted-foreground [&_svg]:h-3.5 [&_svg]:w-3.5">
        {icon}
      </span>
      {children}
    </Command.Item>
  );
}
