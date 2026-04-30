import { useMemo, useState } from 'react';
import { Columns3, Filter, Plus, X } from 'lucide-react';
import {
  type CustomFieldDefinitionDto,
  type CustomFieldType,
  type ListFilter,
  type ListFilterOp,
} from '@pipelineflow/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import {
  Popover, PopoverContent, PopoverTrigger,
} from '@/components/ui/popover';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useCustomFieldDefinitions } from '@/hooks/useCustomFieldDefinitions';
import type { CustomFieldEntity } from '@/types';
import { CF_KEY_PREFIX, opLabels, opsForType, valueRendererForType } from './filterOps';

export interface BuiltinColumn {
  key: string;
  label: string;
  // Built-in columns are always rendered by the page itself; this list is
  // only used so the user can toggle their visibility.
  alwaysOn?: boolean;
  // For filter UI: the type drives the operator menu and value input.
  filterType?: CustomFieldType;
}

interface Props {
  entityType: CustomFieldEntity;
  builtinColumns: BuiltinColumn[];
  visibleColumns: string[];
  onVisibleColumnsChange: (next: string[]) => void;
  filters: ListFilter[];
  onAddFilter: (f: ListFilter) => void;
  onRemoveFilter: (idx: number) => void;
}

export function ListToolbar({
  entityType,
  builtinColumns,
  visibleColumns,
  onVisibleColumnsChange,
  filters,
  onAddFilter,
  onRemoveFilter,
}: Props) {
  const { data } = useCustomFieldDefinitions(entityType, { includeInactive: false });
  const cfDefs = data?.definitions ?? [];

  return (
    <div className="flex flex-wrap items-center gap-2">
      <FiltersBar
        builtinColumns={builtinColumns}
        cfDefs={cfDefs}
        filters={filters}
        onAdd={onAddFilter}
        onRemove={onRemoveFilter}
      />
      <ColumnsMenu
        builtinColumns={builtinColumns}
        cfDefs={cfDefs}
        visibleColumns={visibleColumns}
        onChange={onVisibleColumnsChange}
      />
    </div>
  );
}

function ColumnsMenu({
  builtinColumns, cfDefs, visibleColumns, onChange,
}: {
  builtinColumns: BuiltinColumn[];
  cfDefs: CustomFieldDefinitionDto[];
  visibleColumns: string[];
  onChange: (next: string[]) => void;
}) {
  const cfKeys = cfDefs.map((d) => `${CF_KEY_PREFIX}${d.key}`);
  const togglable = [
    ...builtinColumns.filter((c) => !c.alwaysOn),
    ...cfDefs.map((d) => ({ key: `${CF_KEY_PREFIX}${d.key}`, label: d.label })),
  ];
  const isVisible = (key: string) => visibleColumns.includes(key);
  const toggle = (key: string) => {
    if (isVisible(key)) onChange(visibleColumns.filter((k) => k !== key));
    else onChange([...visibleColumns, key]);
  };
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <Columns3 className="mr-1 h-4 w-4" /> Columns
          {cfKeys.some(isVisible) && (
            <Badge variant="secondary" className="ml-1.5 text-[10px]">
              {visibleColumns.filter((k) => k.startsWith(CF_KEY_PREFIX)).length}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-2">
        <div className="space-y-1">
          {builtinColumns.filter((c) => c.alwaysOn).map((c) => (
            <div key={c.key} className="flex items-center justify-between rounded-sm px-2 py-1.5 text-sm">
              <span>{c.label}</span>
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                always
              </span>
            </div>
          ))}
          {togglable.map((c) => (
            <label
              key={c.key}
              className="flex cursor-pointer items-center justify-between rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
            >
              <span className="truncate">{c.label}</span>
              <Switch
                checked={isVisible(c.key)}
                onCheckedChange={() => toggle(c.key)}
              />
            </label>
          ))}
          {togglable.length === 0 && (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              No additional columns available.
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function FiltersBar({
  builtinColumns, cfDefs, filters, onAdd, onRemove,
}: {
  builtinColumns: BuiltinColumn[];
  cfDefs: CustomFieldDefinitionDto[];
  filters: ListFilter[];
  onAdd: (f: ListFilter) => void;
  onRemove: (idx: number) => void;
}) {
  const fieldsByKey = useMemo(() => {
    const m = new Map<string, { label: string; type: CustomFieldType }>();
    for (const c of builtinColumns) {
      if (c.filterType) m.set(c.key, { label: c.label, type: c.filterType });
    }
    for (const d of cfDefs) {
      m.set(`${CF_KEY_PREFIX}${d.key}`, { label: d.label, type: d.type });
    }
    return m;
  }, [builtinColumns, cfDefs]);

  return (
    <>
      {filters.map((f, i) => {
        const meta = fieldsByKey.get(f.key);
        return (
          <Badge
            key={`${f.key}-${i}`}
            variant="secondary"
            className="gap-1.5 py-1 pl-2 pr-1 text-xs"
          >
            <span className="font-medium">{meta?.label ?? f.key}</span>
            <span className="text-muted-foreground">{opLabels[f.op] ?? f.op}</span>
            {f.value != null && f.value !== '' && (
              <span className="font-mono">{formatFilterValue(f.value)}</span>
            )}
            <button
              type="button"
              className="rounded-full p-0.5 hover:bg-background/40"
              onClick={() => onRemove(i)}
              title="Remove filter"
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        );
      })}
      <AddFilterPopover
        builtinColumns={builtinColumns}
        cfDefs={cfDefs}
        onAdd={onAdd}
      />
    </>
  );
}

function AddFilterPopover({
  builtinColumns, cfDefs, onAdd,
}: {
  builtinColumns: BuiltinColumn[];
  cfDefs: CustomFieldDefinitionDto[];
  onAdd: (f: ListFilter) => void;
}) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState('');
  const [op, setOp] = useState<ListFilterOp>('eq');
  const [value, setValue] = useState<ListFilter['value']>('');

  const fields = useMemo(() => {
    const list: { key: string; label: string; type: CustomFieldType; def?: CustomFieldDefinitionDto }[] =
      [];
    for (const c of builtinColumns) {
      if (c.filterType) list.push({ key: c.key, label: c.label, type: c.filterType });
    }
    for (const d of cfDefs) {
      list.push({ key: `${CF_KEY_PREFIX}${d.key}`, label: d.label, type: d.type, def: d });
    }
    return list;
  }, [builtinColumns, cfDefs]);

  const selected = fields.find((f) => f.key === key);
  const ops = selected ? opsForType(selected.type) : [];
  // Ops that don't take a value — Add stays enabled regardless of `value`.
  const valuelessOp = op === 'is_set' || op === 'is_not_set' || op === 'is_true' || op === 'is_false';
  // Treat empty arrays / empty strings as "no value provided".
  const valueProvided =
    value != null
    && value !== ''
    && !(Array.isArray(value) && value.length === 0)
    && !(typeof value === 'number' && Number.isNaN(value));
  const canAdd = !!selected && (valuelessOp || valueProvided);

  const reset = () => {
    setKey('');
    setOp('eq');
    setValue('');
  };

  const close = () => {
    reset();
    setOpen(false);
  };

  const submit = () => {
    if (!canAdd) return;
    onAdd({ key, op, value: value === '' ? null : value });
    close();
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        setOpen(o);
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <Filter className="mr-1 h-4 w-4" /> Add filter
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 space-y-3 p-3">
        <div className="space-y-1.5">
          <Label className="text-xs">Field</Label>
          <Select
            value={key || 'none'}
            onValueChange={(v) => {
              setKey(v === 'none' ? '' : v);
              setOp('eq');
              setValue('');
            }}
          >
            <SelectTrigger><SelectValue placeholder="Choose a field" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">—</SelectItem>
              {fields.map((f) => (
                <SelectItem key={f.key} value={f.key}>{f.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {selected && (
          <>
            <div className="space-y-1.5">
              <Label className="text-xs">Operator</Label>
              <Select value={op} onValueChange={(v) => setOp(v as ListFilterOp)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ops.map((o) => (
                    <SelectItem key={o} value={o}>{opLabels[o] ?? o}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <FilterValueField
              type={selected.type}
              op={op}
              value={value}
              onChange={setValue}
              cfDef={selected.def}
            />
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={close}>Cancel</Button>
              <Button size="sm" onClick={submit} disabled={!canAdd}>
                <Plus className="mr-1 h-3 w-3" /> Add
              </Button>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

function FilterValueField({
  type, op, value, onChange, cfDef,
}: {
  type: CustomFieldType;
  op: ListFilterOp;
  value: ListFilter['value'];
  onChange: (v: ListFilter['value']) => void;
  cfDef?: CustomFieldDefinitionDto;
}) {
  // Some operators don't take values.
  if (op === 'is_set' || op === 'is_not_set' || op === 'is_true' || op === 'is_false') {
    return null;
  }
  const renderer = valueRendererForType(type);
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">Value</Label>
      {renderer === 'text' && (
        <Input
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {renderer === 'number' && (
        <Input
          type="number"
          value={typeof value === 'number' ? String(value) : (value as string) ?? ''}
          onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
        />
      )}
      {renderer === 'date' && (
        <Input
          type="date"
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {renderer === 'select' && cfDef && (
        <Select
          value={typeof value === 'string' ? value : ''}
          onValueChange={onChange}
        >
          <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
          <SelectContent>
            {(cfDef.options?.choices ?? []).map((c) => (
              <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}

function formatFilterValue(v: ListFilter['value']): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}
