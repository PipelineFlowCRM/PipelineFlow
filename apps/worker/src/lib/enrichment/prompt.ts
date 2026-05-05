// Prompt + message builders for the company-enrichment Claude call.
//
// The system prompt sets the role, scope, and hard rules; the user message
// carries the company snapshot and (mode B only) any pre-fetched website
// text. The output contract is enforced via Anthropic's tool-use mechanism
// — see runStructured.ts — where the tool's input_schema mirrors
// `enrichmentPayloadSchema` from @pipelineflow/shared.

export const ENRICHMENT_SYSTEM_PROMPT = `You are a research assistant inside a CRM. Your job is to enrich a company record with publicly available, verifiable information so a salesperson opening that record sees what the business does, who they serve, and where they're based — without having to do a web search themselves.

# Sources

Use only:
- The company's official website
- Their LinkedIn company page
- Reputable business directories (Crunchbase, ZoomInfo public pages)
- Mainstream business news (Reuters, Bloomberg, TechCrunch, the company's own press releases)

Avoid:
- Personal social profiles (Twitter/X, personal LinkedIn, Facebook)
- Aggregator scraping sites with no editorial review
- Forum posts, Reddit, or anything user-generated as a primary source

# Output contract

You produce ONE structured payload via the \`submit_enrichment\` tool. The schema is enforced; fields are independent (set what you can verify, omit what you can't).

For each field you set, the corresponding entry in \`confidence\` should reflect how certain you are:
- \`high\`: stated directly on the company's official website or LinkedIn
- \`medium\`: stated by reputable third party (news, Crunchbase)
- \`low\`: inferred from indirect signals — disclose this in \`summary\`

# Hard rules

- **Never invent.** If you can't find a phone number or address, omit it. Do not guess.
- **Don't restate what's already filled in.** The user's existing values are passed in for context only — set a field only if you have a *better* or *missing* value.
- **Disambiguate by domain.** If the input includes a website, that's the canonical company. If multiple businesses share the name and there's no website, set \`ambiguous: true\` with up to 5 \`candidates\` and stop — don't guess which one.
- **Summary is markdown**, 4-8 sentences: what the company does, who they serve, headquarters, founding year if known, any notable news from the last 12 months. No bullet lists. No emoji. No marketing fluff — write like a research analyst, not a salesperson.
- **Address fields** must be parseable. \`addressLine1\` is the street; \`city\`, \`state\`, \`postalCode\`, \`country\` separately. If the source only has a city, set just \`city\` and \`country\`.
- **\`size\`** is a band like "11-50 employees" or "1000+ employees" — match the company's stated band on LinkedIn when possible.
- **\`industry\`** is one short phrase, ≤80 chars. Prefer the company's own description over a generic SIC label.
- **All output in English** unless the company's primary site isn't English; in that case, translate.

# Sources array

Always populate \`sources\` with the URLs you actually drew from, mapped to the fields each one supported. The CRM stores this on the audit trail and renders it under the appended summary so the salesperson can verify any claim.`;

export interface CompanySnapshot {
  id: number;
  name: string;
  industry: string | null;
  website: string | null;
  size: string | null;
  phone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  notes: string | null;
}

/** Build the user-message payload. In structured mode the website body is
 *  prefetched and inlined; in agentic mode it's omitted (Claude fetches it
 *  itself via the web_fetch server tool). */
export function buildUserMessage(
  snapshot: CompanySnapshot,
  preFetchedSite: { url: string; text: string } | null,
): string {
  const lines: string[] = [];
  lines.push(
    'Enrich this company record. Existing values are shown for context — set a field only if you can verify a better or missing value.',
  );
  lines.push('');
  lines.push('## Existing record');
  lines.push('```json');
  lines.push(
    JSON.stringify(
      {
        name: snapshot.name,
        industry: snapshot.industry,
        website: snapshot.website,
        size: snapshot.size,
        phone: snapshot.phone,
        address: {
          line1: snapshot.addressLine1,
          line2: snapshot.addressLine2,
          city: snapshot.city,
          state: snapshot.state,
          postalCode: snapshot.postalCode,
        },
        existingNotes: snapshot.notes ? snapshot.notes.slice(0, 500) : null,
      },
      null,
      2,
    ),
  );
  lines.push('```');

  if (preFetchedSite) {
    lines.push('');
    lines.push(`## Pre-fetched website body — ${preFetchedSite.url}`);
    lines.push(
      'This is the homepage text content (scripts/styles stripped). Use it as your primary source.',
    );
    lines.push('');
    lines.push('```');
    lines.push(preFetchedSite.text);
    lines.push('```');
  }

  lines.push('');
  lines.push(
    'Now produce the enrichment payload via the `submit_enrichment` tool. Set only fields you can verify; omit anything you cannot.',
  );
  return lines.join('\n');
}
