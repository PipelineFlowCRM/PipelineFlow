// Gemini summary doc parser. Extracts:
//   - The summary excerpt (first body paragraph or "Summary" section,
//     truncated to 280 characters).
//   - Action items as `[Owner Name]: [action description]` lines, with
//     a fallback to plain "- something to do" bullets when Gemini omits
//     the owner prefix.
//
// We deliberately avoid an LLM call here. Heuristic regex on the text
// gets ~70% of the value at zero per-call cost; the spec calls for ML
// only after we have a baseline + tuning data. A future v2 can swap in
// Anthropic without changing the call site — the function takes plain
// text and returns a structured result.
//
// The input is the *plain text projection* of the Doc body — the caller
// (worker) flattens the docs.documents.get() response into newline-
// joined text before handing it here. Keeping the parser plain-text-only
// lets us write fixture-driven tests without round-tripping the full
// Docs API tree.

const SUMMARY_MAX_CHARS = 280;

export interface ParsedSummary {
  excerpt: string | null;
  actionItems: ParsedActionItem[];
}

export interface ParsedActionItem {
  // The literal bullet line, retained for traceability and de-dup on
  // summary regeneration (Gemini sometimes re-emits the doc up to ~30
  // minutes after the call). The Task row stores this as
  // `sourceActionItemText`.
  rawText: string;
  // The owner name parsed from `[Owner]: [action]` form. Null when the
  // bullet doesn't carry an explicit owner — falls through to assigning
  // the meeting organizer once the worker resolves the row.
  ownerName: string | null;
  // The action sentence with the owner prefix stripped. This is what
  // becomes Task.title. Truncated to 255 chars to fit the column.
  action: string;
}

export function parseSummaryDoc(plainText: string): ParsedSummary {
  if (!plainText) return { excerpt: null, actionItems: [] };
  const lines = plainText.split(/\r?\n/);

  return {
    excerpt: extractExcerpt(lines),
    actionItems: extractActionItems(lines),
  };
}

function extractExcerpt(lines: string[]): string | null {
  // Strategy:
  //   1. If a "Summary" section heading exists, use the first non-empty
  //      paragraph after it.
  //   2. Otherwise, use the first non-empty paragraph in the doc.
  //   3. Skip lines that are obviously headings (start with #, end with
  //      a colon and have no other punctuation, or are all-caps).
  const summaryStart = findSectionStart(lines, /^summary\b/i);
  const startIndex = summaryStart >= 0 ? summaryStart + 1 : 0;
  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    if (looksLikeHeading(line)) continue;
    return truncate(line, SUMMARY_MAX_CHARS);
  }
  return null;
}

function extractActionItems(lines: string[]): ParsedActionItem[] {
  const start = findSectionStart(lines, /^action\s*items?\b/i);
  if (start < 0) return [];

  const out: ParsedActionItem[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const raw = lines[i]!.trim();
    if (!raw) continue;
    // Stop at the next section heading. A line that's a heading but
    // *not* a bullet ends the Action items block.
    if (!isBullet(raw) && looksLikeHeading(raw)) break;
    if (!isBullet(raw)) continue;
    const stripped = stripBulletMarker(raw);
    if (!stripped) continue;
    out.push(parseActionItemLine(stripped, raw));
  }
  return out;
}

function findSectionStart(lines: string[], pattern: RegExp): number {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    // Match a heading whose text matches the pattern. Strip leading
    // markdown # / numbering and trailing colons before testing.
    const headingText = line
      .replace(/^#+\s*/, '')
      .replace(/^\d+[).]\s*/, '')
      .replace(/[:.]\s*$/, '')
      .trim();
    if (pattern.test(headingText) && looksLikeHeading(line)) return i;
  }
  return -1;
}

function looksLikeHeading(line: string): boolean {
  // Heading heuristics:
  //   - Markdown # ## ###
  //   - Trailing colon with no inner punctuation (e.g. "Summary:" or
  //     "Action items:")
  //   - All-caps word-only line
  if (/^#{1,6}\s+/.test(line)) return true;
  if (/^[A-Z][A-Za-z0-9 \-_/]+:?$/.test(line) && line.length <= 80) {
    // Filter false positives: the first non-empty line of a body
    // paragraph also matches this. Insist on either a colon (heading
    // marker) or all-uppercase (also heading-like).
    if (/:\s*$/.test(line)) return true;
    if (line === line.toUpperCase()) return true;
  }
  return false;
}

function isBullet(line: string): boolean {
  return /^[-*•]\s+/.test(line) || /^\d+[).]\s+/.test(line);
}

function stripBulletMarker(line: string): string {
  return line
    .replace(/^[-*•]\s+/, '')
    .replace(/^\d+[).]\s+/, '')
    .trim();
}

function parseActionItemLine(stripped: string, raw: string): ParsedActionItem {
  // Owner-prefix forms we accept:
  //   "Will follow up on pricing — William"
  //   "William: Send the deck"
  //   "**William** to send the deck"
  //   "[William] follow up on pricing"
  // Kept narrow on purpose — a too-eager regex starts pulling product
  // names out as owners ("Acme: review the proposal" would attribute
  // to Acme as a customer commitment).

  // Form A: "Owner: action" — owner may include letters, spaces, the
  // usual name punctuation, and parenthetical company suffixes
  // ("Jane (Acme): ..."). The colon is the strong delimiter; we don't
  // accept a bare hyphen as a separator here because it's too easy for
  // a hyphen to appear naturally inside an action sentence and pull
  // the regex in the wrong direction.
  let m = /^([A-Z][A-Za-z0-9'.\-() ]{1,60}?)\s*[:—]\s+(.+)$/.exec(stripped);
  if (m) {
    return {
      rawText: raw,
      ownerName: m[1]!.trim(),
      action: truncate(m[2]!.trim(), 255),
    };
  }
  // Form B: "**Owner** ..."
  m = /^\*{1,2}([A-Z][A-Za-z0-9'.\-() ]{1,60})\*{1,2}\s+(.+)$/.exec(stripped);
  if (m) {
    return {
      rawText: raw,
      ownerName: m[1]!.trim(),
      action: truncate(m[2]!.trim(), 255),
    };
  }
  // Form C: "[Owner] ..."
  m = /^\[([A-Z][A-Za-z0-9'.\-() ]{1,60})\]\s+(.+)$/.exec(stripped);
  if (m) {
    return {
      rawText: raw,
      ownerName: m[1]!.trim(),
      action: truncate(m[2]!.trim(), 255),
    };
  }
  // No owner — treat the whole bullet as the action.
  return { rawText: raw, ownerName: null, action: truncate(stripped, 255) };
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  // Cut on the closest preceding word boundary so we don't slice mid-token.
  const slice = text.slice(0, max - 1);
  const space = slice.lastIndexOf(' ');
  if (space > max * 0.5) return `${slice.slice(0, space)}…`;
  return `${slice}…`;
}

// Flatten the Docs API body into plain text. The Docs API gives back a
// tree of paragraphs containing structured elements; we only need the
// human-readable text for the parser, so we walk the tree and collect
// textRun.content. Headings come through with paragraphStyle.namedStyleType
// like "HEADING_1" — we prefix them with "## " so the heading detector
// picks them up.
//
// Tabs: Gemini "Notes by Gemini" docs put summary and transcript in
// **separate tabs** of the same Doc. The Docs API exposes those at
// `Document.tabs[].documentTab.body.content` (with optional nested
// `childTabs`). The default-tab `body` may exist alongside tabs or may
// be empty when all content lives under a tab. We concatenate every
// tab's content with the doc-level body so the parser's heading
// detection still finds "Action items" / "Summary" regardless of which
// tab Gemini wrote them into.
import type { docs_v1 } from 'googleapis';

export function flattenDocBody(doc: docs_v1.Schema$Document): string {
  const sections: string[] = [];
  const docBody = flattenStructuralElements(doc.body?.content ?? []);
  if (docBody) sections.push(docBody);

  for (const tab of doc.tabs ?? []) {
    const tabText = flattenTab(tab);
    if (tabText) sections.push(tabText);
  }

  return sections.join('\n\n');
}

function flattenTab(tab: docs_v1.Schema$Tab): string {
  const parts: string[] = [];
  const body = tab.documentTab?.body?.content ?? [];
  const flat = flattenStructuralElements(body);
  if (flat) parts.push(flat);
  for (const child of tab.childTabs ?? []) {
    const childText = flattenTab(child);
    if (childText) parts.push(childText);
  }
  return parts.join('\n\n');
}

function flattenStructuralElements(
  content: docs_v1.Schema$StructuralElement[],
): string {
  const out: string[] = [];
  for (const el of content) {
    if (!el.paragraph) continue;
    const para = el.paragraph;
    const styleType = para.paragraphStyle?.namedStyleType ?? '';
    const text = (para.elements ?? [])
      .map((pe) => pe.textRun?.content ?? '')
      .join('')
      .replace(/\n+$/, '');
    if (!text.trim()) {
      out.push('');
      continue;
    }
    if (/^HEADING_/.test(styleType)) {
      out.push(`## ${text}`);
    } else {
      out.push(text);
    }
  }
  return out.join('\n');
}
