import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { forbidden } from '../errors.js';
import { INSTRUCTIONS, refuseWriteTools, registerTools } from '../mcp/tools.js';
import type { ToolContext } from '../mcp/rest.js';

/** MCP requests per token per minute (SPEC §14). In memory, per process, like the other limiters (M24). */
export const MCP_RATE_LIMIT = 120;
const WINDOW_MS = 60_000;

/** Origins a browser may call /mcp from (DNS-rebinding guard; M13). Server-to-server calls send none. */
export function originAllowed(origin: string, appUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.origin === new URL(appUrl).origin) return true;
  if (url.protocol !== 'https:' || url.port) return false;
  const host = url.hostname;
  const under = (domain: string) => host === domain || host.endsWith(`.${domain}`);
  return under('claude.ai') || under('claude.com') || host.endsWith('.anthropic.com');
}

class TokenRateLimit {
  private readonly windows = new Map<string, { start: number; count: number }>();
  hit(tokenId: string, now: number): boolean {
    const w = this.windows.get(tokenId);
    if (!w || now - w.start >= WINDOW_MS) {
      if (this.windows.size > 10_000) {
        for (const [k, v] of this.windows) if (now - v.start >= WINDOW_MS) this.windows.delete(k);
      }
      this.windows.set(tokenId, { start: now, count: 1 });
      return true;
    }
    w.count += 1;
    return w.count <= MCP_RATE_LIMIT;
  }
}

/** The MCP endpoint (SPEC §14): stateless Streamable HTTP, one server per request, bearer auth only. */
export default async function mcpRoutes(app: FastifyInstance, opts: { version: string }) {
  const limiter = new TokenRateLimit();

  app.post('/mcp', { config: { bearer: true } }, async (req, reply) => {
    const principal = req.principal!;
    const origin = req.headers.origin;
    if (origin !== undefined && !originAllowed(origin, app.config.APP_URL)) throw forbidden('Origin not allowed');
    if (!limiter.hit(principal.token.id, Date.now())) {
      return reply
        .status(429)
        .header('Retry-After', '60')
        .send({ jsonrpc: '2.0', id: null, error: { code: -32000, message: `Rate limit: ${MCP_RATE_LIMIT} requests per minute per token` } });
    }

    const ctx: ToolContext = { app, principal };
    const server = new McpServer(
      { name: 'mekari-project', title: 'Mekari Project', version: opts.version },
      { instructions: INSTRUCTIONS },
    );
    registerTools(server, ctx, (entry) => {
      const line = { via: 'mcp', tokenId: principal.token.id, source: principal.token.source, client: principal.token.client?.name ?? null, userId: principal.user.id, ...entry };
      if (entry.err !== undefined) req.log.error(line, 'MCP tool call failed');
      else req.log.info(line, 'MCP tool call');
    });
    if (principal.token.scope !== 'WRITE') refuseWriteTools(server);
    // Stateless (no Mcp-Session-Id), plain JSON responses (M24).
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    // Everything above answered through Fastify; from here the SDK writes the raw response.
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (err) {
      req.log.error({ err }, 'MCP request failed');
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' });
        reply.raw.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } }));
      }
    }
  });

  // Stateless: no server-initiated stream (GET) and no session to end (DELETE).
  for (const method of ['GET', 'DELETE'] as const) {
    app.route({
      method,
      url: '/mcp',
      config: { public: true },
      handler: async (_req, reply) =>
        reply.status(405).header('Allow', 'POST').send({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method not allowed: use POST' } }),
    });
  }
}
