// React-query hooks for tags. Single ['tags'] cache key; mutations also
// invalidate every entity cache that may carry tag chips so renames /
// recolors propagate immediately to all surfaces.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '@/lib/api';
import type { TagDto, TagWithCountsDto } from '@/types';

const ENTITY_QUERY_KEYS_TO_INVALIDATE = [
  ['deal'],
  ['deals'],
  ['board'],
  ['company'],
  ['companies'],
  ['contact'],
  ['contacts'],
  ['dashboard'],
] as const;

// All current callers want counts (picker, filter, edit popover, settings),
// so this hook always fetches with `?withCounts=1`. If a hot path ever needs
// the count-less variant for performance, add an opts arg back at that point.
export function useTags(): {
  data: { tags: TagWithCountsDto[] } | undefined;
  isLoading: boolean;
} {
  const q = useQuery({
    queryKey: ['tags', { withCounts: true }],
    queryFn: () => api.get<{ tags: TagWithCountsDto[] }>('/tags?withCounts=1'),
  });
  return { data: q.data, isLoading: q.isLoading };
}

function invalidateAll(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ['tags'] });
  for (const key of ENTITY_QUERY_KEYS_TO_INVALIDATE) {
    qc.invalidateQueries({ queryKey: [...key] });
  }
}

export function useCreateTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { name: string; color: string }) => {
      try {
        const { tag } = await api.post<{ tag: TagDto }>('/tags', input);
        return { kind: 'created' as const, tag };
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          // The 409 body always includes the existing tag (route puts it on
          // the top-level response, not in `details` which is stripped in
          // production).
          const data = e.details as { tag?: TagDto } | undefined;
          if (data?.tag) return { kind: 'existed' as const, tag: data.tag };
        }
        throw e;
      }
    },
    onSuccess: () => invalidateAll(qc),
  });
}

export function useUpdateTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      patch,
    }: {
      id: number;
      patch: { name?: string; color?: string };
    }) => api.patch<{ tag: TagDto }>(`/tags/${id}`, patch),
    onSuccess: () => invalidateAll(qc),
  });
}

export function useDeleteTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete(`/tags/${id}`),
    onSuccess: () => invalidateAll(qc),
  });
}
