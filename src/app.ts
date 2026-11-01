import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { type Clock, OffsetClock, systemClock } from './clock.js';
import type { Config } from './config.js';
import type { AppContext } from './context.js';
import { type Pool, createPool, migrate } from './db.js';
import { registerLab } from './lab/routes.js';
import { installHttp } from './lib/http.js';
import { registerInbox } from './lib/inbox.js';
import { Outbox } from './lib/outbox.js';
import type { Fetch, Peer } from './lib/peer.js';
import { Vault, parseKeyRing } from './lib/vault.js';
import { originHandlers, registerOrigin } from './origin/routes.js';
import { partnerHandlers, registerPartner } from './partner/routes.js';

export interface Built {
  app: FastifyInstance;
  ctx: AppContext;
  /** Runs one dispatcher tick now (the lab's button, and the tests, call this instead of waiting for the timer). */
  tick: () => Promise<void>;
  close: () => Promise<void>;
}

export interface Overrides {
  clock?: Clock;
  pool?: Pool;
  fetchImpl?: Fetch;
  logger?: boolean;
}

/** The scripts and styles of the site are all same-origin files: nothing inline, nothing from elsewhere. */
export const SITE_CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

export async function buildApp(config: Config, overrides: Overrides = {}): Promise<Built> {
  const clock: Clock = overrides.clock ?? (config.labMode ? new OffsetClock() : systemClock);
  const pool = overrides.pool ?? createPool(config.databaseUrl);
  await migrate(pool, config.role);

  const peer: Peer | null = config.peer
    ? { name: config.peer.name, url: config.peer.url, secret: config.secretOut }
    : null;
  const outbox = new Outbox({
    pool,
    clock,
    settings: config.outbox,
    peer,
    ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}),
  });
  const ctx: AppContext = {
    config,
    pool,
    clock,
    vault: { current: new Vault(parseKeyRing(config.vaultKeys), config.blindIndexKey) },
    outbox,
    peer,
    outage: { mode: 'none' },
  };

  const app = Fastify({
    logger: overrides.logger ?? false,
    bodyLimit: 4 * 1024 * 1024,
    trustProxy: false,
    // A signed document link is `<uuid>.<expiry>.<64 hex>` = 112 characters. The router's default cap on a path
    // parameter is 100, past which it answers "no such route" - the link would be valid and unreachable.
    maxParamLength: 256,
  });
  installHttp(app);

  // Lab only: simulates the other company being down (503) or not having deployed the route yet (404).
  app.addHook('onRequest', async (request, reply) => {
    if (ctx.outage.mode !== 'none' && request.url.startsWith('/v1/events')) {
      return reply
        .status(ctx.outage.mode === 'down' ? 503 : 404)
        .send({ error: { code: 'simulated', message: 'simulated outage' } });
    }
    return undefined;
  });

  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_request, reply) => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ok', role: config.role, peerConfigured: peer !== null };
    } catch {
      return reply.status(503).send({ status: 'unavailable' });
    }
  });

  registerInbox(app, {
    pool,
    clock,
    peerName: config.peer?.name ?? 'peer',
    secrets: () => config.secretsIn,
    handlers: config.role === 'origin' ? originHandlers(ctx) : partnerHandlers(ctx),
  });
  if (config.role === 'origin') registerOrigin(app, ctx);
  else registerPartner(app, ctx);
  if (config.labMode) registerLab(app, ctx);

  if (config.siteDir) {
    app.addHook('onSend', async (request, reply) => {
      if (!request.url.startsWith('/v1/') && !request.url.startsWith('/health/'))
        reply.header('content-security-policy', SITE_CSP);
    });
    await app.register(fastifyStatic, {
      root: resolve(process.cwd(), config.siteDir), // resolve, not join: SITE_DIR may be absolute (/app/site)
      index: ['index.html'],
      wildcard: false,
    });
  }

  // One dispatcher tick at a time: a slow tick must not overlap the next one (the claim would protect us, but wasting
  // connections on a pile-up is how a small outage becomes a big one).
  let ticking = false;
  const tick = async (): Promise<void> => {
    if (ticking) return;
    ticking = true;
    try {
      await outbox.deliverBatch();
    } catch (error) {
      app.log.error({ err: error }, 'dispatcher tick failed');
    } finally {
      ticking = false;
    }
  };
  const timer = config.outbox.intervalMs > 0 && peer ? setInterval(() => void tick(), config.outbox.intervalMs) : null;
  timer?.unref();

  return {
    app,
    ctx,
    tick,
    close: async () => {
      if (timer) clearInterval(timer);
      await app.close();
      if (!overrides.pool) await pool.end();
    },
  };
}
