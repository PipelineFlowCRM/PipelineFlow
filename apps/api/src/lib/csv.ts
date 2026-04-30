/**
 * Prefix any cell whose first char would be interpreted as a formula by
 * Excel/Sheets/Numbers (=, +, -, @, tab, CR, LF). The leading apostrophe
 * is the standard mitigation — invisible in the rendered cell but blocks
 * formula parsing.
 */
export const csvNeutralize = (v: string): string =>
  /^[=+\-@\t\r\n]/.test(v) ? `'${v}` : v;

export const csvEscape = (v: string): string =>
  `"${csvNeutralize(v).replace(/"/g, '""')}"`;
