import { randomUUID } from 'node:crypto';
import type { Clock } from '../clock.js';
import type { Pool, Queryable } from '../db.js';
import { consentStillHolds } from './consent.js';
import { type Fetch, type Peer, signedRequest } from './peer.js';

export interface OutboxSettings {
  backoffBaseMs: number;
  backoffCapMs: number;
  maxAttempts: number;
  batchSize: number;
  leaseMs: number;
  sendTimeoutMs: number;
}

/**
 * Statuses worth retrying. 4xx normally means "our request is wrong and insisting will not fix it" (bad body, bad
 * signature), with one exception that was added after a measurement: 404 has two causes the response cannot tell apart,
 * a wrong path (permanent) and a route the partner has not deployed yet (temporary), and a deploy in progress answers 404
 * for a few seconds every week. Retrying costs six attempts with backoff; not retrying costs the event.
 */
export const RETRYABLE_STATUS: ReadonlySet<number> = new Set([404, 408, 429, 500, 502, 503, 504]);

/** 1, 2, 4, 8, … times the base, capped. It grows fast on purpose: insisting every minute does not bring a partner back. */
export function backoffMs(attempt: number, baseMs: number, capMs: number): number {
  return Math.min(baseMs * 2 ** Math.max(0, attempt - 1), capMs);
}

export type Delivery = 'delivered' | 'rescheduled' | 'failed' | 'cancelled';

export interface BatchResult {
  claimed: number;
  delivered: number;
  rescheduled: number;
  failed: number;
  /** Counted apart from `failed` on purpose: delivery failures are investigated, withdrawn consent is respected. */
  cancelled: number;
  configured: boolean;
}

interface Claimed {
  id: string;
  type: string;
  payload: object;
  attempts: number;
  subject_id: string | null;
}

export class Outbox {
  readonly #pool: Pool;
  readonly #clock: Clock;
  readonly #settings: OutboxSettings;
  readonly #peer: Peer | null;
  readonly #fetch: Fetch | undefined;

  constructor(deps: { pool: Pool; clock: Clock; settings: OutboxSettings; peer: Peer | null; fetchImpl?: Fetch }) {
    this.#pool = deps.pool;
    this.#clock = deps.clock;
    this.#settings = deps.settings;
    this.#peer = deps.peer;
    this.#fetch = deps.fetchImpl;
  }

  /** Pass the caller's transaction so the event exists if and only if the business change does. */
  async enqueue(
    db: Queryable,
    event: { type: string; payload: object; subjectId?: string; peer: string },
  ): Promise<string> {
    const id = randomUUID();
    await db.query(
      'INSERT INTO outbox_events (id, peer, type, payload, subject_id, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [id, event.peer, event.type, JSON.stringify(event.payload), event.subjectId ?? null, this.#clock.now()],
    );
    return id;
  }

  async deliverBatch(limit = this.#settings.batchSize): Promise<BatchResult> {
    const result: BatchResult = { claimed: 0, delivered: 0, rescheduled: 0, failed: 0, cancelled: 0, configured: true };
    if (!this.#peer) {
      // Claiming nothing is deliberate. Claiming would spend one attempt of every event per tick against a destination
      // that does not exist, and in six ticks the whole queue would be `failed` because a variable was never set.
      return { ...result, configured: false };
    }
    for (const event of await this.#claim(limit)) {
      result.claimed += 1;
      const outcome = await this.#deliver(event, this.#peer);
      if (outcome === 'delivered') result.delivered += 1;
      else if (outcome === 'rescheduled') result.rescheduled += 1;
      else if (outcome === 'cancelled') result.cancelled += 1;
      else result.failed += 1;
    }
    return result;
  }

  /**
   * Atomic claim. Two dispatchers running at once (which a slow tick makes happen by itself) would pick the same row and
   * send the event twice; `FOR UPDATE SKIP LOCKED` makes the loser not see the row at all instead of seeing and duplicating.
   * A row left in `sending` by a crashed process is picked up again once its lease runs out.
   */
  async #claim(limit: number): Promise<Claimed[]> {
    const now = this.#clock.now();
    const leaseUntil = new Date(now.getTime() + this.#settings.leaseMs);
    const { rows } = await this.#pool.query<Claimed>(
      `UPDATE outbox_events
          SET status = 'sending', attempts = attempts + 1, locked_until = $2
        WHERE id IN (
              SELECT id FROM outbox_events
               WHERE (status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= $1))
                  OR (status = 'sending' AND locked_until < $1)
               ORDER BY created_at
               LIMIT $3
                 FOR UPDATE SKIP LOCKED)
      RETURNING id, type, payload, attempts, subject_id`,
      [now, leaseUntil, limit],
    );
    return rows;
  }

  async #deliver(event: Claimed, peer: Peer): Promise<Delivery> {
    if (event.subject_id) {
      const verdict = await consentStillHolds(this.#pool, event.subject_id, event.type);
      if (!verdict.ok) {
        // Not a transient failure, so it is not rescheduled: retrying would keep knocking against a decision that will
        // not change by itself. And not `failed` either: that status would invite a "retry the failed ones" button to
        // send the data after all, and would bury the proof that we stopped when asked.
        await this.#pool.query(
          `UPDATE outbox_events SET status = 'cancelled_by_revocation', last_error = $2 WHERE id = $1`,
          [event.id, `consent: ${verdict.reason}`],
        );
        return 'cancelled';
      }
    }

    try {
      // The id of the row is the id of the event, so it is the same on every retry. If it were minted per attempt, each
      // retry would arrive as a new fact and the receiver's de-duplication would have nothing to catch.
      const response = await signedRequest(peer, this.#clock, {
        method: 'POST',
        path: '/v1/events',
        body: { type: event.type, data: event.payload },
        eventId: event.id,
        timeoutMs: this.#settings.sendTimeoutMs,
        ...(this.#fetch ? { fetchImpl: this.#fetch } : {}),
      });
      if (response.status >= 200 && response.status < 300) {
        await this.#pool.query(
          `UPDATE outbox_events SET status = 'sent', sent_at = $2, last_error = NULL, locked_until = NULL WHERE id = $1`,
          [event.id, this.#clock.now()],
        );
        return 'delivered';
      }
      if (!RETRYABLE_STATUS.has(response.status)) return await this.#fail(event.id, `http ${response.status}`);
      return await this.#reschedule(event, `http ${response.status}`);
    } catch (error) {
      return await this.#reschedule(event, error instanceof Error ? error.name : 'network error');
    }
  }

  async #reschedule(event: Claimed, reason: string): Promise<Delivery> {
    if (event.attempts >= this.#settings.maxAttempts) return this.#fail(event.id, reason);
    const wait = backoffMs(event.attempts, this.#settings.backoffBaseMs, this.#settings.backoffCapMs);
    await this.#pool.query(
      `UPDATE outbox_events SET status = 'pending', next_attempt_at = $2, last_error = $3, locked_until = NULL WHERE id = $1`,
      [event.id, new Date(this.#clock.now().getTime() + wait), reason.slice(0, 300)],
    );
    return 'rescheduled';
  }

  async #fail(id: string, reason: string): Promise<Delivery> {
    // Stays in the table as `failed`: someone has to be able to see what never arrived.
    await this.#pool.query(
      `UPDATE outbox_events SET status = 'failed', last_error = $2, locked_until = NULL WHERE id = $1`,
      [id, reason.slice(0, 300)],
    );
    return 'failed';
  }
}
