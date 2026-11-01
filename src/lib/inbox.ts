import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { type Clock, toEpochSeconds } from '../clock.js';
import type { Client, Pool } from '../db.js';
import { transaction } from '../db.js';
import { audit } from './audit.js';
import { HttpError, errorBody } from './http.js';
import { HEADERS, type Refusal, verify } from './signing.js';

/** A deterministic refusal of the content (a validation failure): answered 422 and never retried by a sender. */
export class Rejection extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface EventContext {
  tx: Client;
  eventId: string;
  data: Record<string, unknown>;
  now: Date;
}

export type EventHandler = (context: EventContext) => Promise<Record<string, unknown>>;

export interface InboxDeps {
  pool: Pool;
  clock: Clock;
  peerName: string;
  secrets: () => readonly string[];
  handlers: Readonly<Record<string, EventHandler>>;
}

const envelope = z.object({ type: z.string().min(1).max(100), data: z.record(z.unknown()) });

/** Counters by refusal reason. The caller sees one generic 401; the reasons live here, where an operator can read them. */
export const refusalCounts: Record<Refusal | 'replayed', number> = {
  malformed: 0,
  bad_signature: 0,
  outside_window: 0,
  replayed: 0,
};

const unauthorized = (reply: FastifyReply, reason: Refusal) => {
  refusalCounts[reason] += 1;
  // One message for every reason: telling a forger which check failed tells them which one to defeat.
  return reply.status(401).send(errorBody('unauthorized', 'invalid signature'));
};

/** Verifies the signed envelope of a request, answering 401 itself when it is not valid. */
export function verifiedOr401(
  deps: Pick<InboxDeps, 'clock' | 'secrets'>,
  request: FastifyRequest,
  reply: FastifyReply,
): string | null {
  const header = (name: string) =>
    typeof request.headers[name] === 'string' ? (request.headers[name] as string) : undefined;
  const verdict = verify({
    secrets: deps.secrets(),
    eventId: header(HEADERS.eventId),
    timestamp: header(HEADERS.timestamp),
    signature: header(HEADERS.signature),
    rawBody: request.rawBody ?? '',
    nowSeconds: toEpochSeconds(deps.clock.now()),
  });
  if (!verdict.ok) {
    unauthorized(reply, verdict.reason);
    return null;
  }
  return header(HEADERS.eventId) ?? null;
}

/**
 * Claims an event id for good. The first caller wins; every other is a duplicate. One INSERT does the check and the set,
 * so there is no gap between "have I seen it?" and "now I have" for two concurrent deliveries to slip through.
 */
async function claim(tx: Client, peer: string, eventId: string, type: string, now: Date): Promise<boolean> {
  const { rowCount } = await tx.query(
    `INSERT INTO inbox_events (peer, event_id, type, outcome, received_at) VALUES ($1, $2, $3, 'accepted', $4)
     ON CONFLICT (peer, event_id) DO NOTHING`,
    [peer, eventId, type, now],
  );
  return (rowCount ?? 0) === 1;
}

export function registerInbox(app: FastifyInstance, deps: InboxDeps): void {
  app.post('/v1/events', async (request, reply) => {
    const eventId = verifiedOr401(deps, request, reply);
    if (!eventId) return reply;

    const parsed = envelope.safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, 'bad_envelope', 'expected {"type": string, "data": object}');
    const { type, data } = parsed.data;
    const handler = deps.handlers[type];
    // Signed but unknown: refuse without claiming the id, so the same id can be used once the type exists.
    if (!handler) throw new HttpError(422, 'unsupported_event_type', `this service does not handle "${type}"`);

    const now = deps.clock.now();
    let outcome: { status: number; body: unknown };
    try {
      outcome = await transaction(deps.pool, async (tx) => {
        if (!(await claim(tx, deps.peerName, eventId, type, now))) {
          await audit(tx, deps.clock, 'inbox.duplicate', eventId, { type });
          return { status: 200, body: { status: 'duplicate' } };
        }
        // The handler runs inside a savepoint: if it refuses the content, its writes are undone but the claim stays, so a
        // sender that retries a deterministic rejection gets the same answer instead of a second attempt.
        await tx.query('SAVEPOINT handler');
        try {
          const result = await handler({ tx, eventId, data, now });
          await audit(tx, deps.clock, 'inbox.accepted', eventId, { type });
          return { status: 200, body: { status: 'accepted', result } };
        } catch (error) {
          if (!(error instanceof Rejection)) throw error; // transient: the whole transaction rolls back, the retry reprocesses
          await tx.query('ROLLBACK TO SAVEPOINT handler');
          await tx.query(`UPDATE inbox_events SET outcome = 'rejected' WHERE peer = $1 AND event_id = $2`, [
            deps.peerName,
            eventId,
          ]);
          await audit(tx, deps.clock, 'inbox.rejected', eventId, { type, code: error.code });
          return { status: 422, body: errorBody(error.code, error.message) };
        }
      });
    } catch (error) {
      request.log.error({ err: error, type }, 'event handler failed');
      throw new HttpError(500, 'internal', 'something went wrong on our side');
    }
    // Answered only after COMMIT: a sender must never be told "accepted" about something that was then rolled back.
    return reply.status(outcome.status).send(outcome.body);
  });
}

/** For signed reads (no body): the signature and the one-time id are checked, nothing is stored beyond the id. */
export async function verifiedRead(
  deps: Pick<InboxDeps, 'clock' | 'secrets' | 'pool' | 'peerName'>,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  const eventId = verifiedOr401(deps, request, reply);
  if (!eventId) return false;
  const fresh = await transaction(deps.pool, (tx) => claim(tx, deps.peerName, eventId, 'read', deps.clock.now()));
  if (!fresh) {
    refusalCounts.replayed += 1;
    await reply.status(409).send(errorBody('replayed', 'this request id was already used'));
    return false;
  }
  return true;
}
