import { CANONICAL_FIELDS_BY_ENTITY, SYNONYMS, type CanonicalField } from './synonyms.js';

export type EntityType = 'company' | 'contact' | 'deal' | 'note';

// Strip everything but a-z0-9 so "First Name" / "first_name" / "FirstName"
// collapse to the same key. We deliberately do not stem (no plural fold) —
// "addresses" and "address" should not be considered equal because the
// caller might genuinely have both columns.
export function normalizeHeader(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Confidence for a header→canonical match. 1.0 is exact synonym match,
// scaled down for substring or prefix matches. Threshold lives in
// suggestMapping; this function just produces the score.
function scoreSynonym(header: string, alias: string): number {
  const h = normalizeHeader(header);
  const a = normalizeHeader(alias);
  if (!h || !a) return 0;
  if (h === a) return 1;
  // "first_name" vs alias "first name" both normalize to "firstname" — the
  // exact branch above catches that. Below handles prefix/suffix overlaps.
  if (h.startsWith(a) && a.length >= 3) return 0.92;
  if (h.endsWith(a) && a.length >= 3) return 0.9;
  if (a.startsWith(h) && h.length >= 3) return 0.88;
  if (h.includes(a) && a.length >= 4) return 0.86;
  if (a.includes(h) && h.length >= 4) return 0.85;
  return 0;
}

export interface SuggestionResult {
  field: CanonicalField | null;
  confidence: number;
}

// Returns the best canonical-field match for a CSV header, or null if no
// alias clears the threshold. Threshold of 0.85 is the spec contract — a
// lower bar pre-fills wrong fields in subtle ways and the user has to undo
// them; a higher bar pushes too much manual mapping work. 0.85 was chosen
// to admit "first_name" → firstName but reject "phone" → companyPhone.
export function suggestField(
  header: string,
  entity: EntityType,
  threshold = 0.85,
): SuggestionResult {
  const synonyms = SYNONYMS[entity];
  let best: SuggestionResult = { field: null, confidence: 0 };
  for (const field of Object.keys(synonyms)) {
    const aliases = synonyms[field] ?? [];
    for (const alias of aliases) {
      const c = scoreSynonym(header, alias);
      if (c > best.confidence) {
        best = { field, confidence: c };
      }
    }
  }
  return best.confidence >= threshold ? best : { field: null, confidence: 0 };
}

export function suggestMapping(
  headers: string[],
  entity: EntityType,
): Record<string, CanonicalField | null> {
  // We track which canonical fields have already been assigned so the same
  // CSV doesn't auto-map two headers onto e.g. Contact.email — when there's
  // a collision, the higher-confidence header wins and the loser is left
  // unmapped. Manual override is one click in the UI.
  const taken = new Map<CanonicalField, { header: string; confidence: number }>();
  const result: Record<string, CanonicalField | null> = {};
  for (const h of headers) result[h] = null;

  // Two passes: collect best (header, field, score), then resolve conflicts
  // greedily by score so the strongest match locks in its target first.
  const candidates: { header: string; field: CanonicalField; confidence: number }[] = [];
  for (const h of headers) {
    const s = suggestField(h, entity);
    if (s.field) candidates.push({ header: h, field: s.field, confidence: s.confidence });
  }
  candidates.sort((a, b) => b.confidence - a.confidence);
  for (const c of candidates) {
    if (taken.has(c.field)) continue;
    if (result[c.header] != null) continue;
    result[c.header] = c.field;
    taken.set(c.field, { header: c.header, confidence: c.confidence });
  }
  return result;
}

export function canonicalFieldsFor(entity: EntityType): CanonicalField[] {
  return CANONICAL_FIELDS_BY_ENTITY[entity];
}
