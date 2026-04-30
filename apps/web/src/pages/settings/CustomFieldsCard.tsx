import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DndContext, DragEndEvent, PointerSensor, useSensor, useSensors,
} from '@dnd-kit/core';
import {
  SortableContext, arrayMove, useSortable, verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Plus, Trash2, X } from 'lucide-react';
import {
  CUSTOM_FIELD_TYPE_LABELS, CUSTOM_FIELD_TYPES,
  type CustomFieldType,
} from '@pipelineflow/shared';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { CustomFieldInput } from '@/components/customFields/CustomFieldInput';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import type {
  CustomFieldDefinitionDto, CustomFieldEntity, CustomFieldOption,
} from '@/types';
import { toast } from 'sonner';

const ENTITY_TABS: { value: CustomFieldEntity; label: string }[] = [
  { value: 'CONTACT', label: 'Contacts' },
  { value: 'COMPANY', label: 'Companies' },
  { value: 'DEAL', label: 'Deals' },
];

export function CustomFieldsCard() {
  const [entity, setEntity] = useState<CustomFieldEntity>('CONTACT');
  return (
    <Card>
      <CardHeader>
        <CardTitle>Custom fields</CardTitle>
        <CardDescription>
          Add fields to contacts, companies, and deals. Fields that have values
          can't be deleted — inactivate them instead so existing records keep
          their data.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs value={entity} onValueChange={(v) => setEntity(v as CustomFieldEntity)}>
          <TabsList className="mb-4">
            {ENTITY_TABS.map((t) => (
              <TabsTrigger key={t.value} value={t.value}>{t.label}</TabsTrigger>
            ))}
          </TabsList>
          {ENTITY_TABS.map((t) => (
            <TabsContent key={t.value} value={t.value} className="space-y-4">
              <EntityFieldsList entityType={t.value} />
            </TabsContent>
          ))}
        </Tabs>
      </CardContent>
    </Card>
  );
}

function EntityFieldsList({ entityType }: { entityType: CustomFieldEntity }) {
  const qc = useQueryClient();
  const queryKey = ['custom-fields', entityType, 'all'];
  const { data } = useQuery({
    queryKey,
    queryFn: () =>
      api.get<{ definitions: CustomFieldDefinitionDto[] }>(
        `/custom-fields?entity=${entityType}&includeInactive=true`,
      ),
  });
  const [createOpen, setCreateOpen] = useState(false);

  const defs = data?.definitions ?? [];
  const active = defs.filter((d) => d.isActive);
  const inactive = defs.filter((d) => !d.isActive);

  const reorderMut = useMutation({
    mutationFn: (ids: number[]) =>
      api.post('/custom-fields/reorder', { entityType, ids }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['custom-fields', entityType] }),
  });

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const oldIdx = active.findIndex((d) => d.id === Number(e.active.id));
    const newIdx = active.findIndex((d) => d.id === Number(e.over!.id));
    if (oldIdx < 0 || newIdx < 0) return;
    const next = arrayMove(active, oldIdx, newIdx);
    qc.setQueryData(queryKey, () => ({
      definitions: [...next, ...inactive],
    }));
    reorderMut.mutate(next.map((d) => d.id));
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          {active.length} active{inactive.length > 0 ? ` · ${inactive.length} inactive` : ''}
        </div>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus /> Add field
        </Button>
      </div>

      {active.length === 0 ? (
        <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          No custom fields yet for {entityType.toLowerCase()}.
        </div>
      ) : (
        <DndContext sensors={sensors} onDragEnd={onDragEnd}>
          <SortableContext items={active.map((d) => d.id)} strategy={verticalListSortingStrategy}>
            <div className="space-y-2">
              {active.map((d) => (
                <SortableFieldRow key={d.id} def={d} entityType={entityType} />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {inactive.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Inactive</div>
          {inactive.map((d) => (
            <FieldRow key={d.id} def={d} entityType={entityType} />
          ))}
        </div>
      )}

      <FieldEditDialog
        entityType={entityType}
        open={createOpen}
        onOpenChange={setCreateOpen}
        existing={null}
      />
    </div>
  );
}

function SortableFieldRow({
  def, entityType,
}: {
  def: CustomFieldDefinitionDto;
  entityType: CustomFieldEntity;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: def.id });
  const style = { transform: CSS.Transform.toString(transform), transition };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'rounded-md border bg-card transition-shadow',
        isDragging && 'shadow-lg',
      )}
    >
      <div className="flex items-center gap-2 px-2 py-2">
        <button
          type="button"
          className="cursor-grab p-1 text-muted-foreground hover:text-foreground"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <FieldRowBody def={def} entityType={entityType} />
      </div>
    </div>
  );
}

function FieldRow({
  def, entityType,
}: {
  def: CustomFieldDefinitionDto;
  entityType: CustomFieldEntity;
}) {
  return (
    <div className="rounded-md border bg-muted/20">
      <div className="flex items-center gap-2 px-2 py-2 pl-3.5">
        <FieldRowBody def={def} entityType={entityType} />
      </div>
    </div>
  );
}

function FieldRowBody({
  def, entityType,
}: {
  def: CustomFieldDefinitionDto;
  entityType: CustomFieldEntity;
}) {
  const qc = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const inactivate = useMutation({
    mutationFn: (isActive: boolean) =>
      api.patch(`/custom-fields/${def.id}`, { isActive }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['custom-fields', entityType] });
      qc.invalidateQueries({ queryKey: ['custom-fields', entityType, 'active'] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const deleteMut = useMutation({
    mutationFn: () => api.delete(`/custom-fields/${def.id}`),
    onSuccess: () => {
      toast.success(`Deleted '${def.label}'`);
      qc.invalidateQueries({ queryKey: ['custom-fields', entityType] });
      setConfirmDelete(false);
    },
    onError: (e) => {
      const err = e as ApiError;
      toast.error(err.message);
      setConfirmDelete(false);
    },
  });

  return (
    <>
      <div className="flex flex-1 items-center gap-3 min-w-0">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{def.label}</span>
            {!def.isActive && <Badge variant="outline" className="text-[10px]">Inactive</Badge>}
            {def.isRequired && def.isActive && (
              <Badge variant="secondary" className="text-[10px]">Required</Badge>
            )}
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono">{def.key}</span>
            <span>·</span>
            <span>{CUSTOM_FIELD_TYPE_LABELS[def.type]}</span>
            {def.valueCount > 0 && (
              <>
                <span>·</span>
                <span>{def.valueCount} value{def.valueCount === 1 ? '' : 's'}</span>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => setEditOpen(true)}>Edit</Button>
          {def.isActive ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => inactivate.mutate(false)}
              disabled={inactivate.isPending}
            >
              Inactivate
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => inactivate.mutate(true)}
              disabled={inactivate.isPending}
            >
              Reactivate
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-destructive"
            onClick={() => setConfirmDelete(true)}
            title={
              def.valueCount > 0
                ? 'Has values — inactivate first'
                : 'Delete field'
            }
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <FieldEditDialog
        entityType={entityType}
        open={editOpen}
        onOpenChange={setEditOpen}
        existing={def}
      />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete '${def.label}'?`}
        description={
          def.valueCount > 0
            ? `This field has ${def.valueCount} value(s) on existing records and can't be deleted. Inactivate it instead.`
            : 'This field has no stored values, so it will be permanently removed.'
        }
        confirmLabel="Delete"
        busy={deleteMut.isPending}
        onConfirm={() => deleteMut.mutate()}
      />
    </>
  );
}

interface EditDialogProps {
  entityType: CustomFieldEntity;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existing: CustomFieldDefinitionDto | null;
}

function FieldEditDialog({ entityType, open, onOpenChange, existing }: EditDialogProps) {
  const qc = useQueryClient();
  const isEdit = existing != null;

  const [label, setLabel] = useState('');
  const [key, setKey] = useState('');
  const [keyTouched, setKeyTouched] = useState(false);
  const [type, setType] = useState<CustomFieldType>('TEXT');
  const [isRequired, setIsRequired] = useState(false);
  const [defaultValue, setDefaultValue] = useState<string | null>(null);
  const [choices, setChoices] = useState<CustomFieldOption[]>([]);
  const [currency, setCurrency] = useState('USD');

  // Reset on open / existing change.
  useEffect(() => {
    if (!open) return;
    if (existing) {
      setLabel(existing.label);
      setKey(existing.key);
      setKeyTouched(true);
      setType(existing.type);
      setIsRequired(existing.isRequired);
      setDefaultValue(existing.defaultValue);
      setChoices(existing.options?.choices ?? []);
      setCurrency(existing.options?.currency ?? 'USD');
    } else {
      setLabel('');
      setKey('');
      setKeyTouched(false);
      setType('TEXT');
      setIsRequired(false);
      setDefaultValue(null);
      setChoices([]);
      setCurrency('USD');
    }
  }, [open, existing]);

  // Auto-generate key from label until the user explicitly touches the key.
  useEffect(() => {
    if (isEdit || keyTouched) return;
    setKey(slugify(label));
  }, [label, keyTouched, isEdit]);

  const isSelect = type === 'SELECT' || type === 'MULTI_SELECT';
  const showDefault = !['LONG_TEXT', 'MULTI_SELECT'].includes(type);

  const saveMut = useMutation({
    mutationFn: () => {
      const options =
        isSelect ? { choices: choices.filter((c) => c.value && c.label) }
        : type === 'MONEY' ? { currency }
        : null;
      const body = {
        label,
        isRequired,
        defaultValue: defaultValue || null,
        options,
      };
      return isEdit
        ? api.patch(`/custom-fields/${existing!.id}`, body)
        : api.post('/custom-fields', { entityType, key, type, ...body });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['custom-fields', entityType] });
      toast.success(isEdit ? 'Field updated' : 'Field added');
      onOpenChange(false);
    },
    onError: (e) => toast.error((e as Error).message),
  });

  // For selects, require at least one fully-filled choice — otherwise the
  // FE would strip empties and submit zero options, which the API rejects
  // with a less helpful error.
  const validChoiceCount = choices.filter((c) => c.value && c.label).length;
  const canSave = !!label.trim() && !!key.trim() && (!isSelect || validChoiceCount > 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? `Edit '${existing!.label}'` : 'Add custom field'}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? 'Type and key are immutable — they preserve referential integrity for existing values.'
              : 'Pick a label, type, and (for selects) options. Keys auto-generate from the label and are stable forever.'}
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-3"
          onSubmit={(e) => { e.preventDefault(); if (canSave) saveMut.mutate(); }}
        >
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Label</Label>
              <Input value={label} onChange={(e) => setLabel(e.target.value)} required autoFocus />
            </div>
            <div className="space-y-1.5">
              <Label>
                Key{' '}
                <span className="text-xs text-muted-foreground">
                  ({isEdit ? 'immutable' : 'auto'})
                </span>
              </Label>
              <Input
                value={key}
                onChange={(e) => { setKey(slugify(e.target.value)); setKeyTouched(true); }}
                disabled={isEdit}
                className="font-mono text-xs"
                required
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select
                value={type}
                onValueChange={(v) => setType(v as CustomFieldType)}
                disabled={isEdit}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CUSTOM_FIELD_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>{CUSTOM_FIELD_TYPE_LABELS[t]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Required</Label>
              <div className="flex h-9 items-center">
                <Switch checked={isRequired} onCheckedChange={setIsRequired} />
              </div>
            </div>
          </div>

          {type === 'MONEY' && (
            <div className="space-y-1.5">
              <Label>Currency</Label>
              <Input
                value={currency}
                onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 8))}
                className="w-24 uppercase"
              />
            </div>
          )}

          {isSelect && (
            <div className="space-y-1.5">
              <Label>Options</Label>
              <ChoiceEditor choices={choices} onChange={setChoices} />
            </div>
          )}

          {showDefault && type !== 'BOOLEAN' && (
            <div className="space-y-1.5">
              <Label>Default value</Label>
              <DefaultValueInput
                type={type}
                choices={choices}
                currency={currency}
                value={defaultValue}
                onChange={setDefaultValue}
              />
            </div>
          )}
          {type === 'BOOLEAN' && (
            <div className="flex items-center gap-3">
              <Label>Default</Label>
              <Switch
                checked={defaultValue === 'true'}
                onCheckedChange={(b) => setDefaultValue(b ? 'true' : null)}
              />
              <span className="text-xs text-muted-foreground">
                {defaultValue === 'true' ? 'on for new records' : 'off'}
              </span>
            </div>
          )}

          <DialogFooter>
            <Button variant="ghost" type="button" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button disabled={!canSave || saveMut.isPending}>
              {isEdit ? 'Save' : 'Add field'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DefaultValueInput({
  type, choices, currency, value, onChange,
}: {
  type: CustomFieldType;
  choices: CustomFieldOption[];
  currency: string;
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  // Re-use the live input via a synthetic field def. The input writes
  // type-correct values; we serialize back to a string for storage.
  const def: CustomFieldDefinitionDto = {
    id: -1,
    entityType: 'CONTACT',
    key: 'default',
    label: 'default',
    type,
    isActive: true,
    isRequired: false,
    defaultValue: null,
    options: type === 'MONEY' ? { currency } : { choices },
    order: 0,
    valueCount: 0,
    createdAt: '',
    updatedAt: '',
  };
  const parsed = useMemo<unknown>(() => parseDefault(type, value), [type, value]);
  return (
    <CustomFieldInput
      field={def}
      value={parsed as never}
      onChange={(next) => onChange(serializeDefault(type, next))}
    />
  );
}

function parseDefault(type: CustomFieldType, raw: string | null): unknown {
  if (raw == null || raw === '') return null;
  if (type === 'BOOLEAN') return raw === 'true';
  if (type === 'NUMBER' || type === 'MONEY') return Number(raw);
  if (type === 'MULTI_SELECT') {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return raw;
}

function serializeDefault(type: CustomFieldType, v: unknown): string | null {
  if (v == null || v === '') return null;
  if (type === 'BOOLEAN') return v ? 'true' : null;
  if (type === 'MULTI_SELECT' || type === 'NUMBER' || type === 'MONEY') {
    return JSON.stringify(v);
  }
  return String(v);
}

function ChoiceEditor({
  choices, onChange,
}: {
  choices: CustomFieldOption[];
  onChange: (next: CustomFieldOption[]) => void;
}) {
  const update = (i: number, patch: Partial<CustomFieldOption>) =>
    onChange(choices.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  const remove = (i: number) => onChange(choices.filter((_, idx) => idx !== i));
  const add = () => onChange([...choices, { value: '', label: '' }]);
  return (
    <div className="space-y-1.5">
      {choices.map((c, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <Input
            placeholder="value"
            className="font-mono text-xs"
            value={c.value}
            onChange={(e) => update(i, { value: slugify(e.target.value) })}
          />
          <Input
            placeholder="Label"
            value={c.label}
            onChange={(e) => update(i, { label: e.target.value })}
          />
          <input
            type="color"
            value={c.color ?? '#94a3b8'}
            onChange={(e) => update(i, { color: e.target.value })}
            className="h-9 w-9 cursor-pointer rounded border bg-transparent"
            title="Color"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-9 w-9 text-muted-foreground hover:text-destructive"
            onClick={() => remove(i)}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={add}>
        <Plus className="mr-1 h-3 w-3" /> Add option
      </Button>
    </div>
  );
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
}
