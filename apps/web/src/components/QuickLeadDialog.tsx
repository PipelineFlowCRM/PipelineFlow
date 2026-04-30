import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Zap, Loader2 } from 'lucide-react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';
import type { DealDto } from '@/types';
import { toast } from 'sonner';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const empty = {
  companyName: '',
  website: '',
  contactName: '',
  contactEmail: '',
  contactPhone: '',
};

export function QuickLeadDialog({ open, onOpenChange }: Props) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const firstInputRef = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState(empty);

  useEffect(() => {
    if (open) {
      setForm(empty);
      // Radix manages focus on open; this nudges it after the transition
      setTimeout(() => firstInputRef.current?.focus(), 50);
    }
  }, [open]);

  const set = <K extends keyof typeof empty>(k: K, v: string) =>
    setForm((p) => ({ ...p, [k]: v }));

  const mut = useMutation({
    mutationFn: () =>
      api.post<{ deal: DealDto; companyId: number; contactId: number | null }>(
        '/deals/quick-lead',
        {
          companyName: form.companyName.trim(),
          website: form.website.trim() || null,
          contactName: form.contactName.trim() || null,
          contactEmail: form.contactEmail.trim() || null,
          contactPhone: form.contactPhone.trim() || null,
        },
      ),
    onSuccess: ({ deal }) => {
      toast.success('Lead created', {
        description: `${deal.company?.name ?? 'New company'} · ${deal.title}`,
      });
      qc.invalidateQueries({ queryKey: ['deals'] });
      qc.invalidateQueries({ queryKey: ['board'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      qc.invalidateQueries({ queryKey: ['companies'] });
      qc.invalidateQueries({ queryKey: ['contacts'] });
      onOpenChange(false);
      navigate(`/deals/${deal.id}`);
    },
    onError: (e) => toast.error((e as Error).message || 'Could not create lead'),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="grid h-7 w-7 place-items-center rounded-md brand-chip text-white">
              <Zap className="h-4 w-4" />
            </span>
            Quick lead
          </DialogTitle>
          <DialogDescription>
            Creates a company, contact, and Lead-stage deal in one shot.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!form.companyName.trim()) return;
            mut.mutate();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="ql-company">
              Company name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="ql-company"
              ref={firstInputRef}
              required
              value={form.companyName}
              onChange={(e) => set('companyName', e.target.value)}
              placeholder="Acme Corp"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ql-website">Website</Label>
            <Input
              id="ql-website"
              value={form.website}
              onChange={(e) => set('website', e.target.value)}
              placeholder="acme.com"
            />
          </div>

          <div className="border-t pt-4">
            <div className="mb-2 text-[10.5px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
              Primary contact
            </div>
            <div className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="ql-contact-name">Contact name</Label>
                <Input
                  id="ql-contact-name"
                  value={form.contactName}
                  onChange={(e) => set('contactName', e.target.value)}
                  placeholder="Jane Doe"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="ql-contact-email">Email</Label>
                  <Input
                    id="ql-contact-email"
                    type="email"
                    value={form.contactEmail}
                    onChange={(e) => set('contactEmail', e.target.value)}
                    placeholder="jane@acme.com"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="ql-contact-phone">Phone</Label>
                  <Input
                    id="ql-contact-phone"
                    type="tel"
                    value={form.contactPhone}
                    onChange={(e) => set('contactPhone', e.target.value)}
                    placeholder="(555) 123-4567"
                  />
                </div>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={mut.isPending}
            >
              Cancel
            </Button>
            <Button disabled={!form.companyName.trim() || mut.isPending}>
              {mut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap />}
              Create lead
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
