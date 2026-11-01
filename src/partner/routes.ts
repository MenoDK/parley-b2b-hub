import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { transaction } from '../db.js';
import { audit } from '../lib/audit.js';
import { grantConsent, revokeConsent } from '../lib/consent.js';
import { HttpError, apiKeyGuard, errorBody } from '../lib/http.js';
import { type EventHandler, Rejection, verifiedRead } from '../lib/inbox.js';
import { allowedReturnUrl } from '../lib/return-url.js';

const CONTINUATION_LIFETIME_SECONDS = 900;

const manifestItem = z.object({
  kind: z.string().min(1).max(40),
  filename: z.string().min(1).max(200),
  mime: z.string().min(1).max(100),
  size: z.number().int().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  url: z.string().url(),
});

const referralCreated = z.object({
  origin_ref: z.string().uuid(),
  customer: z.object({
    name: z.string().min(1).max(200),
    email: z.string().email().max(200),
    taxId: z.string().min(5).max(30),
  }),
  return_url: z.string().max(500).nullable(),
  consents: z.object({ status_back: z.boolean() }),
  documents: z.array(manifestItem).max(5),
});

type DocumentOutcome = { kind: string; outcome: 'stored' | 'rejected'; reason?: string };

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

/**
 * Pulls one document from the origin and validates it where it lands. Every check is on OUR side of the wire: the
 * manifest is a claim, the bytes are the evidence.
 *  - The URL must be on the origin we already trust. Fetching whatever URL arrives in a payload is server-side request
 *    forgery: a signed event could aim this service at an internal address.
 *  - Size is enforced while reading, not after, so a lying content-length cannot make us buffer a gigabyte.
 *  - The hash must match the manifest, so a document swapped in transit (or on the origin) is noticed.
 */
async function fetchDocument(ctx: AppContext, item: z.infer<typeof manifestItem>, deadlineMs: number) {
  const { config } = ctx;
  if (!config.allowedMime.includes(item.mime)) return { reject: 'mime_not_allowed' } as const;
  if (item.size > config.maxDocumentBytes) return { reject: 'too_large' } as const;
  if (!ctx.peer || new URL(item.url).origin !== new URL(ctx.peer.url).origin)
    return { reject: 'url_not_allowed' } as const;
  const budget = deadlineMs - Date.now();
  if (budget <= 0) return { reject: 'budget_exceeded' } as const;
  try {
    const response = await fetch(item.url, {
      signal: AbortSignal.timeout(Math.min(config.docFetchTimeoutMs, budget)),
      redirect: 'error',
    });
    if (response.status !== 200) return { reject: `origin_answered_${response.status}` } as const;
    const type = (response.headers.get('content-type') ?? '').split(';')[0]?.trim();
    if (type !== item.mime) return { reject: 'mime_mismatch' } as const;
    const reader = response.body?.getReader();
    if (!reader) return { reject: 'empty' } as const;
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > config.maxDocumentBytes) {
        await reader.cancel();
        return { reject: 'too_large' } as const;
      }
      chunks.push(Buffer.from(value));
    }
    const content = Buffer.concat(chunks);
    if (sha256(content) !== item.sha256) return { reject: 'hash_mismatch' } as const;
    return { content } as const;
  } catch {
    return { reject: 'fetch_failed' } as const;
  }
}

export function registerPartner(app: FastifyInstance, ctx: AppContext): void {
  const guard = apiKeyGuard(ctx.config.apiKey);
  const { pool, clock, vault, config } = ctx;
  const readDeps = { clock, pool, peerName: config.peer?.name ?? 'peer', secrets: () => config.secretsIn };

  /** Public. A person arrives here with a link. Used or expired, it is the same answer, so a guess learns nothing. */
  app.get<{ Params: { token: string } }>('/v1/continue/:token', async (request, reply) => {
    const now = clock.now();
    const { rows } = await pool.query<{ id: string; customer_name: string; return_url: string | null; status: string }>(
      `UPDATE intakes SET continuation_used_at = $2
        WHERE continuation_hash = $1 AND continuation_used_at IS NULL AND continuation_expires_at > $2
       RETURNING id, customer_name, return_url, status`,
      [sha256(request.params.token), now],
    );
    const intake = rows[0];
    if (!intake) {
      await audit(pool, clock, 'continuation.refused', null);
      return reply.status(410).send(errorBody('gone', 'this link was already used or has expired'));
    }
    await audit(pool, clock, 'continuation.used', intake.id);
    const docs = await pool.query(
      'SELECT kind, outcome, reason FROM intake_documents WHERE intake_id = $1 ORDER BY kind',
      [intake.id],
    );
    return {
      intakeId: intake.id,
      customerName: intake.customer_name,
      status: intake.status,
      returnUrl: intake.return_url,
      documents: docs.rows,
    };
  });

  /** The origin reads the truth here instead of trusting what an event claims. Signed, and each request id works once. */
  app.get<{ Params: { id: string } }>('/v1/peer/intakes/:id/status', async (request, reply) => {
    if (!(await verifiedRead(readDeps, request, reply))) return reply;
    const { rows } = await pool.query<{ id: string; origin_ref: string; status: string }>(
      'SELECT id, origin_ref, status FROM intakes WHERE id::text = $1',
      [request.params.id],
    );
    const intake = rows[0];
    if (!intake) return reply.status(404).send(errorBody('not_found', 'no such intake'));
    return { intake_id: intake.id, origin_ref: intake.origin_ref, status: intake.status };
  });

  interface IntakeRow {
    id: string;
    origin_ref: string;
    customer_name: string;
    customer_email: string;
    tax_id_enc: string;
    status: string;
    created_at: Date;
  }
  const present = (row: IntakeRow) => ({
    id: row.id,
    originRef: row.origin_ref,
    customer: { name: row.customer_name, email: row.customer_email, taxId: maskedTaxId(row.tax_id_enc) },
    status: row.status,
    createdAt: row.created_at,
  });
  const maskedTaxId = (token: string): string => {
    try {
      const plain = vault.current.decrypt(token);
      return `${'•'.repeat(Math.max(0, plain.length - 2))}${plain.slice(-2)}`;
    } catch {
      return '(unreadable: key not available)';
    }
  };

  app.get('/v1/intakes', { preHandler: guard }, async () => {
    const { rows } = await pool.query<IntakeRow>('SELECT * FROM intakes ORDER BY created_at DESC LIMIT 50');
    return rows.map(present);
  });

  app.post<{ Params: { id: string } }>('/v1/intakes/:id/decision', { preHandler: guard }, async (request) => {
    const body = z.object({ decision: z.enum(['approved', 'rejected']) }).safeParse(request.body);
    if (!body.success) throw new HttpError(400, 'invalid_request', 'decision must be approved or rejected');
    if (!ctx.peer) throw new HttpError(503, 'peer_not_configured', 'there is nobody to notify');
    const peerName = ctx.peer.name;
    const outcome = await transaction(pool, async (tx) => {
      const { rows } = await tx.query<{ origin_ref: string; status: string }>(
        'SELECT origin_ref, status FROM intakes WHERE id::text = $1 FOR UPDATE',
        [request.params.id],
      );
      const intake = rows[0];
      if (!intake) throw new HttpError(404, 'not_found', 'no such intake');
      if (intake.status !== 'pending')
        throw new HttpError(409, 'already_decided', `this intake is already ${intake.status}`);
      await tx.query('UPDATE intakes SET status = $2 WHERE id::text = $1', [request.params.id, body.data.decision]);
      // The event is queued in the SAME transaction as the decision: either both exist or neither does.
      const eventId = await ctx.outbox.enqueue(tx, {
        peer: peerName,
        type: 'intake.decided',
        subjectId: request.params.id,
        payload: { origin_ref: intake.origin_ref, intake_id: request.params.id, status_hint: body.data.decision },
      });
      await audit(tx, clock, 'intake.decided', request.params.id, { decision: body.data.decision, event: eventId });
      return { status: body.data.decision, eventId };
    });
    return outcome;
  });

  app.post<{ Params: { id: string } }>(
    '/v1/intakes/:id/consents/status_back/revoke',
    { preHandler: guard },
    async (request) => {
      const revoked = await revokeConsent(pool, clock, request.params.id, 'status_back');
      await audit(pool, clock, 'consent.revoked', request.params.id, { purpose: 'status_back', changed: revoked });
      return { revoked };
    },
  );
}

export function partnerHandlers(ctx: AppContext): Record<string, EventHandler> {
  const { config, clock } = ctx;
  return {
    'referral.created': async ({ tx, data, now }) => {
      const parsed = referralCreated.safeParse(data);
      if (!parsed.success) throw new Rejection('invalid_payload', 'the referral does not match the contract');
      const referral = parsed.data;

      const existing = await tx.query<{ id: string }>('SELECT id FROM intakes WHERE origin_ref = $1', [
        referral.origin_ref,
      ]);
      if (existing.rows[0]) return { intake_id: existing.rows[0].id, created: false, documents: [] };

      const intakeId = randomUUID();
      const returnUrl = allowedReturnUrl(referral.return_url, config.allowedReturnOrigins, {
        allowLoopbackHttp: config.appEnv !== 'production',
      });
      await tx.query(
        `INSERT INTO intakes (id, origin_ref, customer_name, customer_email, tax_id_enc, tax_id_blind, return_url, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          intakeId,
          referral.origin_ref,
          referral.customer.name,
          referral.customer.email,
          ctx.vault.current.encrypt(referral.customer.taxId),
          ctx.vault.current.blindIndex(referral.customer.taxId),
          returnUrl,
          now,
        ],
      );
      if (referral.consents.status_back) await grantConsent(tx, clock, intakeId, 'status_back');

      // Documents are fetched one after another inside one overall budget, which is shorter than what the origin waits.
      const deadline = Date.now() + config.docFetchBudgetMs;
      const outcomes: DocumentOutcome[] = [];
      for (const item of referral.documents) {
        const fetched = await fetchDocument(ctx, item, deadline);
        if ('reject' in fetched) {
          await tx.query(
            `INSERT INTO intake_documents (id, intake_id, kind, filename, outcome, reason) VALUES ($1, $2, $3, $4, 'rejected', $5)`,
            [randomUUID(), intakeId, item.kind, item.filename, fetched.reject],
          );
          outcomes.push({ kind: item.kind, outcome: 'rejected', reason: fetched.reject });
        } else {
          await tx.query(
            `INSERT INTO intake_documents (id, intake_id, kind, filename, mime, size, sha256, content, outcome) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'stored')`,
            [
              randomUUID(),
              intakeId,
              item.kind,
              item.filename,
              item.mime,
              fetched.content.length,
              item.sha256,
              fetched.content,
            ],
          );
          outcomes.push({ kind: item.kind, outcome: 'stored' });
        }
      }
      await audit(tx, clock, 'intake.created', intakeId, { documents: outcomes.map((o) => o.outcome) });
      return { intake_id: intakeId, created: true, documents: outcomes };
    },

    'intake.continuation': async ({ tx, data, now }) => {
      const parsed = z.object({ origin_ref: z.string().uuid() }).safeParse(data);
      if (!parsed.success) throw new Rejection('invalid_payload', 'expected origin_ref');
      const token = randomBytes(32).toString('base64url');
      // Only the hash is stored. Replacing it invalidates the previous link: the latest one wins.
      const { rows } = await tx.query<{ id: string }>(
        `UPDATE intakes SET continuation_hash = $2, continuation_expires_at = $3, continuation_used_at = NULL
          WHERE origin_ref = $1 RETURNING id`,
        [parsed.data.origin_ref, sha256(token), new Date(now.getTime() + CONTINUATION_LIFETIME_SECONDS * 1000)],
      );
      if (!rows[0]) throw new Rejection('unknown_intake', 'no intake for that referral');
      return { intake_id: rows[0].id, continuation_url: `${config.publicUrl}/v1/continue/${token}` };
    },
  };
}
