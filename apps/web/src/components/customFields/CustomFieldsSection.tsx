import { useMemo } from 'react';
import type {
  CustomFieldDefinitionDto,
  CustomFieldEntity,
  CustomFieldValuesMap,
} from '@/types';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { useCustomFieldDefinitions } from '@/hooks/useCustomFieldDefinitions';
import { CustomFieldInput, type CustomFieldValue } from './CustomFieldInput';
import { CustomFieldDisplay } from './CustomFieldDisplay';

interface Props {
  entityType: CustomFieldEntity;
  values: CustomFieldValuesMap;
  onChange: (next: CustomFieldValuesMap) => void;
  // 'detail' shows active fields as editable + an inactive section read-only.
  // 'compact' is a slimmer variant for create dialogs (no inactive section,
  // since inactive fields don't apply to brand-new records).
  variant?: 'detail' | 'compact';
  className?: string;
}

export function CustomFieldsSection({
  entityType,
  values,
  onChange,
  variant = 'detail',
  className,
}: Props) {
  // Detail view needs to show inactive fields too (read-only). Create dialogs
  // only need actives.
  const { data, isLoading } = useCustomFieldDefinitions(entityType, {
    includeInactive: variant === 'detail',
  });
  const defs = data?.definitions ?? [];
  const { active, inactive } = useMemo(() => {
    const a: CustomFieldDefinitionDto[] = [];
    const i: CustomFieldDefinitionDto[] = [];
    for (const d of defs) {
      if (d.isActive) a.push(d);
      else if (values[d.key] != null) i.push(d);
    }
    return { active: a, inactive: i };
  }, [defs, values]);

  if (isLoading) return null;
  if (active.length === 0 && inactive.length === 0) return null;

  const set = (key: string, next: CustomFieldValue) =>
    onChange({ ...values, [key]: next });

  return (
    <div className={className}>
      {active.length > 0 && (
        <div className="grid gap-3 md:grid-cols-2">
          {active.map((f) => (
            <div key={f.id} className="space-y-1.5">
              <Label htmlFor={`cf-${f.id}`} className="flex items-center gap-1">
                {f.label}
                {f.isRequired && <span className="text-destructive">*</span>}
              </Label>
              <CustomFieldInput
                id={`cf-${f.id}`}
                field={f}
                value={values[f.key] as CustomFieldValue | undefined}
                onChange={(next) => set(f.key, next)}
              />
            </div>
          ))}
        </div>
      )}
      {inactive.length > 0 && variant === 'detail' && (
        <div className="mt-6 space-y-2 border-t pt-4">
          <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
            Inactive fields
            <Badge variant="outline" className="text-[10px]">read-only</Badge>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {inactive.map((f) => (
              <div key={f.id} className="space-y-1.5">
                <Label className="text-muted-foreground">{f.label}</Label>
                <div className="rounded-md border border-dashed bg-muted/30 px-3 py-2 text-sm">
                  <CustomFieldDisplay field={f} value={values[f.key]} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
