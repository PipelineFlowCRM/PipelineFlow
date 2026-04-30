import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';
import type { StageDto, TagDto } from '@/types';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/ConfirmDialog';

export function Settings() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">Workspace-level configuration.</p>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <StagesCard />
        <TagsCard />
      </div>
    </div>
  );
}

function StagesCard() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['stages'],
    queryFn: () => api.get<{ stages: StageDto[] }>('/stages'),
  });

  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState('#6366f1');
  const [stageToDelete, setStageToDelete] = useState<StageDto | null>(null);

  const addMut = useMutation({
    mutationFn: () =>
      api.post('/stages', {
        name: newName, color: newColor, order: (data?.stages.length ?? 0) + 1,
        isWon: false, isLost: false,
      }),
    onSuccess: () => { setNewName(''); qc.invalidateQueries({ queryKey: ['stages'] }); },
  });

  const updateMut = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: Partial<StageDto> }) =>
      api.patch(`/stages/${id}`, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['stages'] }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => api.delete(`/stages/${id}`),
    onSuccess: () => { toast.success('Stage deleted'); qc.invalidateQueries({ queryKey: ['stages'] }); },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pipeline stages</CardTitle>
        <CardDescription>Reorder, rename, or recolor your funnel.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-2">
          {data?.stages.map((s) => (
            <div key={s.id} className="flex items-center gap-2 rounded-md border p-2">
              <input
                type="color"
                value={s.color}
                onChange={(e) => updateMut.mutate({ id: s.id, patch: { color: e.target.value } })}
                className="h-6 w-6 cursor-pointer rounded border bg-transparent"
              />
              <Input
                defaultValue={s.name}
                onBlur={(e) => {
                  if (e.target.value !== s.name) updateMut.mutate({ id: s.id, patch: { name: e.target.value } });
                }}
                className="h-8"
              />
              <span className="text-xs text-muted-foreground">
                {s.isWon ? 'Won' : s.isLost ? 'Lost' : 'Open'}
              </span>
              <Button variant="ghost" size="icon" onClick={() => setStageToDelete(s)}><Trash2 /></Button>
            </div>
          ))}
        </div>
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => { e.preventDefault(); if (newName.trim()) addMut.mutate(); }}
        >
          <div className="space-y-1"><Label className="text-xs">Color</Label>
            <input type="color" value={newColor} onChange={(e) => setNewColor(e.target.value)} className="h-9 w-9 cursor-pointer rounded border" />
          </div>
          <div className="flex-1 space-y-1"><Label className="text-xs">New stage</Label>
            <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Negotiation" />
          </div>
          <Button size="sm"><Plus /> Add</Button>
        </form>
      </CardContent>

      <ConfirmDialog
        open={stageToDelete != null}
        onOpenChange={(o) => { if (!o) setStageToDelete(null); }}
        title={stageToDelete ? `Delete "${stageToDelete.name}"?` : ''}
        description="Stages with deals attached can't be deleted — move those deals first. Otherwise this is irreversible."
        confirmLabel="Delete stage"
        busy={deleteMut.isPending}
        onConfirm={() => {
          if (stageToDelete) deleteMut.mutate(stageToDelete.id);
          setStageToDelete(null);
        }}
      />
    </Card>
  );
}

function TagsCard() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['tags'],
    queryFn: () => api.get<{ tags: TagDto[] }>('/tags'),
  });
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState('#94a3b8');
  const [tagToDelete, setTagToDelete] = useState<TagDto | null>(null);

  const addMut = useMutation({
    mutationFn: () => api.post('/tags', { name: newName, color: newColor }),
    onSuccess: () => { setNewName(''); qc.invalidateQueries({ queryKey: ['tags'] }); },
  });
  const deleteMut = useMutation({
    mutationFn: (id: number) => api.delete(`/tags/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tags'] }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Tags</CardTitle>
        <CardDescription>Quick categorization for deals.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {data?.tags.map((t) => (
            <span
              key={t.id}
              className="group flex items-center gap-1 rounded-full px-2 py-0.5 text-xs"
              style={{ background: `${t.color}1f`, color: t.color }}
            >
              {t.name}
              <button onClick={() => setTagToDelete(t)} className="opacity-0 transition-opacity group-hover:opacity-100">
                <Trash2 className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>

        <ConfirmDialog
          open={tagToDelete != null}
          onOpenChange={(o) => { if (!o) setTagToDelete(null); }}
          title={tagToDelete ? `Delete tag "${tagToDelete.name}"?` : ''}
          description="The tag is removed from every deal it was attached to."
          confirmLabel="Delete tag"
          busy={deleteMut.isPending}
          onConfirm={() => {
            if (tagToDelete) deleteMut.mutate(tagToDelete.id);
            setTagToDelete(null);
          }}
        />
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => { e.preventDefault(); if (newName.trim()) addMut.mutate(); }}
        >
          <div className="space-y-1"><Label className="text-xs">Color</Label>
            <input type="color" value={newColor} onChange={(e) => setNewColor(e.target.value)} className="h-9 w-9 cursor-pointer rounded border" />
          </div>
          <div className="flex-1 space-y-1"><Label className="text-xs">New tag</Label>
            <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. SMB" />
          </div>
          <Button size="sm"><Plus /> Add</Button>
        </form>
      </CardContent>
    </Card>
  );
}
