import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { api } from '@/lib/api';
import type { CompanyDto, ContactDto, DealDto, StageDto } from '@/types';
import { toast } from 'sonner';

interface Props {
  deal: DealDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function DealEditDialog({ deal, open, onOpenChange }: Props) {
  const qc = useQueryClient();

  const [title, setTitle] = useState(deal.title);
  const [amount, setAmount] = useState(String(deal.amount));
  const [probability, setProbability] = useState(String(deal.probability));
  const [stageId, setStageId] = useState(String(deal.stageId));
  const [companyId, setCompanyId] = useState(deal.companyId ? String(deal.companyId) : '');
  const [primaryContactId, setPrimaryContactId] = useState(
    deal.primaryContactId ? String(deal.primaryContactId) : '',
  );
  const [expectedCloseDate, setExpectedCloseDate] = useState(deal.expectedCloseDate ?? '');
  const [tagsInput, setTagsInput] = useState(deal.tags.map((t) => t.name).join(', '));

  // Reset form when the dialog re-opens for a different deal
  useEffect(() => {
    if (!open) return;
    setTitle(deal.title);
    setAmount(String(deal.amount));
    setProbability(String(deal.probability));
    setStageId(String(deal.stageId));
    setCompanyId(deal.companyId ? String(deal.companyId) : '');
    setPrimaryContactId(deal.primaryContactId ? String(deal.primaryContactId) : '');
    setExpectedCloseDate(deal.expectedCloseDate ?? '');
    setTagsInput(deal.tags.map((t) => t.name).join(', '));
  }, [deal, open]);

  const { data: stages } = useQuery({
    queryKey: ['stages'],
    queryFn: () => api.get<{ stages: StageDto[] }>('/stages'),
    enabled: open,
  });
  const { data: companies } = useQuery({
    queryKey: ['companies', 'all'],
    queryFn: () => api.get<{ companies: CompanyDto[] }>('/companies'),
    enabled: open,
  });
  const { data: contacts } = useQuery({
    queryKey: ['contacts', companyId || 'none'],
    queryFn: () =>
      api.get<{ contacts: ContactDto[] }>(
        `/contacts${companyId ? `?companyId=${companyId}` : ''}`,
      ),
    enabled: open && !!companyId,
  });

  const saveMut = useMutation({
    mutationFn: () =>
      api.patch<{ deal: DealDto }>(`/deals/${deal.id}`, {
        title,
        amount: Number(amount),
        probability: Number(probability),
        stageId: Number(stageId),
        companyId: companyId ? Number(companyId) : null,
        primaryContactId: primaryContactId ? Number(primaryContactId) : null,
        expectedCloseDate: expectedCloseDate || null,
        tagNames: tagsInput.split(',').map((s) => s.trim()).filter(Boolean),
      }),
    onSuccess: () => {
      toast.success('Deal updated');
      qc.invalidateQueries({ queryKey: ['deal', deal.id] });
      qc.invalidateQueries({ queryKey: ['deals'] });
      qc.invalidateQueries({ queryKey: ['board'] });
      onOpenChange(false);
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit deal</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            saveMut.mutate();
          }}
        >
          <div className="space-y-2">
            <Label>Title</Label>
            <Input required value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-2">
              <Label>Amount</Label>
              <Input
                type="number"
                step="0.01"
                min="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Probability (%)</Label>
              <Input
                type="number"
                min="0"
                max="100"
                value={probability}
                onChange={(e) => setProbability(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Expected close</Label>
              <Input
                type="date"
                value={expectedCloseDate}
                onChange={(e) => setExpectedCloseDate(e.target.value)}
              />
            </div>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>Stage</Label>
              <Select value={stageId} onValueChange={setStageId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {stages?.stages.map((s) => (
                    <SelectItem key={s.id} value={String(s.id)}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Company</Label>
              <Select
                value={companyId || 'none'}
                onValueChange={(v) => {
                  const next = v === 'none' ? '' : v;
                  setCompanyId(next);
                  if (next !== companyId) setPrimaryContactId('');
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {companies?.companies.map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {companyId && (
            <div className="space-y-2">
              <Label>Primary contact</Label>
              <Select
                value={primaryContactId || 'none'}
                onValueChange={(v) => setPrimaryContactId(v === 'none' ? '' : v)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {contacts?.contacts.map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      {c.fullName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-2">
            <Label>Tags (comma-separated)</Label>
            <Input
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              placeholder="Hot, Enterprise"
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={saveMut.isPending}
            >
              Cancel
            </Button>
            <Button disabled={saveMut.isPending}>Save changes</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
