import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { toEpochSeconds } from '../clock.js';
import type { AppContext } from '../context.js';
import { transaction } from '../db.js';
import { audit } from '../lib/audit.js';
import { checkDocumentLink, signDocumentLink } from '../lib/document-links.js';
import { HttpError, apiKeyGuard, errorBody } from '../lib/http.js';
import { type EventHandler, Rejection } from '../lib/inbox.js';
import { signedRequest } from '../lib/peer.js';
import { allowedReturnUrl } from '../lib/return-url.js';
import { VaultError } from '../lib/vault.js';

const MAX_DOCUMENTS = 5;

const createReferral = z.object({
  customer: z.object({
    name: z.string().trim().min(1).max(200),
    email: z.string().trim().email().max(200),
    taxId: z.string().trim().min(5).max(30),
  }),
  returnUrl: z.string().max(500).optional(),
  consent: z.object({ statusBack: z.boolean() }),
  documents: z
    .array(
      z.object({
        kind: z.string().trim().min(1).max(40),
        filename: z.string().trim().min(1).max(200),
        mime: z.string().trim().min(1).max(100),
        contentBase64: z.string().min(1),
      }),
    )
    .max(MAX_DOCUMENTS)
    .default([]),
});

/** A tax id is shown masked everywhere: enough to recognise a row, never enough to use it. */
export const maskTaxId = (plain: string): string => `${'•'.repeat(Math.max(0, plain.length - 2))}${plain.slice(-2)}`;

interface ReferralRow {
  id: string;
  customer_name: string;
  customer_email: string;
  tax_id_enc: string;
  return_url: string | null;
  status_back_consent: boolean;
  status: string;
  partner_intake_id: string | null;
  status_mismatches: number;
  created_at: Date;
}

export function registerOrigin(app: FastifyInstance, ctx: AppContext): void {
  const guard = apiKeyGuard(ctx.config.apiKey);
  const { pool, clock, vault, config } = ctx;

  /** A row whose key is gone must not take the whole list down with it: show that it is unreadable, and say why. */
  const readableMask = (token: string): string => {
    try {
      return maskTaxId(vault.current.decrypt(token));
    } catch (error) {
      if (error instanceof VaultError) return '(unreadable: key not available)';
      throw error;
    }
  };

  const present = (row: ReferralRow) => ({
    id: row.id,
    customer: {
      name: row.customer_name,
      email: row.customer_email,
      taxId: readableMask(row.tax_id_enc),
    },
    status: row.status,
    partnerIntakeId: row.partner_intake_id,
    statusMismatches: row.status_mismatches,
    createdAt: row.created_at,
  });

  app.post('/v1/referrals', { preHandler: guard }, async (request, reply) => {
    const parsed = createReferral.safeParse(request.body);
    if (!parsed.success)
      throw new HttpError(400, 'invalid_request', parsed.error.issues.map((i) => i.path.join('.')).join(', '));
    const input = parsed.data;

    const documents = input.documents.map((doc) => {
      if (!config.allowedMime.includes(doc.mime))
        throw new HttpError(422, 'mime_not_allowed', `${doc.mime} is not accepted`);
      const content = Buffer.from(doc.contentBase64, 'base64');
      if (content.length === 0 || content.length > config.maxDocumentBytes) {
        throw new HttpError(422, 'document_size', `a document must be between 1 and ${config.maxDocumentBytes} bytes`);
      }
      return { ...doc, content, sha256: createHash('sha256').update(content).digest('hex') };
    });

    const id = randomUUID();
    const now = clock.now();
    await transaction(pool, async (tx) => {
      await tx.query(
        `INSERT INTO referrals (id, customer_name, customer_email, tax_id_enc, tax_id_blind, return_url, status_back_consent, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          id,
          input.customer.name,
          input.customer.email,
          vault.current.encrypt(input.customer.taxId),
          vault.current.blindIndex(input.customer.taxId),
          input.returnUrl ?? null,
          input.consent.statusBack,
          now,
        ],
      );
      for (const doc of documents) {
        await tx.query(
          `INSERT INTO documents (id, referral_id, kind, filename, mime, size, sha256, content, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [randomUUID(), id, doc.kind, doc.filename, doc.mime, doc.content.length, doc.sha256, doc.content, now],
        );
      }
      await audit(tx, clock, 'referral.created', id, { documents: documents.length });
    });
    return reply.status(201).send({ id, status: 'draft' });
  });

  app.get('/v1/referrals', { preHandler: guard }, async () => {
    const { rows } = await pool.query<ReferralRow>('SELECT * FROM referrals ORDER BY created_at DESC LIMIT 50');
    return rows.map(present);
  });

  app.get<{ Params: { id: string } }>('/v1/referrals/:id', { preHandler: guard }, async (request) => {
    const { rows } = await pool.query<ReferralRow>('SELECT * FROM referrals WHERE id = $1', [request.params.id]);
    const row = rows[0];
    if (!row) throw new HttpError(404, 'not_found', 'no such referral');
    const docs = await pool.query(
      'SELECT id, kind, filename, mime, size, sha256, revoked_at FROM documents WHERE referral_id = $1 ORDER BY created_at',
      [row.id],
    );
    return { ...present(row), documents: docs.rows };
  });

  /**
   * The hand-over. Two signed calls, deliberately separate:
   *   1. `referral.created`, idempotent: the event id IS the referral id, so a double click, a retry or a page reload
   *      cannot create a second record at the partner.
   *   2. `intake.continuation`, a fresh event id every time, which asks the partner to mint a new single-use link.
   * Minting the link in step 1 would make a replayed capture of step 1 hand its sender a working link; here a
   * duplicate step 1 returns nothing but the fact that it was a duplicate.
   */
  app.post<{ Params: { id: string } }>('/v1/referrals/:id/handoff', { preHandler: guard }, async (request) => {
    if (!ctx.peer)
      throw new HttpError(503, 'peer_not_configured', 'PEER_URL is not set, so there is nobody to hand over to');
    const { rows } = await pool.query<ReferralRow>('SELECT * FROM referrals WHERE id = $1', [request.params.id]);
    const referral = rows[0];
    if (!referral) throw new HttpError(404, 'not_found', 'no such referral');
    const docs = await pool.query<{
      id: string;
      kind: string;
      filename: string;
      mime: string;
      size: number;
      sha256: string;
    }>(
      'SELECT id, kind, filename, mime, size, sha256 FROM documents WHERE referral_id = $1 AND revoked_at IS NULL ORDER BY created_at, kind',
      [referral.id],
    );
    const nowSeconds = toEpochSeconds(clock.now());
    const manifest = docs.rows.map((doc) => ({
      kind: doc.kind,
      filename: doc.filename,
      mime: doc.mime,
      size: doc.size,
      sha256: doc.sha256,
      url: `${config.serviceUrl}/v1/documents/${signDocumentLink({ documentId: doc.id, secret: config.secretOut, nowSeconds })}`,
    }));
    let taxId: string;
    try {
      taxId = vault.current.decrypt(referral.tax_id_enc);
    } catch (error) {
      if (!(error instanceof VaultError)) throw error;
      throw new HttpError(409, 'unreadable_record', 'the stored tax id cannot be decrypted with the keys available');
    }
    const returnUrl = allowedReturnUrl(referral.return_url, config.allowedReturnOrigins, {
      allowLoopbackHttp: config.appEnv !== 'production',
    });

    const created = await signedRequest(ctx.peer, clock, {
      method: 'POST',
      path: '/v1/events',
      eventId: referral.id,
      timeoutMs: config.handoffTimeoutMs,
      body: {
        type: 'referral.created',
        data: {
          origin_ref: referral.id,
          customer: { name: referral.customer_name, email: referral.customer_email, taxId },
          return_url: returnUrl,
          consents: { status_back: referral.status_back_consent },
          documents: manifest,
        },
      },
    }).catch((error: unknown) => {
      // Do not tell the caller anything about the partner's internals; the audit log has the class of failure.
      void audit(pool, clock, 'handoff.failed', referral.id, { reason: error instanceof Error ? error.name : 'error' });
      throw new HttpError(502, 'partner_unreachable', 'the partner did not answer in time; retrying is safe');
    });
    if (created.status < 200 || created.status >= 300) {
      await audit(pool, clock, 'handoff.failed', referral.id, { http: created.status });
      throw new HttpError(502, 'partner_refused', `the partner answered ${created.status}; retrying is safe`);
    }
    const createdBody = created.body as { status: string; result?: { intake_id: string; documents: unknown[] } };

    const continuation = await signedRequest(ctx.peer, clock, {
      method: 'POST',
      path: '/v1/events',
      timeoutMs: config.handoffTimeoutMs,
      body: { type: 'intake.continuation', data: { origin_ref: referral.id } },
    });
    const link = (continuation.body as { result?: { continuation_url?: string; intake_id?: string } } | null)?.result;
    if (continuation.status !== 200 || !link?.continuation_url) {
      throw new HttpError(502, 'partner_refused', 'the partner could not issue a continuation link; retrying is safe');
    }
    const intakeId = createdBody.result?.intake_id ?? link.intake_id ?? null;
    await pool.query(
      `UPDATE referrals SET status = CASE WHEN status = 'draft' THEN 'handed_over' ELSE status END, partner_intake_id = COALESCE($2, partner_intake_id) WHERE id = $1`,
      [referral.id, intakeId],
    );
    await audit(pool, clock, 'handoff.done', referral.id, { duplicate: createdBody.status === 'duplicate' });
    return {
      intakeId,
      duplicate: createdBody.status === 'duplicate',
      documents: createdBody.result?.documents ?? [],
      continuationUrl: link.continuation_url,
    };
  });

  /** Public. The caller is the other company's server, holding a signed link; there is no session to check. */
  app.get<{ Params: { token: string } }>('/v1/documents/:token', async (request, reply) => {
    const verdict = checkDocumentLink({
      token: request.params.token,
      secret: config.secretOut,
      nowSeconds: toEpochSeconds(clock.now()),
    });
    const documentId = verdict.ok ? verdict.documentId : (request.params.token.split('.')[0] ?? 'unknown');
    const log = (outcome: string) =>
      pool.query('INSERT INTO document_access (document_id, at, outcome) VALUES ($1, $2, $3)', [
        documentId.slice(0, 64),
        clock.now(),
        outcome,
      ]);
    // Every refusal gets the same answer. The reason goes to the access log, where an operator can read it.
    const refuse = async (outcome: string) => {
      await log(outcome);
      return reply.status(403).send(errorBody('forbidden', 'this link is not valid'));
    };
    if (!verdict.ok) return refuse(verdict.reason);
    const { rows } = await pool.query<{ mime: string; filename: string; content: Buffer; revoked_at: Date | null }>(
      'SELECT mime, filename, content, revoked_at FROM documents WHERE id = $1',
      [documentId],
    );
    const doc = rows[0];
    if (!doc) return refuse('no_such_document');
    if (doc.revoked_at) return refuse('revoked');
    await log('served');
    return reply
      .header('content-type', doc.mime)
      .header('content-disposition', `attachment; filename="${doc.filename.replace(/[^\w.\- ]/g, '_')}"`)
      .header('cache-control', 'no-store')
      .send(doc.content);
  });

  app.post<{ Params: { id: string } }>('/v1/documents/:id/revoke', { preHandler: guard }, async (request) => {
    const { rowCount } = await pool.query('UPDATE documents SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL', [
      request.params.id,
      clock.now(),
    ]);
    if (!rowCount) throw new HttpError(404, 'not_found', 'no such open document');
    await audit(pool, clock, 'document.revoked', request.params.id);
    return { revoked: true };
  });
}

const decided = z.object({
  origin_ref: z.string().uuid(),
  intake_id: z.string().uuid(),
  status_hint: z.enum(['approved', 'rejected']),
});

/**
 * "The webhook is never the truth." A signed event proves who sent it, not that what it says is right: a bug or a
 * compromised partner can sign a lie. So the event is treated as a *hint*; the state we apply is the one we read back
 * from the partner over a signed request of our own. When the two differ we apply what we read and count the mismatch.
 */
export function originHandlers(ctx: AppContext): Record<string, EventHandler> {
  return {
    'intake.decided': async ({ tx, data, now }) => {
      const parsed = decided.safeParse(data);
      if (!parsed.success) throw new Rejection('invalid_payload', 'expected origin_ref, intake_id and status_hint');
      const { origin_ref, intake_id, status_hint } = parsed.data;
      const { rows } = await tx.query<{ status: string }>(
        'SELECT status FROM referrals WHERE id = $1 AND partner_intake_id = $2 FOR UPDATE',
        [origin_ref, intake_id],
      );
      if (!rows[0]) throw new Rejection('unknown_referral', 'no referral matches that intake');
      if (!ctx.peer) throw new Error('no peer configured to confirm the status with'); // transient: the sender retries

      // A failure to reach the partner is NOT a rejection: it throws, the transaction rolls back and the sender retries.
      const confirmation = await signedRequest(ctx.peer, ctx.clock, {
        method: 'GET',
        path: `/v1/peer/intakes/${intake_id}/status`,
        timeoutMs: 5000,
      });
      if (confirmation.status === 404) throw new Rejection('unknown_intake', 'the partner does not know that intake');
      const truth = (confirmation.body as { status?: string } | null)?.status;
      if (confirmation.status !== 200 || (truth !== 'pending' && truth !== 'approved' && truth !== 'rejected')) {
        throw new Error(`could not confirm the status (${confirmation.status})`);
      }
      const mismatch = truth !== status_hint;
      await tx.query('UPDATE referrals SET status = $2, status_mismatches = status_mismatches + $3 WHERE id = $1', [
        origin_ref,
        truth,
        mismatch ? 1 : 0,
      ]);
      await audit(tx, { now: () => now }, mismatch ? 'status.mismatch' : 'status.confirmed', origin_ref, {
        hint: status_hint,
        truth,
      });
      return { applied: truth, hint: status_hint, mismatch };
    },
  };
}
