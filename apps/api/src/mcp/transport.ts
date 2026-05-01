import { Router } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { authenticateApiToken, touchLastUsed, tokenScopes } from '../auth/apiToken.js';
import { logger } from '../lib/logger.js';
import { rateLimit } from '../lib/rateLimit.js';
import { buildMcpServerForToken } from './server.js';

// Per-IP cap on MCP requests. The MCP SDK chunks a session into many
// JSON-RPC messages; this is a coarse safety net against an agent
// runaway loop. Tuned generously (300/5min) — a normal Claude
// conversation issues a handful per turn.
const mcpLimiter = rateLimit({
  max: 300,
  message: 'Too many MCP requests, slow down',
});

export const mcpRouter = Router();

// MCP runs over its own JSON-RPC envelope, not REST. The streamable HTTP
// transport handles its own request parsing — but Express has already
// consumed the body via `express.json()` so we pass it through as the
// third arg per the SDK example.
mcpRouter.post('/', mcpLimiter, async (req, res, next) => {
  const header = req.get('authorization');
  if (!header || !header.toLowerCase().startsWith('bearer ')) {
    res.status(401).json({
      jsonrpc: '2.0',
      error: {
        code: -32001,
        message: 'Missing Authorization: Bearer <token>',
      },
      id: null,
    });
    return;
  }
  const raw = header.slice(7).trim();
  let token;
  try {
    token = await authenticateApiToken(raw);
  } catch (err) {
    return next(err);
  }
  if (!token) {
    res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Invalid or revoked API token' },
      id: null,
    });
    return;
  }
  if (tokenScopes(token).length === 0) {
    res.status(403).json({
      jsonrpc: '2.0',
      error: { code: -32002, message: 'Token has no scopes' },
      id: null,
    });
    return;
  }
  // Lazy lastUsed update; debounced to once-a-minute by the helper.
  void touchLastUsed(token);

  const server = buildMcpServerForToken(token);
  // Stateless transport: each request is self-contained, no session
  // table to manage. That matches the request shape of a closed-form
  // MCP HTTP call (Claude Desktop / Code → POST → response).
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  // The transport's lifecycle owns res; on close, tear down the server
  // so we don't accumulate dead McpServer instances per request.
  res.on('close', () => {
    void transport.close().catch(() => undefined);
    void server.close().catch(() => undefined);
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    logger.error({ err, tokenId: token.id }, 'mcp request handler failed');
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

// MCP clients negotiate streaming via GET (SSE establishment); without
// session state we have nothing to stream, so reject cleanly.
mcpRouter.get('/', (_req, res) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed (server runs in stateless mode — POST only).' },
    id: null,
  });
});

mcpRouter.delete('/', (_req, res) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed (stateless mode — no session to terminate).' },
    id: null,
  });
});
