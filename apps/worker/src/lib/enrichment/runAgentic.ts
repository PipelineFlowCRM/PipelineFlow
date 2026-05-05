// Mode A — agentic loop with Anthropic-hosted web_search and web_fetch.
//
// Claude orchestrates its own research: it can call web_search to find pages,
// web_fetch to read them, and finally `submit_enrichment` to land the result.
// We loop until Claude either submits the payload or hits the iteration cap.
// Server tools (web_search / web_fetch) are resolved by Anthropic — the
// response stream contains both the assistant's tool_use blocks and the
// resolved tool_result blocks already, so we just feed them back into the
// next turn unchanged.
//
// The tool-version strings (`web_search_*`, `web_fetch_*`) are date-pinned
// by Anthropic's API. If the pinned versions stop being supported, bump
// these and the operator will need a model that supports the new versions.

import {
  enrichmentPayloadSchema,
  type EnrichmentPayload,
} from '@pipelineflow/shared';
import type Anthropic from '@anthropic-ai/sdk';
import { env } from '../../env.js';
import { logger } from '../../logger.js';
import { getAnthropic } from './client.js';
import {
  buildUserMessage,
  ENRICHMENT_SYSTEM_PROMPT,
  type CompanySnapshot,
} from './prompt.js';
import { SUBMIT_ENRICHMENT_TOOL } from './toolSchema.js';
import type { RunResult } from './runStructured.js';

const MAX_ITERATIONS = 8;

const WEB_SEARCH_TOOL = {
  type: 'web_search_20250305' as const,
  name: 'web_search',
  max_uses: 4,
};

const WEB_FETCH_TOOL = {
  type: 'web_fetch_20250910' as const,
  name: 'web_fetch',
  max_uses: 6,
};

export async function runAgentic(snapshot: CompanySnapshot): Promise<RunResult> {
  const client = getAnthropic();
  const messages: Anthropic.Messages.MessageParam[] = [
    { role: 'user', content: buildUserMessage(snapshot, null) },
  ];

  let payload: EnrichmentPayload | null = null;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheCreationTokens = 0;
  let totalCacheReadTokens = 0;

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    // Cast to any: the Anthropic SDK's TS types don't yet model the
    // server-tool variants (web_search / web_fetch), and trying to satisfy
    // the discriminated union ergonomics here is busywork. The wire shape
    // is correct.
    const response = await client.messages.create({
      model: env.ANTHROPIC_MODEL,
      max_tokens: env.ANTHROPIC_ENRICHMENT_MAX_TOKENS,
      // Cached system block — see runStructured.ts for the rationale.
      system: [
        {
          type: 'text',
          text: ENRICHMENT_SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages,
      // SUBMIT_ENRICHMENT_TOOL has cache_control attached (it's the last
      // tool, so the cache covers the whole tools array).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: [WEB_SEARCH_TOOL, WEB_FETCH_TOOL, SUBMIT_ENRICHMENT_TOOL] as any,
    });

    totalInputTokens += response.usage.input_tokens;
    totalOutputTokens += response.usage.output_tokens;
    totalCacheCreationTokens += response.usage.cache_creation_input_tokens ?? 0;
    totalCacheReadTokens += response.usage.cache_read_input_tokens ?? 0;

    for (const block of response.content) {
      if (block.type === 'tool_use' && block.name === 'submit_enrichment') {
        const parsed = enrichmentPayloadSchema.safeParse(block.input);
        if (!parsed.success) {
          throw new Error('Enrichment payload failed validation');
        }
        payload = parsed.data;
        break;
      }
    }
    if (payload) break;

    // No submit yet — feed the assistant's content (which already includes
    // resolved server-tool results from web_search/web_fetch) back as the
    // next assistant turn so Claude can continue. The loop exits if it
    // signals end_turn without submitting.
    messages.push({ role: 'assistant', content: response.content });
    if (response.stop_reason === 'end_turn') break;
    if (response.stop_reason === 'max_tokens') {
      // Truncated mid-response. Bump tokens or model — but don't keep
      // hammering inside the loop.
      break;
    }
  }

  if (!payload) {
    logger.warn('enrichment: agentic run hit iter cap without submitting');
    throw new Error('Claude did not submit an enrichment payload within the iteration limit');
  }

  return {
    payload,
    sourceUrl: null,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    cacheCreationTokens: totalCacheCreationTokens,
    cacheReadTokens: totalCacheReadTokens,
  };
}
