// Lazy Anthropic client singleton. Constructed on first use so deployments
// without enrichment configured don't pay any startup cost. Throws a typed
// error when the API key isn't set — callers should short-circuit upstream
// (the job processor checks settings.enabled and the env key first), but
// this is the last-line guard.

import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../env.js';

let cached: Anthropic | null = null;

export class AnthropicNotConfiguredError extends Error {
  constructor() {
    super('ANTHROPIC_API_KEY is not set');
    this.name = 'AnthropicNotConfiguredError';
  }
}

export function getAnthropic(): Anthropic {
  if (!env.ANTHROPIC_API_KEY) throw new AnthropicNotConfiguredError();
  if (!cached) {
    cached = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }
  return cached;
}
