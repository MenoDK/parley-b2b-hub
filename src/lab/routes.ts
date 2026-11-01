import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { OffsetClock } from '../clock.js';
import { isDefaultApiKey } from '../config.js';
import type { AppContext } from '../context.js';
import { HttpError, apiKeyGuard } from '../lib/http.js';
import { refusalCounts } from '../lib/inbox.js';
import { Vault, VaultError, parseKeyRing } from '../lib/vault.js';

/**
 * Laboratory mode: makes the failure behaviour observable. It is refused when APP_ENV=production (config.ts), and the
 * routes only exist when the flag is on. It exposes this service's signing secrets and moves its clock; both are exactly
 * what must never exist on a real deployment, and exactly what a demonstration needs.
 */

const target = z.enum(['self', 'peer', 'both']).default('self');

export function registerLab(app: FastifyInstance, ctx: AppContext): void {
  const guard = apiKeyGuard(ctx.config.apiKey);
  const { pool, config } = ctx;
  const clock = ctx.clock instanceof OffsetClock ? ctx.clock : null;
  const originalRing = config.vaultKeys;

  /** Run a control locally, on the other company, or both. The other company is called with its own API key. */
  async function onTargets<T>(which: z.infer<typeof target>, path: string, body: object, local: () => Promise<T>) {
    const result: { self?: T; peer?: unknown } = {};
    if (which === 'self' || which === 'both') result.self = await local();
    if (which === 'peer' || which === 'both') {
      if (!config.peer || !config.peerApiKey)
        throw new HttpError(503, 'peer_not_configured', 'no peer or PEER_API_KEY is set');
      const response = await fetch(`${config.peer.url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': config.peerApiKey },
        body: JSON.stringify({ ...body, target: 'self' }),
        signal: AbortSignal.timeout(10_000),
      });
      result.peer = await response.json().catch(() => null);
    }
    return result;
  }

  app.get('/v1/lab/config', async () => ({
    lab: true,
    role: config.role,
    default_key_in_use: isDefaultApiKey(config.apiKey),
  }));

  app.get('/v1/lab/state', { preHandler: guard }, async () => {
    const q = async (sql: string) => (await pool.query(sql)).rows;
    const common = {
      outbox: await q(
        'SELECT id, type, status, attempts, next_attempt_at, last_error, created_at FROM outbox_events ORDER BY created_at DESC LIMIT 12',
      ),
      inbox: await q(
        'SELECT event_id, type, outcome, received_at FROM inbox_events ORDER BY received_at DESC LIMIT 12',
      ),
      consents: await q(
        'SELECT subject_id, purpose, granted_at, revoked_at FROM consents ORDER BY granted_at DESC LIMIT 12',
      ),
      audit: await q('SELECT id, at, kind, ref, detail FROM audit_log ORDER BY id DESC LIMIT 25'),
    };
    const table = config.role === 'origin' ? 'referrals' : 'intakes';
    const own = await pool.query<{ id: string; tax_id_enc: string }>(
      `SELECT id, tax_id_enc FROM ${table} ORDER BY created_at DESC LIMIT 12`,
    );
    const vaultRows = own.rows.map((row) => {
      let readable = true;
      try {
        ctx.vault.current.decrypt(row.tax_id_enc);
      } catch {
        readable = false;
      }
      return { id: row.id, tax_id_enc: row.tax_id_enc, version: ctx.vault.current.versionOf(row.tax_id_enc), readable };
    });
    const roleSpecific =
      config.role === 'origin'
        ? {
            referrals: await q(
              'SELECT id, customer_name, status, partner_intake_id, status_mismatches, created_at FROM referrals ORDER BY created_at DESC LIMIT 12',
            ),
            documents: await q(
              'SELECT id, referral_id, kind, filename, size, revoked_at FROM documents ORDER BY created_at DESC LIMIT 12',
            ),
            documentAccess: await q(
              'SELECT id, document_id, at, outcome FROM document_access ORDER BY id DESC LIMIT 15',
            ),
          }
        : {
            intakes: await q(
              'SELECT id, origin_ref, customer_name, status, continuation_used_at, continuation_expires_at, created_at FROM intakes ORDER BY created_at DESC LIMIT 12',
            ),
            intakeDocuments: await q(
              'SELECT intake_id, kind, filename, outcome, reason FROM intake_documents ORDER BY intake_id LIMIT 20',
            ),
          };
    return {
      role: config.role,
      clockOffsetSeconds: clock?.offsetSeconds ?? 0,
      now: ctx.clock.now(),
      outage: ctx.outage.mode,
      peerConfigured: ctx.peer !== null,
      // Exposed on purpose, and the reason this mode is refused in production: the lab signs events in the browser.
      secrets: { out: config.secretOut, in: config.secretsIn[0] ?? null },
      vault: { currentVersion: ctx.vault.current.currentVersion, rows: vaultRows },
      refusals: { ...refusalCounts },
      outboxSettings: { backoffBaseMs: config.outbox.backoffBaseMs, maxAttempts: config.outbox.maxAttempts },
      ...roleSpecific,
      ...common,
    };
  });

  app.get('/v1/lab/peer-state', { preHandler: guard }, async () => {
    if (!config.peer || !config.peerApiKey)
      throw new HttpError(503, 'peer_not_configured', 'no peer or PEER_API_KEY is set');
    const response = await fetch(`${config.peer.url}/v1/lab/state`, {
      headers: { 'x-api-key': config.peerApiKey },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new HttpError(502, 'peer_unreachable', 'the peer did not answer');
    return response.json();
  });

  app.post('/v1/lab/clock', { preHandler: guard }, async (request) => {
    const body = z
      .object({
        advanceSeconds: z
          .number()
          .min(0)
          .max(30 * 86_400),
        target,
      })
      .parse(request.body);
    return onTargets(body.target, '/v1/lab/clock', { advanceSeconds: body.advanceSeconds }, async () => {
      clock?.advance(body.advanceSeconds);
      return { clockOffsetSeconds: clock?.offsetSeconds ?? 0 };
    });
  });

  app.post('/v1/lab/outage', { preHandler: guard }, async (request) => {
    const body = z.object({ mode: z.enum(['none', 'down', 'not_deployed']), target }).parse(request.body);
    return onTargets(body.target, '/v1/lab/outage', { mode: body.mode }, async () => {
      ctx.outage.mode = body.mode;
      return { outage: ctx.outage.mode };
    });
  });

  app.post('/v1/lab/dispatch', { preHandler: guard }, async (request) => {
    const body = z.object({ target }).parse(request.body ?? {});
    return onTargets(body.target, '/v1/lab/dispatch', {}, () => ctx.outbox.deliverBatch());
  });

  /** Forwards exactly what the browser built, signature included or not, so every way of forging a request can be tried. */
  app.post('/v1/lab/send-to-peer', { preHandler: guard }, async (request) => {
    if (!config.peer) throw new HttpError(503, 'peer_not_configured', 'no peer is set');
    const body = z
      .object({
        raw: z.string().max(100_000),
        eventId: z.string().max(100).nullable(),
        timestamp: z.string().max(30).nullable(),
        signature: z.string().max(200).nullable(),
      })
      .parse(request.body);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (body.eventId) headers['x-parley-event-id'] = body.eventId;
    if (body.timestamp) headers['x-parley-timestamp'] = body.timestamp;
    if (body.signature) headers['x-parley-signature'] = body.signature;
    const response = await fetch(`${config.peer.url}/v1/events`, {
      method: 'POST',
      headers,
      body: body.raw,
      signal: AbortSignal.timeout(10_000),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  });

  app.post('/v1/lab/vault/new-key', { preHandler: guard }, async () => {
    ctx.vault.current = ctx.vault.current.withNewKey();
    return { currentVersion: ctx.vault.current.currentVersion, versions: ctx.vault.current.versions };
  });

  app.post('/v1/lab/vault/rotate', { preHandler: guard }, async () => {
    const table = config.role === 'origin' ? 'referrals' : 'intakes';
    const { rows } = await pool.query<{ id: string; tax_id_enc: string }>(`SELECT id, tax_id_enc FROM ${table}`);
    let rotated = 0;
    let unreadable = 0;
    for (const row of rows) {
      try {
        if (!ctx.vault.current.needsRotation(row.tax_id_enc)) continue;
        await pool.query(`UPDATE ${table} SET tax_id_enc = $2 WHERE id = $1`, [
          row.id,
          ctx.vault.current.rotate(row.tax_id_enc),
        ]);
        rotated += 1;
      } catch (error) {
        if (!(error instanceof VaultError)) throw error;
        unreadable += 1;
      }
    }
    return { rotated, unreadable };
  });

  /** Keeps only the current key: shows why rotation is a process (rows not yet rotated become unreadable). */
  app.post('/v1/lab/vault/drop-old-keys', { preHandler: guard }, async () => {
    ctx.vault.current = ctx.vault.current.retainOnlyCurrent();
    return { currentVersion: ctx.vault.current.currentVersion };
  });

  app.post('/v1/lab/find', { preHandler: guard }, async (request) => {
    const body = z.object({ taxId: z.string().min(3).max(30) }).parse(request.body);
    const table = config.role === 'origin' ? 'referrals' : 'intakes';
    const index = ctx.vault.current.blindIndex(body.taxId);
    const { rows } = await pool.query(`SELECT id FROM ${table} WHERE tax_id_blind = $1`, [index]);
    return { blindIndex: index, matches: rows.map((r: { id: string }) => r.id) };
  });

  app.post('/v1/lab/consent/revoke', { preHandler: guard }, async (request) => {
    const body = z.object({ subjectId: z.string().min(1).max(100), target }).parse(request.body);
    return onTargets(body.target, '/v1/lab/consent/revoke', { subjectId: body.subjectId }, async () => {
      const { rowCount } = await pool.query(
        'UPDATE consents SET revoked_at = $2 WHERE subject_id = $1 AND revoked_at IS NULL',
        [body.subjectId, ctx.clock.now()],
      );
      return { revoked: (rowCount ?? 0) > 0 };
    });
  });

  /**
   * The page can only talk to the service that served it (strict CSP), so the partner's own management actions are
   * reached through here. The decision goes through the partner's real route, so the lab cannot behave differently
   * from the product: same validation, same transaction, same queued event.
   */
  app.post('/v1/lab/decide', { preHandler: guard }, async (request) => {
    const body = z
      .object({ intakeId: z.string().uuid(), decision: z.enum(['approved', 'rejected']), target })
      .parse(request.body);
    return onTargets(body.target, '/v1/lab/decide', { intakeId: body.intakeId, decision: body.decision }, async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/intakes/${body.intakeId}/decision`,
        headers: { 'x-api-key': config.apiKey },
        payload: { decision: body.decision },
      });
      return { status: response.statusCode, body: response.json() as unknown };
    });
  });

  /** "The person clicks the link", done server-side because the page may not call another origin. Only the peer, only this path. */
  app.post('/v1/lab/follow', { preHandler: guard }, async (request) => {
    if (!config.peer) throw new HttpError(503, 'peer_not_configured', 'no peer is set');
    const { path } = z.object({ path: z.string().regex(/^\/v1\/continue\/[A-Za-z0-9_-]{1,100}$/) }).parse(request.body);
    const response = await fetch(`${config.peer.url}${path}`, { signal: AbortSignal.timeout(5000), redirect: 'error' });
    return { status: response.status, body: await response.json().catch(() => null) };
  });

  app.post('/v1/lab/reset', { preHandler: guard }, async (request) => {
    const body = z.object({ target }).parse(request.body ?? {});
    return onTargets(body.target, '/v1/lab/reset', {}, async () => {
      const tables =
        config.role === 'origin' ? 'document_access, documents, referrals, ' : 'intake_documents, intakes, ';
      await pool.query(`TRUNCATE ${tables} inbox_events, outbox_events, consents, audit_log`);
      clock?.reset();
      ctx.outage.mode = 'none';
      ctx.vault.current = new Vault(parseKeyRing(originalRing), config.blindIndexKey);
      for (const key of Object.keys(refusalCounts) as (keyof typeof refusalCounts)[]) refusalCounts[key] = 0;
      return { reset: true };
    });
  });
}
