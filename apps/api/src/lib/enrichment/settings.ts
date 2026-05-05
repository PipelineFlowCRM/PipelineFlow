// Read/write the workspace-wide enrichment settings, backed by the existing
// Setting key/value table. The keys are namespaced under `enrichment:` (see
// shared/enrichment.ts) so they sit alongside any future settings categories
// without collisions.
//
// The worker has its own near-identical reader (apps/worker/src/lib/enrichment/
// settings.ts) — duplicating the small amount of glue avoids cross-app prisma
// imports and keeps each surface trivially testable.

import {
  ENRICHMENT_DEFAULTS,
  ENRICHMENT_SETTING_KEYS,
  type EnrichmentMode,
  type EnrichmentSettings,
} from '@pipelineflow/shared';
import { prisma } from '../../db.js';

const KEYS = ENRICHMENT_SETTING_KEYS;

export async function readEnrichmentSettings(): Promise<EnrichmentSettings> {
  const rows = await prisma.setting.findMany({
    where: { key: { in: Object.values(KEYS) } },
  });
  const map = new Map(rows.map((r) => [r.key, r.value] as const));
  const bool = (k: string, dflt: boolean) => {
    const v = map.get(k);
    return v == null ? dflt : v === 'true';
  };
  const num = (k: string, dflt: number) => {
    const v = map.get(k);
    if (v == null) return dflt;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : dflt;
  };
  const modeRaw = map.get(KEYS.mode);
  const mode: EnrichmentMode = modeRaw === 'agentic' ? 'agentic' : 'structured';
  return {
    enabled: bool(KEYS.enabled, ENRICHMENT_DEFAULTS.enabled),
    autoOnCreate: bool(KEYS.autoOnCreate, ENRICHMENT_DEFAULTS.autoOnCreate),
    autoOnImport: bool(KEYS.autoOnImport, ENRICHMENT_DEFAULTS.autoOnImport),
    mode,
    debounceDays: num(KEYS.debounceDays, ENRICHMENT_DEFAULTS.debounceDays),
    dailyCap: num(KEYS.dailyCap, ENRICHMENT_DEFAULTS.dailyCap),
  };
}

export async function writeEnrichmentSettings(
  patch: Partial<EnrichmentSettings>,
): Promise<EnrichmentSettings> {
  const updates: { key: string; value: string }[] = [];
  if (patch.enabled !== undefined)
    updates.push({ key: KEYS.enabled, value: String(patch.enabled) });
  if (patch.autoOnCreate !== undefined)
    updates.push({ key: KEYS.autoOnCreate, value: String(patch.autoOnCreate) });
  if (patch.autoOnImport !== undefined)
    updates.push({ key: KEYS.autoOnImport, value: String(patch.autoOnImport) });
  if (patch.mode !== undefined) updates.push({ key: KEYS.mode, value: patch.mode });
  if (patch.debounceDays !== undefined)
    updates.push({ key: KEYS.debounceDays, value: String(patch.debounceDays) });
  if (patch.dailyCap !== undefined)
    updates.push({ key: KEYS.dailyCap, value: String(patch.dailyCap) });
  if (updates.length > 0) {
    await prisma.$transaction(
      updates.map((u) =>
        prisma.setting.upsert({
          where: { key: u.key },
          create: u,
          update: { value: u.value },
        }),
      ),
    );
  }
  return readEnrichmentSettings();
}

export async function getDailyUsage(): Promise<{ date: string; count: number }> {
  const today = utcDate();
  const row = await prisma.setting.findUnique({ where: { key: KEYS.dailyCount } });
  const v = row?.value ?? null;
  if (!v) return { date: today, count: 0 };
  const [date, nStr] = v.split(':');
  if (date !== today) return { date: today, count: 0 };
  const n = parseInt(nStr ?? '0', 10);
  return { date: today, count: Number.isFinite(n) ? n : 0 };
}

function utcDate(): string {
  return new Date().toISOString().slice(0, 10);
}
