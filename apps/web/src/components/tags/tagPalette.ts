// Auto-color palette for tags created from the picker. Deterministic by name
// length so re-creating the same name always picks the same swatch — that
// way deleting and re-adding a tag preserves visual identity. Distinct hues
// were chosen with rough perceptual separation in mind; all are mid-saturation
// so the chip's `${color}1f` background tint reads cleanly on both themes.
export const TAG_PALETTE = [
  '#ef4444', // red-500
  '#f97316', // orange-500
  '#eab308', // yellow-500
  '#22c55e', // green-500
  '#14b8a6', // teal-500
  '#0ea5e9', // sky-500
  '#6366f1', // indigo-500
  '#a855f7', // purple-500
  '#ec4899', // pink-500
  '#94a3b8', // slate-400 (legacy default)
] as const;

export const DEFAULT_TAG_COLOR = '#94a3b8';

export function pickColorFor(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return DEFAULT_TAG_COLOR;
  // Sum char codes for slightly better distribution than length alone — names
  // of the same length frequently appear together (e.g. "Hot" / "VIP" / "Top")
  // and we want them in different swatches.
  let h = 0;
  for (let i = 0; i < trimmed.length; i++) h = (h + trimmed.charCodeAt(i)) | 0;
  return TAG_PALETTE[Math.abs(h) % TAG_PALETTE.length]!;
}
