// Mode B — single-call structured-output run.
//
// One Anthropic round-trip: we hand Claude the company snapshot + (optional)
// pre-fetched website body and force the response through the
// `submit_enrichment` tool's input_schema. Cheaper and more predictable than
// agentic mode, but Claude can't follow links or search — set the website
// field accurately on the source record for best results.

import {
  enrichmentPayloadSchema,
  type EnrichmentPayload,
} from '@pipelineflow/shared';
import { env } from '../../env.js';
import { logger } from '../../logger.js';
import { getAnthropic } from './client.js';
import {
  buildUserMessage,
  ENRICHMENT_SYSTEM_PROMPT,
  type CompanySnapshot,
} from './prompt.js';
import { fetchCompanySite } from './webFetch.js';
import { SUBMIT_ENRICHMENT_TOOL } from './toolSchema.js';

export interface RunResult {
  payload: EnrichmentPayload;
  sourceUrl: string | null;
  /** Anthropic usage stats for cost accounting. */
  inputTokens: number;
  outputTokens: number;
  /** Tokens billed to write to the prompt cache (first call after a TTL
   *  expiry). 0 on cache hits. */
  cacheCreationTokens: number;
  /** Tokens served from the cache at ~10% of input price. */
  cacheReadTokens: number;
}

export async function runStructured(snapshot: CompanySnapshot): Promise<RunResult> {
  const site = snapshot.website ? await fetchCompanySite(snapshot.website) : null;
  const userMessage = buildUserMessage(
    snapshot,
    site && !site.jsOnly ? { url: site.url, text: site.text } : null,
  );

  const client = getAnthropic();
  const response = await client.messages.create({
    model: env.ANTHROPIC_MODEL,
    max_tokens: env.ANTHROPIC_ENRICHMENT_MAX_TOKENS,
    // Block-shaped system parameter so we can attach cache_control. The
    // system prompt is identical across calls; caching it drops input
    // tokens by an order of magnitude after the first call within the
    // 5-minute TTL.
    system: [
      {
        type: 'text',
        text: ENRICHMENT_SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: userMessage }],
    tools: [SUBMIT_ENRICHMENT_TOOL],
    // Force Claude to invoke our submission tool — no free-form text replies.
    tool_choice: { type: 'tool', name: 'submit_enrichment' },
  });

  const toolUse = response.content.find(
    (b): b is Extract<typeof b, { type: 'tool_use' }> => b.type === 'tool_use',
  );
  if (!toolUse) {
    logger.warn(
      { stopReason: response.stop_reason, contentTypes: response.content.map((c) => c.type) },
      'enrichment: structured run produced no tool_use block',
    );
    throw new Error('Claude did not call submit_enrichment');
  }

  const parsed = enrichmentPayloadSchema.safeParse(toolUse.input);
  if (!parsed.success) {
    logger.warn(
      { issues: parsed.error.issues.slice(0, 5) },
      'enrichment: structured payload failed validation',
    );
    throw new Error('Enrichment payload failed validation');
  }

  return {
    payload: parsed.data,
    sourceUrl: site?.url ?? null,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
    cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
  };
}
