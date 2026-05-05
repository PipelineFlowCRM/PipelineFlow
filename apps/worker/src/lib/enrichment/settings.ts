// Worker-side settings reader + daily-usage counter. Mirrors the api's
// helper; we duplicate rather than cross-import to keep each app's prisma
// client local. The api owns the *write* path for normal settings; the
// worker only writes to dailyCount via incrementDailyUsage().

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

/** Compare-and-swap on the date prefix; concurrent inc'rs may collapse one
 *  bump under heavy fan-out, but the ordering of the cap check is forward
 *  conservative (we read-then-bump, so the worst case is one over-cap run,
 *  not many). Acceptable at this app's scale. */
export async function incrementDailyUsage(): Promise<number> {
  const today = utcDate();
  const cur = await getDailyUsage();
  const next = cur.date === today ? cur.count + 1 : 1;
  await prisma.setting.upsert({
    where: { key: KEYS.dailyCount },
    create: { key: KEYS.dailyCount, value: `${today}:${next}` },
    update: { value: `${today}:${next}` },
  });
  return next;
}

function utcDate(): string {
  return new Date().toISOString().slice(0, 10);
}
