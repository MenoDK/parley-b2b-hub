import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Outbox } from '../src/lib/outbox.js';
import { DATABASE_URL, type World, decide, handedOver, key, startWorld } from './harness.js';

const MINUTE = 60;

describe.skipIf(!DATABASE_URL)('the outbox, against a real database and a real peer', () => {
  let world: World;
  beforeAll(async () => {
    world = await startWorld();
  });
  afterAll(async () => {
    await world.close();
  });
  beforeEach(() => {
    world.origin.built.ctx.outage.mode = 'none';
  });

  const eventRow = async (intakeId: string) =>
    (await world.sql(world.partner, 'SELECT * FROM outbox_events WHERE subject_id = $1', [intakeId]))[0] as Record<
      string,
      any
    >;
  const referralStatus = async (referralId: string) =>
    (
      await world.sql(world.origin, 'SELECT status, status_mismatches FROM referrals WHERE id = $1', [referralId])
    )[0] as Record<string, any>;

  it('queues the decision in the same transaction and delivers it, and the origin applies the status it read back', async () => {
    const { referralId, intakeId } = await handedOver(world);
    expect((await decide(world, intakeId, 'approved')).statusCode).toBe(200);
    expect((await eventRow(intakeId)).status).toBe('pending');
    expect((await referralStatus(referralId)).status).toBe('handed_over'); // the origin knows nothing yet

    await world.partner.built.tick();
    expect((await eventRow(intakeId)).status).toBe('sent');
    expect(await referralStatus(referralId)).toMatchObject({ status: 'approved', status_mismatches: 0 });
    // deciding twice is refused, so there is never a second, conflicting event
    expect((await decide(world, intakeId, 'rejected')).statusCode).toBe(409);
  });

  it('backs off exponentially, keeps the same event id on every retry, and delivers once the peer is back', async () => {
    const { referralId, intakeId } = await handedOver(world);
    await decide(world, intakeId, 'approved');
    world.origin.built.ctx.outage.mode = 'down';

    const delays: number[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      await world.partner.built.tick();
      const row = await eventRow(intakeId);
      expect(row.status).toBe('pending');
      expect(row.attempts).toBe(attempt);
      delays.push((new Date(row.next_attempt_at).getTime() - world.clock.now().getTime()) / 1000);

      // before the wait is over nothing is claimed: attempts must not move
      await world.partner.built.tick();
      expect((await eventRow(intakeId)).attempts).toBe(attempt);
      world.clock.advance(delays.at(-1) ?? 0);
    }
    expect(delays).toEqual([60, 120, 240]);

    world.origin.built.ctx.outage.mode = 'none';
    await world.partner.built.tick();
    expect((await eventRow(intakeId)).status).toBe('sent');
    expect((await referralStatus(referralId)).status).toBe('approved');
    // three failed tries never reached the inbox; the fourth did, once
    const received = await world.sql(world.origin, 'SELECT event_id FROM inbox_events WHERE event_id = $1', [
      (await eventRow(intakeId)).id,
    ]);
    expect(received).toHaveLength(1);
  });

  it('treats 404 as "not deployed yet" and retries it, then gives up after the maximum attempts and keeps the row visible', async () => {
    const { intakeId } = await handedOver(world);
    await decide(world, intakeId, 'rejected');
    world.origin.built.ctx.outage.mode = 'not_deployed';

    for (let attempt = 1; attempt <= 6; attempt++) {
      await world.partner.built.tick();
      const row = await eventRow(intakeId);
      expect(row.attempts).toBe(attempt);
      if (attempt < 6) {
        expect(row.status).toBe('pending');
        world.clock.advance(3601); // past the cap, so every tick is eligible
      }
    }
    const row = await eventRow(intakeId);
    expect(row.status).toBe('failed');
    expect(row.last_error).toBe('http 404');
    // failed rows are never picked up again
    world.clock.advance(100_000);
    await world.partner.built.tick();
    expect((await eventRow(intakeId)).attempts).toBe(6);
  });

  it('does not send once the person has withdrawn consent, and records that as a cancellation, not a failure', async () => {
    const { referralId, intakeId } = await handedOver(world);
    await decide(world, intakeId, 'approved');
    const revoke = await world.partner.built.app.inject({
      method: 'POST',
      url: `/v1/intakes/${intakeId}/consents/status_back/revoke`,
      headers: key(world),
    });
    expect(revoke.json()).toEqual({ revoked: true });

    await world.partner.built.tick();
    const row = await eventRow(intakeId);
    expect(row.status).toBe('cancelled_by_revocation');
    expect(row.last_error).toBe('consent: revoked');
    expect((await referralStatus(referralId)).status).toBe('handed_over'); // the origin was never told
    expect(await world.sql(world.origin, 'SELECT 1 FROM inbox_events WHERE event_id = $1', [row.id])).toHaveLength(0);
  });

  it('refuses to send an event type that no consent purpose covers', async () => {
    const { intakeId } = await handedOver(world);
    const id = await world.partner.built.ctx.outbox.enqueue(world.partner.built.ctx.pool, {
      peer: 'origin',
      type: 'marketing.blast',
      payload: {},
      subjectId: intakeId,
    });
    await world.partner.built.tick();
    const [row] = await world.sql(world.partner, 'SELECT status, last_error FROM outbox_events WHERE id = $1', [id]);
    expect(row).toMatchObject({ status: 'cancelled_by_revocation', last_error: 'consent: unknown_event_type' });
  });

  it('claims nothing while the peer is not configured, so a missing variable cannot burn the queue', async () => {
    const { pool, clock, config } = world.partner.built.ctx;
    const orphan = new Outbox({ pool, clock, settings: config.outbox, peer: null });
    const id = await orphan.enqueue(pool, {
      peer: 'origin',
      type: 'intake.decided',
      payload: {},
      subjectId: crypto.randomUUID(),
    });
    for (let i = 0; i < 10; i++) expect((await orphan.deliverBatch()).configured).toBe(false);
    const [row] = await world.sql(world.partner, 'SELECT status, attempts FROM outbox_events WHERE id = $1', [id]);
    expect(row).toMatchObject({ status: 'pending', attempts: 0 });
    await world.sql(world.partner, `UPDATE outbox_events SET status = 'failed' WHERE id = $1`, [id]);
  });

  it('delivers each event exactly once when two dispatchers run at the same time', async () => {
    const intakes: string[] = [];
    for (let i = 0; i < 8; i++) {
      const { intakeId } = await handedOver(world);
      await decide(world, intakeId, 'approved');
      intakes.push(intakeId);
    }
    const { pool, clock, config, peer } = world.partner.built.ctx;
    const dispatchers = [1, 2, 3].map(() => new Outbox({ pool, clock, settings: config.outbox, peer }));
    const results = await Promise.all(dispatchers.map((outbox) => outbox.deliverBatch(8)));

    expect(results.reduce((sum, r) => sum + r.delivered, 0)).toBe(8);
    expect(results.reduce((sum, r) => sum + r.claimed, 0)).toBe(8);
    for (const intakeId of intakes) {
      const row = await eventRow(intakeId);
      expect(row).toMatchObject({ status: 'sent', attempts: 1 });
      expect(await world.sql(world.origin, 'SELECT 1 FROM inbox_events WHERE event_id = $1', [row.id])).toHaveLength(1);
    }
  });

  it('skips a row another dispatcher is claiming instead of waiting for it or taking it too', async () => {
    const { intakeId: held } = await handedOver(world);
    const { intakeId: free } = await handedOver(world);
    await decide(world, held, 'approved');
    await decide(world, free, 'approved');
    const heldRow = await eventRow(held);

    // Another dispatcher is half-way through claiming `held`: it has the row locked and has not committed.
    const other = await world.partner.built.ctx.pool.connect();
    await other.query('BEGIN');
    await other.query('SELECT id FROM outbox_events WHERE id = $1 FOR UPDATE', [heldRow.id]);
    try {
      const gaveUp = Symbol('blocked');
      const outcome = await Promise.race([
        world.partner.built.ctx.outbox.deliverBatch(10),
        new Promise<symbol>((resolve) => setTimeout(() => resolve(gaveUp), 3000)),
      ]);
      // Without SKIP LOCKED the claim queues behind the lock and never returns while the other dispatcher holds it.
      expect(outcome).not.toBe(gaveUp);
      expect(outcome).toMatchObject({ claimed: 1, delivered: 1 });
      expect((await eventRow(free)).status).toBe('sent');
      expect((await eventRow(held)).status).toBe('pending'); // untouched: it is the other dispatcher's
    } finally {
      await other.query('ROLLBACK');
      other.release();
    }
    await world.partner.built.tick();
    expect((await eventRow(held)).status).toBe('sent');
  });

  it('takes back an event a crashed dispatcher left "sending" once its lease runs out, and not before', async () => {
    const { referralId, intakeId } = await handedOver(world);
    await decide(world, intakeId, 'approved');
    const row = await eventRow(intakeId);
    const lease = new Date(world.clock.now().getTime() + 60_000);
    await world.sql(
      world.partner,
      `UPDATE outbox_events SET status = 'sending', attempts = 1, locked_until = $2 WHERE id = $1`,
      [row.id, lease],
    );

    await world.partner.built.tick();
    expect((await eventRow(intakeId)).status).toBe('sending'); // still leased: someone may be working on it

    world.clock.advance(MINUTE + 1);
    await world.partner.built.tick();
    expect((await eventRow(intakeId)).status).toBe('sent');
    expect((await referralStatus(referralId)).status).toBe('approved');
  });
});
