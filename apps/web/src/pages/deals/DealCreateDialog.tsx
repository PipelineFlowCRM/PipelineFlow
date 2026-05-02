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
import { TagPicker } from '@/components/tags/TagPicker';
import { api } from '@/lib/api';
import type { CompanyDto, ContactDto, CustomFieldValuesMap, DealDto, StageDto, TagDto } from '@/types';
import { toast } from 'sonner';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (deal: DealDto) => void;
  defaultCompanyId?: number | null;
}

export function DealCreateDialog({ open, onOpenChange, onCreated, defaultCompanyId }: Props) {
  const lockedToCompany = defaultCompanyId != null;

  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('0');
  const [probability, setProbability] = useState('20');
  const [stageId, setStageId] = useState<string>('');
  const [companyId, setCompanyId] = useState<string>(
    defaultCompanyId != null ? String(defaultCompanyId) : '',
  );
  const [primaryContactId, setPrimaryContactId] = useState<string>('');
  const [expectedCloseDate, setExpectedCloseDate] = useState('');
  const [tags, setTags] = useState<TagDto[]>([]);
  const [customFields, setCustomFields] = useState<CustomFieldValuesMap>({});

  useEffect(() => {
    if (!open) return;
    setTitle('');
    setAmount('0');
    setProbability('20');
    setStageId('');
    setCompanyId(defaultCompanyId != null ? String(defaultCompanyId) : '');
    setPrimaryContactId('');
    setExpectedCloseDate('');
    setTags([]);
    setCustomFields({});
  }, [open, defaultCompanyId]);

  const { data: stages } = useQuery({
    queryKey: ['stages'],
    queryFn: () => api.get<{ stages: StageDto[] }>('/stages'),
    enabled: open,
  });
  const { data: companies } = useQuery({
    queryKey: ['companies', 'all'],
    queryFn: () => api.get<{ companies: CompanyDto[] }>('/companies'),
    enabled: open && !lockedToCompany,
  });
  const { data: contacts } = useQuery({
    queryKey: ['contacts', companyId],
    queryFn: () => api.get<{ contacts: ContactDto[] }>(`/contacts${companyId ? `?companyId=${companyId}` : ''}`),
    enabled: open && !!companyId,
  });

  const createMut = useMutation({
    mutationFn: () =>
      api.post<{ deal: DealDto }>('/deals', {
        title,
        amount: Number(amount),
        probability: Number(probability),
        stageId: Number(stageId || stages?.stages[0]?.id),
        companyId: companyId ? Number(companyId) : null,
        primaryContactId: primaryContactId ? Number(primaryContactId) : null,
        expectedCloseDate: expectedCloseDate || null,
        tagIds: tags.map((t) => t.id),
        customFields,
      }),
    onSuccess: ({ deal }) => {
      toast.success('Deal created');
      onCreated?.(deal);
      onOpenChange(false);
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const stagesLoaded = (stages?.stages.length ?? 0) > 0;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!createMut.isPending) onOpenChange(v); }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader><DialogTitle>New deal</DialogTitle></DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => { e.preventDefault(); createMut.mutate(); }}
        >
          <div className="space-y-2">
            <Label>Title</Label>
            <Input required value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-2">
              <Label>Amount</Label>
              <Input type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Probability (%)</Label>
              <Input type="number" min="0" max="100" value={probability} onChange={(e) => setProbability(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Expected close</Label>
              <Input type="date" value={expectedCloseDate} onChange={(e) => setExpectedCloseDate(e.target.value)} />
            </div>
          </div>
          <div className={lockedToCompany ? '' : 'grid gap-4 md:grid-cols-2'}>
            <div className="space-y-2">
              <Label>Stage</Label>
              <Select value={stageId} onValueChange={setStageId}>
                <SelectTrigger><SelectValue placeholder="Select stage" /></SelectTrigger>
                <SelectContent>
                  {stages?.stages.map((s) => (
                    <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {!lockedToCompany ? (
              <div className="space-y-2">
                <Label>Company</Label>
                <Select
                  value={companyId || 'none'}
                  onValueChange={(v) => { setCompanyId(v === 'none' ? '' : v); setPrimaryContactId(''); }}
                >
                  <SelectTrigger><SelectValue placeholder="No company" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    {companies?.companies.map((c) => (
                      <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
          </div>
          {companyId ? (
            <div className="space-y-2">
              <Label>Primary contact</Label>
              <Select value={primaryContactId || 'none'} onValueChange={(v) => setPrimaryContactId(v === 'none' ? '' : v)}>
                <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {contacts?.contacts.map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>{c.fullName}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <div className="space-y-2">
            <Label>Tags</Label>
            <TagPicker entityType="DEAL" value={tags} onChange={setTags} />
          </div>
          <CustomFieldsSection
            entityType="DEAL"
            values={customFields}
            onChange={setCustomFields}
            variant="compact"
          />
          <DialogFooter>
            <Button type="button" variant="outline" disabled={createMut.isPending} onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button disabled={!title || !stagesLoaded || createMut.isPending}>Create deal</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
