import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { conflict, notFound } from '../errors.js';
import { generateToken, listTokens, liveTokenWhere, MAX_ACTIVE_PATS, revokeToken, toTokenInfo } from '../lib/tokens.js';
import { idParams, parse } from '../lib/validate.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const CreateBody = z
  .object({
    name: z.string().trim().min(1).max(60),
    scope: z.enum(['READ', 'WRITE']),
    /** null = never expires. Default 90 days (SPEC §14). */
    expiresInDays: z.union([z.literal(30), z.literal(90), z.literal(365), z.null()]).default(90),
  })
  .strict();

/** Personal access tokens and connected apps (SPEC §14, web Settings). Cookie auth, like every /api/v1 route. */
export default async function tokenRoutes(app: FastifyInstance) {
  const db = app.db;

  // The FE needs both to show the MCP URL and to hide token creation when the feature is off (M9).
  app.get('/config', async () => ({ appUrl: app.config.APP_URL, mcpEnabled: app.config.MCP_ENABLED ?? false }));

  // Listing and revoking work with MCP off too, so people can always clean up (M9).
  app.get('/me/tokens', async (req) => ({ data: await listTokens(db, req.user.id, new Date()) }));

  app.post('/me/tokens', async (req, reply) => {
    if (!app.config.MCP_ENABLED) throw notFound('Route');
    const body = parse(CreateBody, req.body);
    const now = new Date();
    const secret = generateToken('mpat');
    const created = await db.$transaction(async (tx) => {
      // One user's creates are serialised, so two at once can't both take the 20th slot.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`api-tokens:${req.user.id}`}))`;
      const active = await tx.apiToken.count({ where: { AND: [{ userId: req.user.id, source: 'PAT' }, liveTokenWhere(now)] } });
      if (active >= MAX_ACTIVE_PATS) throw conflict(`At most ${MAX_ACTIVE_PATS} active tokens; revoke one first`);
      return tx.apiToken.create({
        data: {
          userId: req.user.id,
          name: body.name,
          source: 'PAT',
          scope: body.scope,
          prefix: secret.prefix,
          tokenHash: secret.hash,
          createdAt: now,
          expiresAt: body.expiresInDays === null ? null : new Date(now.getTime() + body.expiresInDays * DAY_MS),
        },
      });
    });
    // The only time the plaintext exists outside the caller's hands.
    return reply.status(201).send({ token: secret.token, info: toTokenInfo(created) });
  });

  app.delete('/me/tokens/:id', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    if (!(await revokeToken(db, req.user.id, id, new Date()))) throw notFound('Token');
    return reply.status(204).send();
  });
}
