import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sign } from '../src/lib/signing.js';
import { DATABASE_URL, type World, decide, handedOver, key, referralBody, startWorld } from './harness.js';

describe.skipIf(!DATABASE_URL)('lab mode', () => {
  let world: World;
  beforeAll(async () => {
    world = await startWorld({ lab: true });
  });
  afterAll(async () => {
    await world.close();
  });

  const lab = async (side: 'origin' | 'partner', path: string, payload: object = {}) => {
    const res = await world[side].built.app.inject({
      method: 'POST',
      url: `/v1/lab/${path}`,
      headers: key(world),
      payload,
    });
    return { status: res.statusCode, body: res.json() as Record<string, any> };
  };
  const state = async (side: 'origin' | 'partner') =>
    (await world[side].built.app.inject({ method: 'GET', url: '/v1/lab/state', headers: key(world) })).json() as Record<
      string,
      any
    >;

  it('moves the clock of one side or both, and never backwards', async () => {
    const before = (await state('origin')).clockOffsetSeconds;
    const both = await lab('origin', 'clock', { advanceSeconds: 600, target: 'both' });
    expect(both.body.self.clockOffsetSeconds).toBe(before + 600);
    expect((await state('partner')).clockOffsetSeconds).toBeGreaterThanOrEqual(600);
    expect((await lab('origin', 'clock', { advanceSeconds: -5 })).status).toBe(400);
  });

  it('runs the whole story from the origin: outage on the partner, a stuck event, recovery after the clock moves', async () => {
    await lab('origin', 'reset', { target: 'both' });
    const { referralId, intakeId } = await handedOver(world);
    await decide(world, intakeId, 'approved');

    // the partner is the sender and the origin the receiver, so the receiver is the one taken down
    await lab('origin', 'outage', { mode: 'down', target: 'self' });
    await lab('partner', 'dispatch');
    let outbox = (await state('partner')).outbox as Record<string, any>[];
    expect(outbox[0]).toMatchObject({ status: 'pending', attempts: 1, last_error: 'http 503' });

    await lab('origin', 'outage', { mode: 'none', target: 'self' });
    await lab('partner', 'dispatch');
    expect(((await state('partner')).outbox as Record<string, any>[])[0]?.attempts).toBe(1); // still waiting out its backoff
    await lab('partner', 'clock', { advanceSeconds: 61 });
    await lab('partner', 'dispatch');
    outbox = (await state('partner')).outbox as Record<string, any>[];
    expect(outbox[0]?.status).toBe('sent');
    expect(((await state('origin')).referrals as Record<string, any>[]).find((r) => r.id === referralId)?.status).toBe(
      'approved',
    );
  });

  it('forwards whatever the browser built, so a forged request is refused by the real peer', async () => {
    const raw = JSON.stringify({ type: 'intake.decided', data: {} });
    const forged = await lab('origin', 'send-to-peer', {
      raw,
      eventId: crypto.randomUUID(),
      timestamp: String(Math.floor(Date.now() / 1000)),
      signature: 'f'.repeat(64),
    });
    expect(forged.body).toMatchObject({ status: 401 });
    const unsigned = await lab('origin', 'send-to-peer', { raw, eventId: null, timestamp: null, signature: null });
    expect(unsigned.body).toMatchObject({ status: 401 });

    // signed with the secret the lab exposes, the same request is accepted by the peer's checks (and refused on content)
    const s = await state('origin');
    const id = crypto.randomUUID();
    const ts = String(Math.floor(Date.now() / 1000));
    const signed = await lab('origin', 'send-to-peer', {
      raw,
      eventId: id,
      timestamp: ts,
      signature: sign(s.secrets.out, id, ts, raw),
    });
    expect(signed.body.status).toBe(422);
    expect(signed.body.body.error.code).toBe('unsupported_event_type');
  });

  it('rotates the vault in steps: new key, rotate rows, and only then drop the old key', async () => {
    await lab('origin', 'reset', { target: 'both' });
    const { referralId } = await handedOver(
      world,
      referralBody({ customer: { name: 'Dora', email: 'dora@example.com', taxId: '529.982.247-25' } }),
    );
    const row = async () =>
      ((await state('origin')).vault.rows as Record<string, any>[]).find((r) => r.id === referralId);
    expect(await row()).toMatchObject({ version: 'v1', readable: true });

    expect((await lab('origin', 'vault/new-key')).body.currentVersion).toBe('v2');
    expect(await row()).toMatchObject({ version: 'v1', readable: true }); // old rows still readable under the old key
    const found = await lab('origin', 'find', { taxId: '52998224725' });
    expect(found.body.matches).toContain(referralId); // the blind index did not change with the key

    // dropping the old key BEFORE rotating destroys access to the row: that is the lesson
    expect((await lab('origin', 'vault/rotate')).body).toMatchObject({ rotated: expect.any(Number), unreadable: 0 });
    expect(await row()).toMatchObject({ version: 'v2', readable: true });
    await lab('origin', 'vault/drop-old-keys');
    expect(await row()).toMatchObject({ version: 'v2', readable: true });

    // the opposite order, on a fresh row: rotate never ran, then the old key goes
    const second = (await handedOver(world)).referralId;
    await lab('origin', 'vault/new-key');
    await lab('origin', 'vault/drop-old-keys');
    const lost = ((await state('origin')).vault.rows as Record<string, any>[]).find((r) => r.id === second);
    expect(lost).toMatchObject({ version: 'v2', readable: false });
  });

  it("lets the page act as the partner through the origin, using the partner's real routes", async () => {
    await lab('origin', 'reset', { target: 'both' });
    const { referralId, intakeId } = await handedOver(world);

    const decided = await lab('origin', 'decide', { intakeId, decision: 'approved', target: 'peer' });
    expect(decided.body.peer.self).toMatchObject({ status: 200, body: { status: 'approved' } });
    // the partner's own rule still applies: a second decision is a conflict, not a second event
    const twice = await lab('origin', 'decide', { intakeId, decision: 'rejected', target: 'peer' });
    expect(twice.body.peer.self.status).toBe(409);
    // and the origin has no such route
    expect((await lab('origin', 'decide', { intakeId, decision: 'approved' })).body.self.status).toBe(404);

    await lab('origin', 'dispatch', { target: 'peer' });
    expect(((await state('origin')).referrals as Record<string, any>[]).find((r) => r.id === referralId)?.status).toBe(
      'approved',
    );

    const second = await handedOver(world);
    await lab('origin', 'consent/revoke', { subjectId: second.intakeId, target: 'peer' });
    await lab('origin', 'decide', { intakeId: second.intakeId, decision: 'approved', target: 'peer' });
    await lab('origin', 'dispatch', { target: 'peer' });
    const peer = (
      await world.origin.built.app.inject({ method: 'GET', url: '/v1/lab/peer-state', headers: key(world) })
    ).json() as Record<string, any>;
    expect(peer.outbox.find((e: Record<string, any>) => e.status === 'cancelled_by_revocation')).toBeDefined();
  });

  it('follows a continuation link for the page, and nothing else', async () => {
    await handedOver(world);
    for (const path of [
      '/v1/continue/../../health/live',
      'http://169.254.169.254/latest',
      '/v1/documents/x',
      '/v1/continue/',
    ]) {
      expect((await lab('origin', 'follow', { path })).status).toBe(400);
    }
    expect((await lab('origin', 'follow', { path: '/v1/continue/not-a-real-token' })).body).toMatchObject({
      status: 410,
    });
  });

  it('keeps serving the list when a row can no longer be decrypted, and refuses to hand that row over', async () => {
    await lab('origin', 'reset', { target: 'both' });
    await handedOver(world);
    const lost = (await handedOver(world)).referralId;
    await lab('origin', 'vault/new-key');
    await lab('origin', 'vault/drop-old-keys'); // nothing was rotated: every existing row is now unreadable

    const list = await world.origin.built.app.inject({ method: 'GET', url: '/v1/referrals', headers: key(world) });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ customer: { taxId: string } }[]>().map((r) => r.customer.taxId)).toEqual([
      '(unreadable: key not available)',
      '(unreadable: key not available)',
    ]);
    const again = await world.origin.built.app.inject({
      method: 'POST',
      url: `/v1/referrals/${lost}/handoff`,
      headers: key(world),
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: { code: 'unreadable_record' } });
    await lab('origin', 'reset', { target: 'both' }); // leaves the ring as the config had it
  });

  it('resets both sides to a known state', async () => {
    await handedOver(world);
    await lab('origin', 'outage', { mode: 'down' });
    const reset = await lab('origin', 'reset', { target: 'both' });
    expect(reset.body.self.reset).toBe(true);
    expect(reset.body.peer.self.reset).toBe(true);
    for (const side of ['origin', 'partner'] as const) {
      const s = await state(side);
      expect(s.outage).toBe('none');
      expect(s.clockOffsetSeconds).toBe(0);
      expect(s.outbox).toEqual([]);
      expect(s.vault.currentVersion).toBe('v1');
    }
  });

  it('is absent when the flag is off, and the API key still guards it when it is on', async () => {
    expect((await world.origin.built.app.inject({ method: 'GET', url: '/v1/lab/state' })).statusCode).toBe(401);
    const plain = await startWorld();
    try {
      expect((await plain.origin.built.app.inject({ method: 'GET', url: '/v1/lab/config' })).statusCode).toBe(404);
      expect(
        (await plain.origin.built.app.inject({ method: 'POST', url: '/v1/lab/reset', headers: key(plain) })).statusCode,
      ).toBe(404);
    } finally {
      await plain.close();
    }
  });
});
