// Single source of truth for US state codes + the LLM-output normalizer.
//
// Company.state is constrained to a 2-letter USPS code via z.enum(US_STATES)
// in companyCreateSchema. The enrichment LLM, however, naturally produces
// full names ("Alabama") — which sail through the permissive enrichment
// payload schema, land in the DB, and break every subsequent
// PATCH /companies/:id (the company update schema rejects anything outside
// the enum). normalizeUsState() coerces full names → codes (and lowercases
// codes → uppercased codes) so we can defensively run it at every write
// seam and skip the field rather than corrupt the row.
//
// The map's value type is `UsStateCode`, so TypeScript will catch a drift
// where someone adds a name → code entry pointing at a code that isn't in
// US_STATES.

export const US_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS',
  'KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY',
  'NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV',
  'WI','WY','DC',
] as const;

export type UsStateCode = (typeof US_STATES)[number];

const US_STATE_NAME_TO_CODE: Readonly<Record<string, UsStateCode>> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR',
  california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE',
  florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID',
  illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS',
  kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS',
  missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM',
  'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND',
  ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA',
  'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD',
  tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV',
  wisconsin: 'WI', wyoming: 'WY', 'district of columbia': 'DC',
};

const US_STATE_CODES: ReadonlySet<string> = new Set(US_STATES);

/** Coerce a free-form state value to a 2-letter USPS code, or null if it
 *  can't be resolved. Accepts codes ("CA", "ca"), full names ("California",
 *  "CALIFORNIA"), and trims surrounding whitespace. Returns null for
 *  unknown inputs so the caller can skip the field instead of writing
 *  invalid data. */
export function normalizeUsState(input: unknown): UsStateCode | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (trimmed === '') return null;
  const upper = trimmed.toUpperCase();
  if (upper.length === 2 && US_STATE_CODES.has(upper)) return upper as UsStateCode;
  return US_STATE_NAME_TO_CODE[trimmed.toLowerCase()] ?? null;
}
