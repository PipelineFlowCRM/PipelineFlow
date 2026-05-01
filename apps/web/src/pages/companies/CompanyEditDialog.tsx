import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
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
import { TagPicker } from '@/components/tags/TagPicker';
import { COMPANY_SIZES, US_STATES } from '@pipelineflow/shared';
import { api } from '@/lib/api';
import type { CompanyDto, CustomFieldValuesMap, TagDto } from '@/types';
import { toast } from 'sonner';

interface Props {
  company: CompanyDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CompanyEditDialog({ company, open, onOpenChange }: Props) {
  const qc = useQueryClient();
  const [form, setForm] = useState<Partial<CompanyDto>>(company);
  const [customFields, setCustomFields] = useState<CustomFieldValuesMap>(
    company.customFields ?? {},
  );
  const [tags, setTags] = useState<TagDto[]>(company.tags ?? []);

  useEffect(() => {
    if (!open) return;
    setForm(company);
    setCustomFields(company.customFields ?? {});
    setTags(company.tags ?? []);
  }, [company, open]);

  const set = <K extends keyof CompanyDto>(k: K, v: CompanyDto[K]) =>
    setForm((p) => ({ ...p, [k]: v }));

  const saveMut = useMutation({
    mutationFn: () =>
      api.patch(`/companies/${company.id}`, {
        ...form,
        tagIds: tags.map((t) => t.id),
        customFields,
      }),
    onSuccess: () => {
      toast.success('Company updated');
      qc.invalidateQueries({ queryKey: ['company', company.id] });
      qc.invalidateQueries({ queryKey: ['companies'] });
      onOpenChange(false);
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit company</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => { e.preventDefault(); saveMut.mutate(); }}
        >
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input value={form.name ?? ''} onChange={(e) => set('name', e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label>Industry</Label>
              <Input value={form.industry ?? ''} onChange={(e) => set('industry', e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Website</Label>
              <Input value={form.website ?? ''} onChange={(e) => set('website', e.target.value)} placeholder="acme.com" />
            </div>
            <div className="space-y-1.5">
              <Label>Phone</Label>
              <Input value={form.phone ?? ''} onChange={(e) => set('phone', e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Size</Label>
              <Select value={form.size ?? 'unset'} onValueChange={(v) => set('size', v === 'unset' ? null : v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="unset">—</SelectItem>
                  {COMPANY_SIZES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Address line 1</Label>
            <Input value={form.addressLine1 ?? ''} onChange={(e) => set('addressLine1', e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Address line 2</Label>
            <Input value={form.addressLine2 ?? ''} onChange={(e) => set('addressLine2', e.target.value)} />
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <div className="space-y-1.5">
              <Label>City</Label>
              <Input value={form.city ?? ''} onChange={(e) => set('city', e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>State</Label>
              <Select value={form.state ?? 'unset'} onValueChange={(v) => set('state', v === 'unset' ? null : v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="unset">—</SelectItem>
                  {US_STATES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>ZIP</Label>
              <Input value={form.postalCode ?? ''} onChange={(e) => set('postalCode', e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Notes</Label>
            <Textarea value={form.notes ?? ''} onChange={(e) => set('notes', e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Tags</Label>
            <TagPicker entityType="COMPANY" value={tags} onChange={setTags} />
          </div>
          <CustomFieldsSection
            entityType="COMPANY"
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
