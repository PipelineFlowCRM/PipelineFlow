import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { CustomFieldsSection } from '@/components/customFields/CustomFieldsSection';
import { api } from '@/lib/api';
import type { CompanyDto, CustomFieldValuesMap } from '@/types';
import { toast } from 'sonner';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: () => void;
  defaultCompanyId?: number | null;
}

export function ContactCreateDialog({ open, onOpenChange, onCreated, defaultCompanyId }: Props) {
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [email, setEmail] = useState('');
  const [companyId, setCompanyId] = useState<string>(
    defaultCompanyId != null ? String(defaultCompanyId) : '',
  );
  const [customFields, setCustomFields] = useState<CustomFieldValuesMap>({});

  useEffect(() => {
    if (!open) return;
    setFirst('');
    setLast('');
    setEmail('');
    setCompanyId(defaultCompanyId != null ? String(defaultCompanyId) : '');
    setCustomFields({});
  }, [open, defaultCompanyId]);

  const lockedToCompany = defaultCompanyId != null;

  const { data: companies } = useQuery({
    queryKey: ['companies', 'all'],
    queryFn: () => api.get<{ companies: CompanyDto[] }>('/companies'),
    enabled: open && !lockedToCompany,
  });

  const mut = useMutation({
    mutationFn: () =>
      api.post('/contacts', {
        firstName: first,
        lastName: last,
        email: email || null,
        companyId: companyId ? Number(companyId) : null,
        customFields,
      }),
    onSuccess: () => {
      toast.success('Contact created');
      onCreated?.();
      onOpenChange(false);
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!mut.isPending) onOpenChange(v); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>New contact</DialogTitle></DialogHeader>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); mut.mutate(); }}>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>First name</Label>
              <Input required value={first} onChange={(e) => setFirst(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Last name</Label>
              <Input required value={last} onChange={(e) => setLast(e.target.value)} />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Email</Label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          {!lockedToCompany ? (
            <div className="space-y-2">
              <Label>Company</Label>
              <Select value={companyId || 'none'} onValueChange={(v) => setCompanyId(v === 'none' ? '' : v)}>
                <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {companies?.companies.map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <CustomFieldsSection
            entityType="CONTACT"
            values={customFields}
            onChange={setCustomFields}
            variant="compact"
          />
          <DialogFooter>
            <Button type="button" variant="outline" disabled={mut.isPending} onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button disabled={!first || !last || mut.isPending}>Create</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
