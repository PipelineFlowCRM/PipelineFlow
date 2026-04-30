import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { CustomFieldsSection } from '@/components/customFields/CustomFieldsSection';
import { api } from '@/lib/api';
import type { CompanyDto, ContactDto, CustomFieldValuesMap } from '@/types';
import { toast } from 'sonner';

interface Props {
  contact: ContactDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ContactEditDialog({ contact, open, onOpenChange }: Props) {
  const qc = useQueryClient();
  const { data: companies } = useQuery({
    queryKey: ['companies', 'all'],
    queryFn: () => api.get<{ companies: CompanyDto[] }>('/companies'),
    enabled: open,
  });

  const [form, setForm] = useState<Partial<ContactDto>>(contact);
  const [customFields, setCustomFields] = useState<CustomFieldValuesMap>(
    contact.customFields ?? {},
  );

  // Reset on (re)open and on contact updates that arrive while open.
  useEffect(() => {
    if (!open) return;
    setForm(contact);
    setCustomFields(contact.customFields ?? {});
  }, [contact, open]);

  const set = <K extends keyof ContactDto>(k: K, v: ContactDto[K]) =>
    setForm((p) => ({ ...p, [k]: v }));

  const saveMut = useMutation({
    mutationFn: () =>
      api.patch(`/contacts/${contact.id}`, { ...form, customFields }),
    onSuccess: () => {
      toast.success('Contact updated');
      qc.invalidateQueries({ queryKey: ['contact', contact.id] });
      qc.invalidateQueries({ queryKey: ['contacts'] });
      onOpenChange(false);
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit contact</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => { e.preventDefault(); saveMut.mutate(); }}
        >
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label>First name</Label>
              <Input value={form.firstName ?? ''} onChange={(e) => set('firstName', e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label>Last name</Label>
              <Input value={form.lastName ?? ''} onChange={(e) => set('lastName', e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label>Email</Label>
              <Input type="email" value={form.email ?? ''} onChange={(e) => set('email', e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Phone</Label>
              <Input value={form.phone ?? ''} onChange={(e) => set('phone', e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Title</Label>
              <Input value={form.title ?? ''} onChange={(e) => set('title', e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>LinkedIn</Label>
              <Input value={form.linkedin ?? ''} onChange={(e) => set('linkedin', e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Company</Label>
            <Select
              value={form.companyId ? String(form.companyId) : 'none'}
              onValueChange={(v) => set('companyId', v === 'none' ? null : Number(v))}
            >
              <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                {companies?.companies.map((c) => (
                  <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Notes</Label>
            <Textarea value={form.notes ?? ''} onChange={(e) => set('notes', e.target.value)} />
          </div>
          <CustomFieldsSection
            entityType="CONTACT"
            values={customFields}
            onChange={setCustomFields}
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button disabled={saveMut.isPending}>Save changes</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
