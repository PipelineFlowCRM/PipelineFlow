import { parsePhoneNumberFromString } from 'libphonenumber-js';

// Normalize a phone cell to E.164 international form when possible. If
// libphonenumber can't parse it (CSV cells often hold extensions, broken
// hyphens, or non-phone strings), keep the original — the contact still
// has *something* searchable, and the import does not fail.
//
// Default region "US" matches the spec's primary user case (Pipedrive
// migration). When a number is already international (`+44 ...`) the
// region hint is ignored.
export function parsePhone(input: string | null | undefined): string | null {
  if (input == null) return null;
  const s = String(input).trim();
  if (s === '') return null;
  const parsed = parsePhoneNumberFromString(s, 'US');
  if (parsed && parsed.isValid()) return parsed.formatInternational();
  return s;
}
