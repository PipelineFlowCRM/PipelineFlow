// JSON Schema input contract for the Claude `submit_enrichment` tool.
// Hand-rolled to mirror enrichmentPayloadSchema in @pipelineflow/shared —
// kept in this worker module so we control the exact schema sent to
// Anthropic without pulling zod-to-json-schema (and its transitive cost)
// into the worker. If you change the zod schema, update this in lockstep
// and verify with the runStructured.test fixtures.

export const SUBMIT_ENRICHMENT_TOOL = {
  name: 'submit_enrichment',
  description:
    'Submit the enrichment payload for the company. Set fields you can verify; omit anything unverifiable. Always populate `sources` so the audit trail can attribute each claim.',
  // Cache the tool block — the input_schema below is identical for every
  // call, and Anthropic's prompt cache covers the tools array. Combined
  // with the system-prompt cache_control in run*.ts this drops input
  // tokens by ~90% on cached calls.
  cache_control: { type: 'ephemeral' as const },
  input_schema: {
    type: 'object' as const,
    properties: {
      industry: { type: ['string', 'null'], maxLength: 120 },
      size: { type: ['string', 'null'], maxLength: 40 },
      website: { type: ['string', 'null'], maxLength: 500, format: 'uri' },
      phone: { type: ['string', 'null'], maxLength: 40 },
      addressLine1: { type: ['string', 'null'], maxLength: 200 },
      addressLine2: { type: ['string', 'null'], maxLength: 200 },
      city: { type: ['string', 'null'], maxLength: 100 },
      state: { type: ['string', 'null'], maxLength: 80 },
      postalCode: { type: ['string', 'null'], maxLength: 20 },
      country: { type: ['string', 'null'], maxLength: 80 },
      summary: { type: ['string', 'null'], maxLength: 4000 },
      confidence: {
        type: 'object',
        additionalProperties: false,
        properties: {
          industry: { enum: ['high', 'medium', 'low'] },
          size: { enum: ['high', 'medium', 'low'] },
          website: { enum: ['high', 'medium', 'low'] },
          phone: { enum: ['high', 'medium', 'low'] },
          addressLine1: { enum: ['high', 'medium', 'low'] },
          city: { enum: ['high', 'medium', 'low'] },
          state: { enum: ['high', 'medium', 'low'] },
          postalCode: { enum: ['high', 'medium', 'low'] },
          country: { enum: ['high', 'medium', 'low'] },
        },
      },
      sources: {
        type: 'array',
        maxItems: 20,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['url', 'fields'],
          properties: {
            url: { type: 'string', maxLength: 500, format: 'uri' },
            fields: {
              type: 'array',
              maxItems: 40,
              items: { type: 'string', maxLength: 80 },
            },
          },
        },
      },
      ambiguous: { type: 'boolean' },
      candidates: {
        type: 'array',
        maxItems: 5,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name'],
          properties: {
            name: { type: 'string', maxLength: 200 },
            website: { type: 'string', maxLength: 500, format: 'uri' },
            reason: { type: 'string', maxLength: 400 },
          },
        },
      },
    },
  },
};
