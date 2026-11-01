import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import pg from 'pg';
import { type Built, buildApp } from '../src/app.js';
import type { Clock } from '../src/clock.js';
import { type Config, loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import { sign } from '../src/lib/signing.js';
import { fresh, freshKeyHex } from './helpers.js';

export const DATABASE_URL = process.env.DATABASE_URL ?? '';

/** A clock the tests move by hand. */
export class TestClock implements Clock {
  #ms = Date.parse('2030-01-15T12:00:00Z');
  now(): Date {
    return new Date(this.#ms);
  }
  advance(seconds: number): void {
    this.#ms += seconds * 1000;
  }
}

// Ports come from a range BELOW the kernel's ephemeral range (32768+). Asking the OS for port 0 hands out an
// ephemeral port, and the outgoing connections of tests running in parallel use the same range: a port that was free
// when probed could be taken by someone else's client socket before the server got to listen on it.
const PORT_FROM = 20000;
const PORT_TO = 29999;
const handedOut = new Set<number>();

const canListen = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });

const freePort = async (): Promise<number> => {
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = PORT_FROM + Math.floor(Math.random() * (PORT_TO - PORT_FROM + 1));
    if (handedOut.has(port)) continue;
    if (await canListen(port)) {
      handedOut.add(port);
      return port;
    }
  }
  throw new Error('no free port found for the test world');
};

export interface Side {
  built: Built;
  url: string;
  config: Config;
  schema: string;
}

export interface World {
  origin: Side;
  partner: Side;
  clock: TestClock;
  secrets: { originToPartner: string; partnerToOrigin: string };
  apiKey: string;
  /** Raw SQL against either side's schema. */
  sql: (side: Side, text: string, values?: unknown[]) => Promise<pg.QueryResultRow[]>;
  close: () => Promise<void>;
}

/** Wall-clock time with a no-op `advance`, for lab worlds whose services keep their own (offset) clocks. */
class RealClock extends TestClock {
  override now(): Date {
    return new Date();
  }
}

export interface WorldOptions {
  /** Set SERVICE_URL on the origin to its real listening address (PUBLIC_URL may then say anything). */
  originServiceUrl?: boolean;
  /** Lab mode on both services, each with its own movable clock, and each knowing the other's API key. */
  lab?: boolean;
  partnerEnv?: Record<string, string>;
  originEnv?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

export async function startWorld(options: WorldOptions = {}): Promise<World> {
  const admin = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
  const suffix = randomBytes(4).toString('hex');
  const schemas = { origin: `t_origin_${suffix}`, partner: `t_partner_${suffix}` };
  for (const schema of Object.values(schemas)) await admin.query(`CREATE SCHEMA ${schema}`);

  const [originPort, partnerPort] = [await freePort(), await freePort()];
  const urls = { origin: `http://127.0.0.1:${originPort}`, partner: `http://127.0.0.1:${partnerPort}` };
  const secrets = { originToPartner: fresh(), partnerToOrigin: fresh() };
  const apiKey = fresh(12);
  const clock = options.lab ? new RealClock() : new TestClock();

  const base = {
    DATABASE_URL,
    APP_ENV: 'test',
    API_KEY: apiKey,
    VAULT_KEYS: `v1:${freshKeyHex()}`,
    BLIND_INDEX_KEY: fresh(),
    OUTBOX_INTERVAL_MS: '0', // tests drive the dispatcher by hand
    OUTBOX_BACKOFF_BASE_MS: '60000',
    ALLOWED_RETURN_ORIGINS: 'https://shop.example.com',
    ...(options.lab ? { LAB_MODE: 'true', PEER_API_KEY: apiKey } : {}),
  };
  const originConfig = loadConfig({
    ...base,
    ROLE: 'origin',
    PORT: String(originPort),
    PEER_NAME: 'partner',
    PEER_URL: urls.partner,
    SECRET_OUT: secrets.originToPartner,
    SECRET_IN: secrets.partnerToOrigin,
    PUBLIC_URL: urls.origin,
    ...(options.originServiceUrl ? { SERVICE_URL: urls.origin } : {}),
    ...options.originEnv,
  });
  const partnerConfig = loadConfig({
    ...base,
    ROLE: 'partner',
    PORT: String(partnerPort),
    PEER_NAME: 'origin',
    PEER_URL: urls.origin,
    SECRET_OUT: secrets.partnerToOrigin,
    SECRET_IN: secrets.originToPartner,
    PUBLIC_URL: urls.partner,
    ...options.partnerEnv,
  });

  const make = async (config: Config, schema: string, fetchImpl?: typeof fetch): Promise<Side> => {
    const built = await buildApp(config, {
      ...(options.lab ? {} : { clock }),
      pool: createPool(DATABASE_URL, { schema }),
      ...(fetchImpl ? { fetchImpl } : {}),
    });
    await built.app.listen({ port: config.port, host: '127.0.0.1' });
    return { built, url: `http://127.0.0.1:${config.port}`, config, schema };
  };
  const origin = await make(originConfig, schemas.origin, options.fetchImpl);
  const partner = await make(partnerConfig, schemas.partner, options.fetchImpl);

  return {
    origin,
    partner,
    clock,
    secrets,
    apiKey,
    sql: async (side, text, values = []) => (await side.built.ctx.pool.query(text, values)).rows,
    close: async () => {
      await origin.built.close();
      await partner.built.close();
      await origin.built.ctx.pool.end().catch(() => undefined);
      await partner.built.ctx.pool.end().catch(() => undefined);
      for (const schema of Object.values(schemas)) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}

export const key = (world: World) => ({ 'x-api-key': world.apiKey });

/** A raw signed request to a service, built the way a partner would, so a test can then forge variations of it. */
export function signedEnvelope(
  secret: string,
  clock: Clock,
  type: string,
  data: object,
  eventId: string = crypto.randomUUID(),
) {
  const raw = JSON.stringify({ type, data });
  const timestamp = String(Math.floor(clock.now().getTime() / 1000));
  return {
    raw,
    headers: {
      'content-type': 'application/json',
      'x-parley-event-id': eventId,
      'x-parley-timestamp': timestamp,
      'x-parley-signature': sign(secret, eventId, timestamp, raw),
    },
    eventId,
    timestamp,
  };
}

export const PDF = Buffer.from('%PDF-1.4\n% a tiny fictional document\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
export const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082',
  'hex',
);

export const referralBody = (over: Record<string, unknown> = {}) => ({
  customer: { name: 'Ana Souza', email: 'ana.souza@example.com', taxId: '529.982.247-25' },
  consent: { statusBack: true },
  returnUrl: 'https://shop.example.com/orders/7',
  documents: [
    {
      kind: 'proof_of_address',
      filename: 'address.pdf',
      mime: 'application/pdf',
      contentBase64: PDF.toString('base64'),
    },
    { kind: 'id_photo', filename: 'id.png', mime: 'image/png', contentBase64: PNG.toString('base64') },
  ],
  ...over,
});

/** Creates a referral on the origin and hands it over, returning the ids both sides now share. */
export async function handedOver(world: World, body = referralBody()) {
  const created = await world.origin.built.app.inject({
    method: 'POST',
    url: '/v1/referrals',
    headers: key(world),
    payload: body,
  });
  const referralId = created.json<{ id: string }>().id;
  const res = await world.origin.built.app.inject({
    method: 'POST',
    url: `/v1/referrals/${referralId}/handoff`,
    headers: key(world),
  });
  if (res.statusCode !== 200) throw new Error(`handoff failed: ${res.statusCode} ${res.body}`);
  return { referralId, intakeId: res.json<{ intakeId: string }>().intakeId };
}

export const decide = (world: World, intakeId: string, decision: 'approved' | 'rejected') =>
  world.partner.built.app.inject({
    method: 'POST',
    url: `/v1/intakes/${intakeId}/decision`,
    headers: key(world),
    payload: { decision },
  });
