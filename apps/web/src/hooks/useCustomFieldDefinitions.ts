import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { CustomFieldDefinitionDto, CustomFieldEntity } from '@/types';

export function useCustomFieldDefinitions(
  entityType: CustomFieldEntity,
  opts?: { includeInactive?: boolean },
) {
  const includeInactive = opts?.includeInactive ?? false;
  return useQuery({
    queryKey: ['custom-fields', entityType, includeInactive ? 'all' : 'active'],
    queryFn: () =>
      api.get<{ definitions: CustomFieldDefinitionDto[] }>(
        `/custom-fields?entity=${entityType}${includeInactive ? '&includeInactive=true' : ''}`,
      ),
    staleTime: 30_000,
  });
}
