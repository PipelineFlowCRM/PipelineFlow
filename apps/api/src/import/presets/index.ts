import pipedrivePersons from './pipedrive-persons.json' with { type: 'json' };
import pipedriveOrganizations from './pipedrive-organizations.json' with { type: 'json' };
import pipedriveDeals from './pipedrive-deals.json' with { type: 'json' };
import pipedriveNotes from './pipedrive-notes.json' with { type: 'json' };
import hubspotContacts from './hubspot-contacts.json' with { type: 'json' };
import hubspotCompanies from './hubspot-companies.json' with { type: 'json' };
import salesforceLeads from './salesforce-leads.json' with { type: 'json' };
import { normalizeHeader } from '../mapping.js';

export interface Preset {
  key: string;
  sourceLabel: string;
  entityType: 'company' | 'contact' | 'deal' | 'note';
  requiredHeaders: string[];
  mapping: Record<string, string | null>;
  externalSource: string;
}

export const PRESETS: Preset[] = [
  pipedrivePersons,
  pipedriveOrganizations,
  pipedriveDeals,
  pipedriveNotes,
  hubspotContacts,
  hubspotCompanies,
  salesforceLeads,
] as Preset[];

// Match score: fraction of preset's `requiredHeaders` that are present in
// the CSV (case- and punctuation-insensitive). Threshold of 0.7 is the
// spec contract — high enough that user-built CSVs with one or two
// preset-shaped header names don't accidentally trigger detection, low
// enough that a Pipedrive export missing a column due to source-side
// permissions still matches.
export interface PresetMatch {
  preset: Preset;
  score: number;
  matchedHeaders: string[];
}

export function detectPreset(headers: string[]): PresetMatch | null {
  const normalizedSet = new Set(headers.map(normalizeHeader));
  let best: PresetMatch | null = null;
  for (const preset of PRESETS) {
    const matched: string[] = [];
    for (const required of preset.requiredHeaders) {
      if (normalizedSet.has(normalizeHeader(required))) matched.push(required);
    }
    const score = matched.length / preset.requiredHeaders.length;
    if (score >= 0.7 && (best == null || score > best.score)) {
      best = { preset, score, matchedHeaders: matched };
    }
  }
  return best;
}

// Build the initial { csvHeader: canonicalField | null } map by laying the
// preset over the CSV's actual headers. Headers not in the preset fall
// through to suggestMapping at the route layer.
export function applyPreset(
  preset: Preset,
  csvHeaders: string[],
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const h of csvHeaders) out[h] = null;
  // Build a normalized index of the preset's expected headers so a CSV
  // header with slight case/punctuation drift still picks up the mapping.
  const presetIndex = new Map<string, string | null>();
  for (const [k, v] of Object.entries(preset.mapping)) {
    presetIndex.set(normalizeHeader(k), v);
  }
  for (const h of csvHeaders) {
    const mapped = presetIndex.get(normalizeHeader(h));
    if (mapped !== undefined) out[h] = mapped;
  }
  return out;
}
