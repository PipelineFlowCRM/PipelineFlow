import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { CF_KEY_PREFIX } from '@/components/customFields/filterOps';
import { useCustomFieldDefinitions } from '@/hooks/useCustomFieldDefinitions';
import type { CustomFieldEntity, ListFilter, ListPrefs } from '@/types';

const DEFAULT_PREFS: ListPrefs = { columns: [], filters: [] };

export function useListPrefs(entityType: CustomFieldEntity) {
  const qc = useQueryClient();
  // Memoize so persist's identity stays stable — otherwise the auto-prune
  // effect re-runs on every render.
  const queryKey = useMemo(() => ['list-prefs', entityType] as const, [entityType]);
  const { data } = useQuery({
    queryKey,
    queryFn: () =>
      api.get<{ entityType: CustomFieldEntity; prefs: ListPrefs }>(
        `/list-prefs?entity=${entityType}`,
      ),
    staleTime: 60_000,
  });

  // Local mirror for instant input feedback; we then debounce the PUT.
  const [local, setLocal] = useState<ListPrefs>(DEFAULT_PREFS);
  // Hydrate from server data exactly once. Subsequent server refetches must
  // not clobber unsaved local edits (background refetch can fire while a
  // PUT is mid-debounce).
  const hydratedRef = useRef(false);
  const saveTimer = useRef<number | null>(null);
  useEffect(() => {
    if (hydratedRef.current) return;
    if (!data?.prefs) return;
    setLocal(data.prefs);
    hydratedRef.current = true;
  }, [data?.prefs]);

  const persist = useCallback(
    (next: ListPrefs) => {
      setLocal(next);
      qc.setQueryData<{ entityType: CustomFieldEntity; prefs: ListPrefs }>(
        queryKey,
        (prev) => ({ ...(prev ?? { entityType }), entityType, prefs: next }),
      );
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        api.put('/list-prefs', { entityType, prefs: next }).catch(() => {
          // Drop silently — list prefs are non-critical UI state.
        });
      }, 400);
    },
    [entityType, qc, queryKey],
  );

  const setColumns = (columns: string[]) => persist({ ...local, columns });
  const setFilters = (filters: ListFilter[]) => persist({ ...local, filters });
  const addFilter = (f: ListFilter) => setFilters([...local.filters, f]);
  const removeFilter = (idx: number) =>
    setFilters(local.filters.filter((_, i) => i !== idx));
  const updateFilter = (idx: number, patch: Partial<ListFilter>) =>
    setFilters(local.filters.map((f, i) => (i === idx ? { ...f, ...patch } : f)));

  // Auto-prune references to deleted custom fields. If a saved column or
  // filter points at a `cf:<key>` that no longer exists, drop it once the
  // definitions have loaded — otherwise stale filters silently constrain
  // results and can't be removed if their chip won't render.
  const { data: cfData } = useCustomFieldDefinitions(entityType, { includeInactive: true });
  useEffect(() => {
    if (!cfData) return;
    const known = new Set(cfData.definitions.map((d) => `${CF_KEY_PREFIX}${d.key}`));
    const isStale = (k: string) => k.startsWith(CF_KEY_PREFIX) && !known.has(k);
    const cleanColumns = local.columns.filter((k) => !isStale(k));
    const cleanFilters = local.filters.filter((f) => !isStale(f.key));
    if (
      cleanColumns.length !== local.columns.length ||
      cleanFilters.length !== local.filters.length
    ) {
      persist({ columns: cleanColumns, filters: cleanFilters });
    }
  }, [cfData, local, persist]);

  return {
    prefs: local,
    setColumns,
    setFilters,
    addFilter,
    removeFilter,
    updateFilter,
  };
}
