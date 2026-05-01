import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { api, ApiError } from '@/lib/api';
import type { StageDto } from '@/types';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { CustomFieldsCard } from './settings/CustomFieldsCard';
import { TagChip } from '@/components/tags/TagChip';
import { TagEditPopover } from '@/components/tags/TagEditPopover';
import {
  useCreateTag,
  useTags,
} from '@/components/tags/useTags';
import { DEFAULT_TAG_COLOR } from '@/components/tags/tagPalette';

type StageKind = 'open' | 'won' | 'lost';

const stageKindOf = (s: { isWon: boolean; isLost: boolean }): StageKind =>
  s.isWon ? 'won' : s.isLost ? 'lost' : 'open';

const stageKindFlags = (k: StageKind) => ({
  isWon: k === 'won',
  isLost: k === 'lost',
});

// Subtle color-coding for the kind dot. Won = success, Lost = destructive,
// Open = neutral. Used both in the add form and inline on each row.
const STAGE_KIND_DOT: Record<StageKind, string> = {
  open: 'bg-muted-foreground/40',
  won: 'bg-emerald-500',
  lost: 'bg-rose-500',
};

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
      <CustomFieldsCard />
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
  const [newKind, setNewKind] = useState<StageKind>('open');
  const [stageToDelete, setStageToDelete] = useState<StageDto | null>(null);

  const addMut = useMutation({
    mutationFn: () =>
      api.post('/stages', {
        name: newName,
        color: newColor,
        order: (data?.stages.length ?? 0) + 1,
        ...stageKindFlags(newKind),
      }),
    onSuccess: () => {
      setNewName('');
      setNewKind('open');
      qc.invalidateQueries({ queryKey: ['stages'] });
    },
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
          {data?.stages.map((s) => {
            const kind = stageKindOf(s);
            return (
              <div key={s.id} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
                <input
                  type="color"
                  aria-label={`${s.name} color`}
                  value={s.color}
                  onChange={(e) => updateMut.mutate({ id: s.id, patch: { color: e.target.value } })}
                  className="h-6 w-6 shrink-0 cursor-pointer rounded border bg-transparent"
                />
                <Input
                  defaultValue={s.name}
                  aria-label={`${s.name} name`}
                  onBlur={(e) => {
                    if (e.target.value !== s.name) updateMut.mutate({ id: s.id, patch: { name: e.target.value } });
                  }}
                  className="h-8 min-w-0 flex-1"
                />
                <Select
                  value={kind}
                  onValueChange={(v) =>
                    updateMut.mutate({ id: s.id, patch: stageKindFlags(v as StageKind) })
                  }
                >
                  <SelectTrigger
                    aria-label="Stage type"
                    className="h-8 w-[100px] shrink-0 gap-1.5 px-2 text-xs"
                  >
                    <span className={`inline-block h-1.5 w-1.5 rounded-full ${STAGE_KIND_DOT[kind]}`} />
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="open">Open</SelectItem>
                    <SelectItem value="won">Won</SelectItem>
                    <SelectItem value="lost">Lost</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Delete ${s.name}`}
                  onClick={() => setStageToDelete(s)}
                  className="shrink-0"
                >
                  <Trash2 />
                </Button>
              </div>
            );
          })}
        </div>
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => { e.preventDefault(); if (newName.trim()) addMut.mutate(); }}
        >
          <input
            type="color"
            aria-label="New stage color"
            value={newColor}
            onChange={(e) => setNewColor(e.target.value)}
            className="h-9 w-9 shrink-0 cursor-pointer rounded border"
          />
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            aria-label="New stage name"
            placeholder="New stage name"
            className="min-w-0 flex-1"
          />
          <Select value={newKind} onValueChange={(v) => setNewKind(v as StageKind)}>
            <SelectTrigger aria-label="Stage type" className="w-[110px] shrink-0 gap-1.5">
              <span className={`inline-block h-1.5 w-1.5 rounded-full ${STAGE_KIND_DOT[newKind]}`} />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="open">Open</SelectItem>
              <SelectItem value="won">Won</SelectItem>
              <SelectItem value="lost">Lost</SelectItem>
            </SelectContent>
          </Select>
          <Button size="sm" disabled={!newName.trim() || addMut.isPending} className="shrink-0">
            <Plus /> Add
          </Button>
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
  const { data } = useTags();
  const create = useCreateTag();
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(DEFAULT_TAG_COLOR);

  const onCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      const result = await create.mutateAsync({ name, color: newColor });
      if (result.kind === 'existed') {
        toast.error(`Tag "${result.tag.name}" already exists`);
      } else {
        setNewName('');
      }
    } catch (e) {
      if (e instanceof ApiError) {
        toast.error(e.message);
      } else {
        toast.error('Failed to create tag');
      }
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Tags</CardTitle>
        <CardDescription>Categorize deals, companies, and contacts. Click any tag to rename, recolor, or delete.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {data?.tags.map((t) => (
            <TagEditPopover key={t.id} tag={t}>
              <TagChip
                tag={t}
                interactive
                size="md"
                className="cursor-pointer"
              />
            </TagEditPopover>
          ))}
          {data && data.tags.length === 0 ? (
            <p className="text-sm text-muted-foreground">No tags yet. Create one below.</p>
          ) : null}
        </div>

        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void onCreate();
          }}
        >
          <input
            type="color"
            aria-label="New tag color"
            value={newColor}
            onChange={(e) => setNewColor(e.target.value)}
            className="h-9 w-9 cursor-pointer rounded border"
          />
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            aria-label="New tag name"
            placeholder="New tag name"
            className="flex-1"
          />
          <Button size="sm" disabled={!newName.trim() || create.isPending}>
            <Plus /> Add
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
