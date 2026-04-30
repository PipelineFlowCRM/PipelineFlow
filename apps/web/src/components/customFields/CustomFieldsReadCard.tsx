import { Pen } from 'lucide-react';
import {
  Card, CardContent, CardHeader, CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { CustomFieldEntity, CustomFieldValuesMap } from '@/types';
import { useCustomFieldDefinitions } from '@/hooks/useCustomFieldDefinitions';
import { CustomFieldDisplay } from './CustomFieldDisplay';

interface Props {
  entityType: CustomFieldEntity;
  values: CustomFieldValuesMap;
  // Optional edit affordance — used on detail pages where edits flow through
  // a separate dialog (e.g., DealEditDialog).
  onEdit?: () => void;
}

export function CustomFieldsReadCard({ entityType, values, onEdit }: Props) {
  const { data } = useCustomFieldDefinitions(entityType, { includeInactive: true });
  const defs = data?.definitions ?? [];

  // Show every active def + any inactive def that still has a value.
  const visible = defs.filter((d) => d.isActive || values[d.key] != null);
  if (visible.length === 0) return null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">Custom fields</CardTitle>
        {onEdit && (
          <Button variant="ghost" size="sm" onClick={onEdit}>
            <Pen className="mr-1 h-3.5 w-3.5" /> Edit
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {visible.map((f) => (
          <div key={f.id} className="space-y-1">
            <div className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted-foreground">
              {f.label}
              {!f.isActive && (
                <Badge variant="outline" className="text-[9px]">inactive</Badge>
              )}
            </div>
            <div className="break-words text-sm">
              <CustomFieldDisplay field={f} value={values[f.key]} />
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
