import type { CustomFieldDefinitionDto, CustomFieldOption } from '@/types';
import { Badge } from '@/components/ui/badge';
import { formatMoney } from '@/lib/utils';

interface Props {
  field: CustomFieldDefinitionDto;
  value: unknown;
  // Compact = list/table cell rendering. Default = detail/inline.
  variant?: 'default' | 'compact';
}

export function CustomFieldDisplay({ field, value, variant = 'default' }: Props) {
  if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) {
    return <span className="text-muted-foreground">—</span>;
  }

  switch (field.type) {
    case 'TEXT':
    case 'PHONE':
      return <span>{String(value)}</span>;
    case 'LONG_TEXT':
      return (
        <span className={variant === 'compact' ? 'truncate' : 'whitespace-pre-wrap'}>
          {String(value)}
        </span>
      );
    case 'NUMBER':
      return <span className="tabular">{Number(value).toLocaleString()}</span>;
    case 'MONEY':
      return (
        <span className="tabular">
          {formatMoney(Number(value), field.options?.currency ?? 'USD')}
        </span>
      );
    case 'DATE': {
      const d = new Date(String(value) + 'T00:00:00Z');
      return (
        <span className="tabular">
          {Number.isFinite(d.getTime()) ? d.toLocaleDateString() : String(value)}
        </span>
      );
    }
    case 'BOOLEAN':
      return value ? (
        <Badge variant="secondary">Yes</Badge>
      ) : (
        <span className="text-muted-foreground">No</span>
      );
    case 'EMAIL':
      return (
        <a href={`mailto:${value}`} className="text-primary hover:underline">
          {String(value)}
        </a>
      );
    case 'URL':
      return (
        <a
          href={String(value)}
          target="_blank"
          rel="noreferrer"
          className="text-primary hover:underline"
        >
          {String(value)}
        </a>
      );
    case 'SELECT': {
      const choice = field.options?.choices?.find((c) => c.value === value);
      return <ChoiceBadge choice={choice} fallback={String(value)} />;
    }
    case 'MULTI_SELECT': {
      const arr = Array.isArray(value) ? (value as string[]) : [];
      const choices = field.options?.choices ?? [];
      const byValue = new Map(choices.map((c) => [c.value, c] as const));
      return (
        <span className="flex flex-wrap gap-1">
          {arr.map((v) => (
            <ChoiceBadge key={v} choice={byValue.get(v)} fallback={v} />
          ))}
        </span>
      );
    }
    default:
      return <span>{String(value)}</span>;
  }
}

function ChoiceBadge({
  choice,
  fallback,
}: {
  choice?: CustomFieldOption;
  fallback: string;
}) {
  const label = choice?.label ?? fallback;
  if (!choice?.color) return <Badge variant="secondary">{label}</Badge>;
  return (
    <Badge
      variant="outline"
      style={{
        background: `${choice.color}1a`,
        color: choice.color,
        borderColor: `${choice.color}55`,
      }}
    >
      {label}
    </Badge>
  );
}
