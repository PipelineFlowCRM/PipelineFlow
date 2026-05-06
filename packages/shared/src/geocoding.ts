// Address validation + query formatting shared by the api (enqueue gate),
// worker (re-check after pickup), and web (disabled-button check). Centralised
// here so a future tweak to "what counts as a full address" stays in one
// place.

export interface AddressParts {
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
}

export function isFullAddress(c: AddressParts): boolean {
  return Boolean(
    c.addressLine1?.trim() &&
      c.city?.trim() &&
      c.state?.trim() &&
      c.postalCode?.trim(),
  );
}

export function formatAddressQuery(c: AddressParts): string {
  return [c.addressLine1, c.city, c.state, c.postalCode]
    .map((s) => s?.trim())
    .filter((s): s is string => Boolean(s))
    .join(', ');
}
