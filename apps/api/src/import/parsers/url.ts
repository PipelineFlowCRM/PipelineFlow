// Normalize a website cell to a canonical http(s):// URL. Bare domains
// ("acme.com") get an https:// prefix; values that already include a
// scheme are kept verbatim. Invalid inputs return null + an error; the
// caller decides whether website is required for the entity.
export function parseUrl(input: string | null | undefined): {
  value: string | null;
  error: string | null;
} {
  if (input == null) return { value: null, error: null };
  let s = String(input).trim();
  if (s === '') return { value: null, error: null };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    s = `https://${s}`;
  }
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return { value: null, error: `url: only http(s) URLs are supported ("${input}")` };
    }
    return { value: u.toString().replace(/\/$/, ''), error: null };
  } catch {
    return { value: null, error: `url: not a valid URL ("${input}")` };
  }
}
