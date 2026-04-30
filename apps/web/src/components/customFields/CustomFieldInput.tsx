import { useState } from 'react';
import { Check, ChevronDown, X } from 'lucide-react';
import type { CustomFieldDefinitionDto, CustomFieldOption } from '@/types';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export type CustomFieldValue = string | number | boolean | string[] | null;

interface Props {
  field: CustomFieldDefinitionDto;
  value: CustomFieldValue | undefined;
  onChange: (next: CustomFieldValue) => void;
  // Inactive fields render their value as read-only text — set this to true
  // to suppress writes from the input itself.
  disabled?: boolean;
  id?: string;
}

export function CustomFieldInput({ field, value, onChange, disabled, id }: Props) {
  const v = value ?? null;

  switch (field.type) {
    case 'TEXT':
      return (
        <Input
          id={id}
          value={(v as string) ?? ''}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value || null)}
        />
      );
    case 'LONG_TEXT':
      return (
        <Textarea
          id={id}
          value={(v as string) ?? ''}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value || null)}
        />
      );
    case 'EMAIL':
      return (
        <Input
          id={id}
          type="email"
          value={(v as string) ?? ''}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value || null)}
        />
      );
    case 'URL':
      return (
        <Input
          id={id}
          type="url"
          inputMode="url"
          placeholder="https://"
          value={(v as string) ?? ''}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value || null)}
        />
      );
    case 'PHONE':
      return (
        <Input
          id={id}
          type="tel"
          value={(v as string) ?? ''}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value || null)}
        />
      );
    case 'NUMBER':
      return (
        <Input
          id={id}
          type="number"
          value={v == null ? '' : String(v as number)}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        />
      );
    case 'MONEY': {
      const currency = field.options?.currency ?? 'USD';
      return (
        <div className="relative">
          <span className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-xs text-muted-foreground">
            {currency}
          </span>
          <Input
            id={id}
            type="number"
            step="0.01"
            className="pl-12 tabular"
            value={v == null ? '' : String(v as number)}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
          />
        </div>
      );
    }
    case 'DATE':
      return (
        <Input
          id={id}
          type="date"
          value={(v as string) ?? ''}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value || null)}
        />
      );
    case 'BOOLEAN':
      return (
        <div className="flex h-9 items-center">
          <Switch
            id={id}
            checked={Boolean(v)}
            disabled={disabled}
            onCheckedChange={(checked) => onChange(checked)}
          />
        </div>
      );
    case 'SELECT': {
      const choices = field.options?.choices ?? [];
      const selected = (v as string) ?? '';
      return (
        <Select
          value={selected || 'none'}
          disabled={disabled}
          onValueChange={(next) => onChange(next === 'none' ? null : next)}
        >
          <SelectTrigger id={id}><SelectValue placeholder="—" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">—</SelectItem>
            {choices.map((c) => (
              <SelectItem key={c.value} value={c.value}>
                <ChoiceLabel choice={c} />
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    }
    case 'MULTI_SELECT': {
      const choices = field.options?.choices ?? [];
      const selected = Array.isArray(v) ? (v as string[]) : [];
      return (
        <MultiSelectInput
          id={id}
          choices={choices}
          selected={selected}
          disabled={disabled}
          onChange={(next) => onChange(next.length === 0 ? null : next)}
        />
      );
    }
    default:
      return null;
  }
}

function ChoiceLabel({ choice }: { choice: CustomFieldOption }) {
  if (!choice.color) return <span>{choice.label}</span>;
  return (
    <span className="inline-flex items-center gap-2">
      <span
        className="inline-block h-2 w-2 rounded-full"
        style={{ background: choice.color }}
      />
      {choice.label}
    </span>
  );
}

interface MultiProps {
  id?: string;
  choices: CustomFieldOption[];
  selected: string[];
  disabled?: boolean;
  onChange: (next: string[]) => void;
}

function MultiSelectInput({ id, choices, selected, disabled, onChange }: MultiProps) {
  const [open, setOpen] = useState(false);
  const byValue = new Map(choices.map((c) => [c.value, c] as const));
  const toggle = (value: string) => {
    if (selected.includes(value)) onChange(selected.filter((v) => v !== value));
    else onChange([...selected, value]);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          disabled={disabled}
          className={cn(
            'h-auto min-h-9 w-full justify-between gap-2 text-left font-normal',
            selected.length === 0 && 'text-muted-foreground',
          )}
        >
          <span className="flex flex-1 flex-wrap gap-1">
            {selected.length === 0 ? (
              '—'
            ) : (
              selected.map((v) => {
                const c = byValue.get(v);
                return (
                  <Badge
                    key={v}
                    variant="secondary"
                    className="gap-1"
                    style={c?.color ? { background: `${c.color}22`, color: c.color } : undefined}
                  >
                    {c?.label ?? v}
                    {!disabled && (
                      <X
                        className="h-3 w-3 cursor-pointer opacity-70 hover:opacity-100"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggle(v);
                        }}
                      />
                    )}
                  </Badge>
                );
              })
            )}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-1" align="start">
        <div className="max-h-64 overflow-y-auto">
          {choices.length === 0 && (
            <div className="px-2 py-1.5 text-sm text-muted-foreground">No options</div>
          )}
          {choices.map((c) => {
            const checked = selected.includes(c.value);
            return (
              <button
                key={c.value}
                type="button"
                onClick={() => toggle(c.value)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent',
                  checked && 'bg-accent/40',
                )}
              >
                <span
                  className={cn(
                    'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                    checked ? 'border-primary bg-primary text-primary-foreground' : 'border-input',
                  )}
                >
                  {checked && <Check className="h-3 w-3" />}
                </span>
                <ChoiceLabel choice={c} />
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
