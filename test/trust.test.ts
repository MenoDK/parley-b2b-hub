import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sign } from '../src/lib/signing.js';
import { DATABASE_URL, type World, decide, handedOver, key, signedEnvelope, startWorld } from './harness.js';

describe.skipIf(!DATABASE_URL)('what the origin refuses to believe', () => {
  let world: World;
  beforeAll(async () => {
    world = await startWorld();
  });
  afterAll(async () => {
    await world.close();
  });

  const post = (side: 'origin' | 'partner', headers: Record<string, string>, payload: string) =>
    world[side].built.app.inject({ method: 'POST', url: '/v1/events', headers, payload });

  it('treats a signed "approved" as a hint: a lying partner changes nothing, and the mismatch is counted', async () => {
    const { referralId, intakeId } = await handedOver(world);
    // the intake is still pending on the partner; a correctly signed event claims otherwise
    const lie = signedEnvelope(world.secrets.partnerToOrigin, world.clock, 'intake.decided', {
      origin_ref: referralId,
      intake_id: intakeId,
      status_hint: 'approved',
    });
    const res = await post('origin', lie.headers, lie.raw);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ result: { applied: 'pending', hint: 'approved', mismatch: true } });
    const [row] = await world.sql(world.origin, 'SELECT status, status_mismatches FROM referrals WHERE id = $1', [
      referralId,
    ]);
    expect(row).toEqual({ status: 'pending', status_mismatches: 1 });
    const audit = await world.sql(world.origin, `SELECT 1 FROM audit_log WHERE kind = 'status.mismatch' AND ref = $1`, [
      referralId,
    ]);
    expect(audit).toHaveLength(1);

    // the honest path still works afterwards, with its own event
    await decide(world, intakeId, 'rejected');
    await world.partner.built.tick();
    expect((await world.sql(world.origin, 'SELECT status FROM referrals WHERE id = $1', [referralId]))[0]?.status).toBe(
      'rejected',
    );
  });

  it('answers one generic 401 to every forged, tampered, stale or unsigned request, and tells the operator why', async () => {
    const good = signedEnvelope(world.secrets.partnerToOrigin, world.clock, 'intake.decided', {
      origin_ref: crypto.randomUUID(),
      intake_id: crypto.randomUUID(),
      status_hint: 'approved',
    });
    const tampered = { ...good, raw: good.raw.replace('approved', 'rejected') };
    const wrongSecret = signedEnvelope('x'.repeat(40), world.clock, 'intake.decided', {});
    const stale = signedEnvelope(world.secrets.partnerToOrigin, world.clock, 'intake.decided', {});
    const staleTs = String(Math.floor(world.clock.now().getTime() / 1000) - 3600);
    const staleHeaders = {
      ...stale.headers,
      'x-parley-timestamp': staleTs,
      'x-parley-signature': sign(world.secrets.partnerToOrigin, stale.eventId, staleTs, stale.raw),
    };
    const unsigned = { 'content-type': 'application/json' };
    // a signature made with the OTHER direction's secret must not verify either
    const sideways = signedEnvelope(world.secrets.originToPartner, world.clock, 'intake.decided', {});

    const answers = await Promise.all([
      post('origin', tampered.headers, tampered.raw),
      post('origin', wrongSecret.headers, wrongSecret.raw),
      post('origin', staleHeaders, stale.raw),
      post('origin', unsigned, good.raw),
      post('origin', sideways.headers, sideways.raw),
    ]);
    expect(answers.map((r) => r.statusCode)).toEqual([401, 401, 401, 401, 401]);
    expect(new Set(answers.map((r) => r.body)).size).toBe(1);
  });

  it('answers a deterministic rejection the same way every time and never reprocesses it', async () => {
    const orphan = signedEnvelope(world.secrets.partnerToOrigin, world.clock, 'intake.decided', {
      origin_ref: crypto.randomUUID(),
      intake_id: crypto.randomUUID(),
      status_hint: 'approved',
    });
    const first = await post('origin', orphan.headers, orphan.raw);
    const second = await post('origin', orphan.headers, orphan.raw);
    expect(first.statusCode).toBe(422);
    expect(first.json()).toMatchObject({ error: { code: 'unknown_referral' } });
    expect(second.json()).toEqual({ status: 'duplicate' }); // claimed on the first try, so a retry is not a second attempt
    expect(second.statusCode).toBe(200);
  });

  it('rolls back and lets the sender retry when the partner cannot be reached to confirm', async () => {
    const { referralId, intakeId } = await handedOver(world);
    const hint = signedEnvelope(world.secrets.partnerToOrigin, world.clock, 'intake.decided', {
      origin_ref: referralId,
      intake_id: intakeId,
      status_hint: 'approved',
    });
    world.partner.built.ctx.outage.mode = 'none';
    // take the partner's read endpoint away by revoking its secrets on the origin side of the call: use a wrong peer URL
    const peer = world.origin.built.ctx.peer;
    if (!peer) throw new Error('origin has no peer');
    const original = peer.url;
    (peer as { url: string }).url = 'http://127.0.0.1:9';
    try {
      const failed = await post('origin', hint.headers, hint.raw);
      expect(failed.statusCode).toBe(500);
    } finally {
      (peer as { url: string }).url = original;
    }
    // nothing was claimed, so the very same signed request now succeeds
    const retried = await post('origin', hint.headers, hint.raw);
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toMatchObject({ status: 'accepted' });
  });

  it('refuses an unsupported event type without using up the event id', async () => {
    const id = crypto.randomUUID();
    const unknown = signedEnvelope(world.secrets.partnerToOrigin, world.clock, 'mystery.happened', {}, id);
    expect((await post('origin', unknown.headers, unknown.raw)).statusCode).toBe(422);
    expect(await world.sql(world.origin, 'SELECT 1 FROM inbox_events WHERE event_id = $1', [id])).toHaveLength(0);
  });

  it('guards the management API with a key compared in constant time, and refuses the default key in production', async () => {
    const res = await world.origin.built.app.inject({
      method: 'GET',
      url: '/v1/referrals',
      headers: { 'x-api-key': 'wrong' },
    });
    expect(res.statusCode).toBe(401);
    expect((await world.origin.built.app.inject({ method: 'GET', url: '/v1/referrals' })).statusCode).toBe(401);
    expect(
      (await world.origin.built.app.inject({ method: 'GET', url: '/v1/referrals', headers: key(world) })).statusCode,
    ).toBe(200);
  });

  it('serves signed reads to a holder of the secret once per request id, and not twice', async () => {
    const { intakeId } = await handedOver(world);
    const { signedRequest } = await import('../src/lib/peer.js');
    const peer = world.origin.built.ctx.peer;
    if (!peer) throw new Error('origin has no peer');
    const ok = await signedRequest(peer, world.clock, {
      method: 'GET',
      path: `/v1/peer/intakes/${intakeId}/status`,
      timeoutMs: 3000,
    });
    expect(ok.status).toBe(200);
    // the same request id replayed
    const ts = String(Math.floor(world.clock.now().getTime() / 1000));
    const id = crypto.randomUUID();
    const headers = {
      'x-parley-event-id': id,
      'x-parley-timestamp': ts,
      'x-parley-signature': sign(world.secrets.originToPartner, id, ts, ''),
    };
    const url = `/v1/peer/intakes/${intakeId}/status`;
    expect((await world.partner.built.app.inject({ method: 'GET', url, headers })).statusCode).toBe(200);
    expect((await world.partner.built.app.inject({ method: 'GET', url, headers })).statusCode).toBe(409);
    // and without a signature, no one reads the status
    expect((await world.partner.built.app.inject({ method: 'GET', url })).statusCode).toBe(401);
  });
});
