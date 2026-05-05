import { describe, expect, it } from 'vitest';
import type { docs_v1 } from 'googleapis';
import { flattenDocBody, parseSummaryDoc } from './summaryParser.js';

// Fixture-driven tests for the heuristic Gemini-summary parser. We
// deliberately don't try to model every possible Gemini doc format;
// instead we cover the patterns the spec calls out and the obvious
// edge cases we want robust handling for.

const GEMINI_NOTES_DOC = `
## Summary

Discussed Q3 renewal terms with Jane and the procurement team. Concerns
on multi-year discount; agreed to send a revised proposal by Friday.

## Action items

- William: Send revised proposal by Friday
- Jane (Acme): Confirm signing authority for multi-year terms
- Follow up next week with the security team
- **Priya** to circulate the SOC 2 report

## Notes

(unstructured stuff that should not pollute the action items)
`;

describe('parseSummaryDoc', () => {
  it('pulls the first body paragraph as excerpt', () => {
    const result = parseSummaryDoc(GEMINI_NOTES_DOC);
    expect(result.excerpt).toMatch(/^Discussed Q3 renewal terms/);
    expect(result.excerpt!.length).toBeLessThanOrEqual(280);
  });

  it('extracts owner-prefixed action items', () => {
    const result = parseSummaryDoc(GEMINI_NOTES_DOC);
    expect(result.actionItems).toHaveLength(4);
    const [first, second, third, fourth] = result.actionItems;
    expect(first?.ownerName).toBe('William');
    expect(first?.action).toBe('Send revised proposal by Friday');
    expect(second?.ownerName).toBe('Jane (Acme)');
    expect(third?.ownerName).toBeNull();
    expect(third?.action).toBe('Follow up next week with the security team');
    expect(fourth?.ownerName).toBe('Priya');
    expect(fourth?.action).toMatch(/SOC 2/);
  });

  it('stops the action-items block at the next heading', () => {
    const doc = `
## Action items
- William: do thing
- Priya: do other thing

## Some other section
- William: this should NOT be picked up
`;
    const r = parseSummaryDoc(doc);
    expect(r.actionItems).toHaveLength(2);
    expect(r.actionItems.map((a) => a.action)).not.toContain(
      'this should NOT be picked up',
    );
  });

  it('returns empty action items when the section is missing', () => {
    const doc = `## Summary\nGreat call.`;
    const r = parseSummaryDoc(doc);
    expect(r.actionItems).toHaveLength(0);
    expect(r.excerpt).toBe('Great call.');
  });

  it('truncates an overlong excerpt cleanly on a word boundary', () => {
    const long = 'X '.repeat(400).trim();
    const r = parseSummaryDoc(long);
    expect(r.excerpt!.length).toBeLessThanOrEqual(280);
    expect(r.excerpt!.endsWith('…')).toBe(true);
  });
});

describe('flattenDocBody (Gemini tab traversal)', () => {
  // Helper: build a Schema$Document with the given paragraphs in either
  // the doc body or a tab. Mirrors the shape Docs API hands back.
  const para = (text: string, heading = false): docs_v1.Schema$StructuralElement => ({
    paragraph: {
      paragraphStyle: heading ? { namedStyleType: 'HEADING_1' } : {},
      elements: [{ textRun: { content: text } }],
    },
  });

  it('reads default-tab body content', () => {
    const doc: docs_v1.Schema$Document = {
      body: { content: [para('Hello world')] },
    };
    expect(flattenDocBody(doc)).toContain('Hello world');
  });

  it('reads content from sibling tabs (the Gemini case)', () => {
    // Real Gemini docs put summary + transcript in *separate tabs* of
    // the same Doc. Without traversing tabs the parser sees an empty
    // body and writes no excerpt / extracts no action items.
    const doc: docs_v1.Schema$Document = {
      body: { content: [] },
      tabs: [
        {
          documentTab: {
            body: {
              content: [
                para('Summary', true),
                para('Discussed Q3 renewal terms with Jane.'),
                para('Action items', true),
                para('- William: Send revised proposal'),
              ],
            },
          },
        },
        {
          documentTab: {
            body: {
              content: [
                para('Transcript', true),
                para('Speaker 1: Hello.'),
              ],
            },
          },
        },
      ],
    };
    const text = flattenDocBody(doc);
    const parsed = parseSummaryDoc(text);
    expect(parsed.excerpt).toMatch(/^Discussed Q3 renewal terms/);
    expect(parsed.actionItems).toHaveLength(1);
    expect(parsed.actionItems[0]?.ownerName).toBe('William');
  });

  it('walks nested childTabs', () => {
    const doc: docs_v1.Schema$Document = {
      body: { content: [] },
      tabs: [
        {
          documentTab: { body: { content: [para('Outer')] } },
          childTabs: [
            { documentTab: { body: { content: [para('Inner')] } } },
          ],
        },
      ],
    };
    const text = flattenDocBody(doc);
    expect(text).toContain('Outer');
    expect(text).toContain('Inner');
  });
});
