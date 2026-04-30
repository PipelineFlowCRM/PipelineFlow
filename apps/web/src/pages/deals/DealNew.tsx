import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api } from '@/lib/api';
import type { CompanyDto, ContactDto, CustomFieldValuesMap, DealDto, StageDto } from '@/types';
import { toast } from 'sonner';
import { CustomFieldsSection } from '@/components/customFields/CustomFieldsSection';

export function DealNew() {
  const navigate = useNavigate();
  const { data: stages } = useQuery({
    queryKey: ['stages'],
    queryFn: () => api.get<{ stages: StageDto[] }>('/stages'),
  });
  const { data: companies } = useQuery({
    queryKey: ['companies', 'all'],
    queryFn: () => api.get<{ companies: CompanyDto[] }>('/companies'),
  });

  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('0');
  const [probability, setProbability] = useState('20');
  const [stageId, setStageId] = useState<string>('');
  const [companyId, setCompanyId] = useState<string>('');
  const [primaryContactId, setPrimaryContactId] = useState<string>('');
  const [expectedCloseDate, setExpectedCloseDate] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [customFields, setCustomFields] = useState<CustomFieldValuesMap>({});

  const { data: contacts } = useQuery({
    queryKey: ['contacts', companyId],
    queryFn: () => api.get<{ contacts: ContactDto[] }>(`/contacts${companyId ? `?companyId=${companyId}` : ''}`),
    enabled: !!companyId,
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
        tagNames: tagsInput.split(',').map((s) => s.trim()).filter(Boolean),
        customFields,
      }),
    onSuccess: ({ deal }) => {
      toast.success('Deal created');
      navigate(`/deals/${deal.id}`);
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <div className="mx-auto max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle>New deal</CardTitle>
          <CardDescription>Track a new opportunity in your pipeline.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              createMut.mutate();
            }}
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
            <div className="grid gap-4 md:grid-cols-2">
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
              <div className="space-y-2">
                <Label>Company</Label>
                <Select value={companyId || 'none'} onValueChange={(v) => { setCompanyId(v === 'none' ? '' : v); setPrimaryContactId(''); }}>
                  <SelectTrigger><SelectValue placeholder="No company" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    {companies?.companies.map((c) => (
                      <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {companyId && (
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
            )}
            <div className="space-y-2">
              <Label>Tags (comma-separated)</Label>
              <Input value={tagsInput} onChange={(e) => setTagsInput(e.target.value)} placeholder="Hot, Enterprise" />
            </div>
            <CustomFieldsSection
              entityType="DEAL"
              values={customFields}
              onChange={setCustomFields}
              variant="compact"
            />
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => navigate(-1)}>Cancel</Button>
              <Button disabled={createMut.isPending}>Create deal</Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
