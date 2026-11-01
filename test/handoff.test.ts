import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE_URL, PDF, type World, key, referralBody, signedEnvelope, startWorld } from './harness.js';

describe.skipIf(!DATABASE_URL)('hand-over between two real services', () => {
  let world: World;
  beforeAll(async () => {
    world = await startWorld();
  });
  afterAll(async () => {
    await world.close();
  });

  const createReferral = async (body = referralBody()) => {
    const res = await world.origin.built.app.inject({
      method: 'POST',
      url: '/v1/referrals',
      headers: key(world),
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    return res.json<{ id: string }>().id;
  };
  const handoff = (id: string) =>
    world.origin.built.app.inject({ method: 'POST', url: `/v1/referrals/${id}/handoff`, headers: key(world) });

  it('creates the intake, pulls and verifies the documents, and returns a single-use link', async () => {
    const id = await createReferral();
    const res = await handoff(id);
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      intakeId: string;
      duplicate: boolean;
      documents: { kind: string; outcome: string }[];
      continuationUrl: string;
    }>();
    expect(body.duplicate).toBe(false);
    expect(body.documents.map((d) => `${d.kind}:${d.outcome}`).sort()).toEqual([
      'id_photo:stored',
      'proof_of_address:stored',
    ]);

    const stored = await world.sql(
      world.partner,
      'SELECT kind, size, outcome FROM intake_documents WHERE intake_id = $1 ORDER BY kind',
      [body.intakeId],
    );
    expect(stored.map((r) => r.outcome)).toEqual(['stored', 'stored']);

    // the person follows the link: it works once, then it is gone, with the same answer as an expired one
    const path = new URL(body.continuationUrl).pathname;
    const first = await world.partner.built.app.inject({ method: 'GET', url: path });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ customerName: 'Ana Souza', returnUrl: 'https://shop.example.com/orders/7' });
    const second = await world.partner.built.app.inject({ method: 'GET', url: path });
    expect(second.statusCode).toBe(410);
    expect(
      (await world.partner.built.app.inject({ method: 'GET', url: '/v1/continue/not-a-real-token' })).json(),
    ).toEqual(second.json());

    // the documents were fetched through signed links, and each fetch is on the access log
    const access = await world.sql(world.origin, 'SELECT outcome FROM document_access');
    expect(access.filter((r) => r.outcome === 'served').length).toBeGreaterThanOrEqual(2);
  });

  it('keeps the tax id encrypted at rest on both sides and finds it through the blind index', async () => {
    const id = await createReferral(
      referralBody({ customer: { name: 'Bruno Lima', email: 'bruno@example.com', taxId: '111.444.777-35' } }),
    );
    await handoff(id);
    for (const [side, table] of [
      [world.origin, 'referrals'],
      [world.partner, 'intakes'],
    ] as const) {
      const rows = await world.sql(
        side,
        `SELECT tax_id_enc, tax_id_blind FROM ${table} WHERE customer_name = 'Bruno Lima'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.tax_id_enc).toMatch(/^v1\./);
      expect(JSON.stringify(rows[0])).not.toMatch(/11144477735|111\.444/);
      const index = side.built.ctx.vault.current.blindIndex('11144477735');
      expect(rows[0]?.tax_id_blind).toBe(index);
    }
    const listed = await world.origin.built.app.inject({ method: 'GET', url: '/v1/referrals', headers: key(world) });
    expect(JSON.stringify(listed.json())).not.toContain('11144477735');
    expect(
      listed
        .json<{ customer: { taxId: string } }[]>()
        .some((r) => r.customer.taxId.endsWith('35') && r.customer.taxId.startsWith('•')),
    ).toBe(true);
  });

  it('is idempotent: repeating the hand-over creates nothing new, and a replayed capture returns no link', async () => {
    const id = await createReferral();
    const first = (await handoff(id)).json<{ intakeId: string; continuationUrl: string }>();
    const again = (await handoff(id)).json<{ intakeId: string; duplicate: boolean; continuationUrl: string }>();
    expect(again.duplicate).toBe(true);
    expect(again.intakeId).toBe(first.intakeId);
    expect((await world.sql(world.partner, 'SELECT 1 FROM intakes WHERE origin_ref = $1', [id])).length).toBe(1);

    // latest link wins: the first one stopped working the moment the second was issued
    expect(
      (await world.partner.built.app.inject({ method: 'GET', url: new URL(first.continuationUrl).pathname }))
        .statusCode,
    ).toBe(410);
    expect(
      (await world.partner.built.app.inject({ method: 'GET', url: new URL(again.continuationUrl).pathname }))
        .statusCode,
    ).toBe(200);

    // an attacker who captured the signed hand-over request and replays it learns that it was a duplicate, and nothing else
    const captured = signedEnvelope(
      world.secrets.originToPartner,
      world.clock,
      'referral.created',
      { origin_ref: id },
      id,
    );
    const replay = await world.partner.built.app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: captured.headers,
      payload: captured.raw,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ status: 'duplicate' });
  });

  it('rejects documents that do not match their manifest, without losing the intake', async () => {
    const id = await createReferral();
    // the bytes change on the origin after the hash was taken: the partner must notice
    await world.sql(world.origin, `UPDATE documents SET content = $2 WHERE referral_id = $1 AND kind = 'id_photo'`, [
      id,
      Buffer.from('not the same bytes'),
    ]);
    const body = (await handoff(id)).json<{ documents: { kind: string; outcome: string; reason?: string }[] }>();
    expect(body.documents.find((d) => d.kind === 'id_photo')).toMatchObject({
      outcome: 'rejected',
      reason: 'hash_mismatch',
    });
    expect(body.documents.find((d) => d.kind === 'proof_of_address')).toMatchObject({ outcome: 'stored' });
  });

  it('does not fetch a URL on any origin but the trusted one (SSRF), nor a type or size outside the policy', async () => {
    const referralId = crypto.randomUUID();
    const manifest = (url: string, over: Record<string, unknown> = {}) => ({
      kind: 'proof',
      filename: 'x.pdf',
      mime: 'application/pdf',
      size: PDF.length,
      sha256: 'a'.repeat(64),
      url,
      ...over,
    });
    const send = async (documents: object[]) => {
      const env = signedEnvelope(world.secrets.originToPartner, world.clock, 'referral.created', {
        origin_ref: referralId,
        customer: { name: 'Carla', email: 'carla@example.com', taxId: '39053344705' },
        return_url: null,
        consents: { status_back: false },
        documents,
      });
      return (
        await world.partner.built.app.inject({
          method: 'POST',
          url: '/v1/events',
          headers: env.headers,
          payload: env.raw,
        })
      ).json<{ result: { documents: { reason?: string }[] } }>();
    };
    const out = await send([
      manifest('http://127.0.0.1:9/internal-admin'),
      manifest(`${world.origin.url}/v1/documents/x`, { mime: 'application/x-msdownload' }),
      manifest(`${world.origin.url}/v1/documents/x`, { size: 50_000_000 }),
    ]);
    expect(out.result.documents.map((d) => d.reason)).toEqual(['url_not_allowed', 'mime_not_allowed', 'too_large']);
  });

  it('serves a document link once signed, refuses every forgery with one answer, and dies when the document is revoked', async () => {
    const id = await createReferral();
    const [doc] = await world.sql(
      world.origin,
      `SELECT id FROM documents WHERE referral_id = $1 AND kind = 'proof_of_address'`,
      [id],
    );
    const { signDocumentLink } = await import('../src/lib/document-links.js');
    const token = signDocumentLink({
      documentId: String(doc?.id),
      secret: world.origin.config.secretOut,
      nowSeconds: Math.floor(world.clock.now().getTime() / 1000),
    });
    const get = (t: string) => world.origin.built.app.inject({ method: 'GET', url: `/v1/documents/${t}` });

    const ok = await get(token);
    expect(ok.statusCode).toBe(200);
    expect(ok.rawPayload.equals(PDF)).toBe(true);
    expect(ok.headers['content-disposition']).toContain('attachment');
    expect(ok.headers['cache-control']).toBe('no-store');

    const [docId, expiry, mac] = token.split('.') as [string, string, string];
    const forged = [
      `${docId}.${Number(expiry) + 9999}.${mac}`,
      `${docId}.${expiry}.${'0'.repeat(64)}`,
      'garbage',
      `${crypto.randomUUID()}.${expiry}.${mac}`,
    ];
    const answers = await Promise.all(forged.map((t) => get(t)));
    expect(answers.map((r) => r.statusCode)).toEqual([403, 403, 403, 403]);
    expect(new Set(answers.map((r) => r.body)).size).toBe(1);

    // a correctly signed link to a document that does not exist is refused the same way, and logged for what it is
    const nowSeconds = Math.floor(world.clock.now().getTime() / 1000);
    const orphan = signDocumentLink({
      documentId: crypto.randomUUID(),
      secret: world.origin.config.secretOut,
      nowSeconds,
    });
    expect((await get(orphan)).body).toBe(answers[0]?.body);

    await world.origin.built.app.inject({ method: 'POST', url: `/v1/documents/${docId}/revoke`, headers: key(world) });
    expect((await get(token)).statusCode).toBe(403);
    const log = (await world.sql(world.origin, 'SELECT outcome FROM document_access ORDER BY id DESC LIMIT 10')).map(
      (r) => r.outcome,
    );
    expect(log).toEqual(expect.arrayContaining(['revoked', 'bad_signature', 'malformed', 'no_such_document']));

    // after the clock passes the lifetime, even a valid link is refused
    const late = signDocumentLink({
      documentId: crypto.randomUUID(),
      secret: world.origin.config.secretOut,
      nowSeconds: 1000,
    });
    expect((await get(late)).statusCode).toBe(403);
  });

  it('keeps a return URL only if its origin is on the allow-list', async () => {
    const id = await createReferral(
      referralBody({ returnUrl: 'https://shop.example.com.evil.test/login', documents: [] }),
    );
    const { intakeId } = (await handoff(id)).json<{ intakeId: string }>();
    const [row] = await world.sql(world.partner, 'SELECT return_url FROM intakes WHERE id = $1', [intakeId]);
    expect(row?.return_url).toBeNull();
  });
});

describe.skipIf(!DATABASE_URL)('the address the other company fetches documents from', () => {
  it('is SERVICE_URL, not PUBLIC_URL: a browser-facing address must not leak into server-to-server links', async () => {
    // PUBLIC_URL is what a person's browser uses and is useless to the partner's server (in Docker it is "localhost").
    const split = await startWorld({ originEnv: { PUBLIC_URL: 'https://shop.example.com' } });
    try {
      // The harness gives the origin a real SERVICE_URL only when asked; here PUBLIC_URL is unreachable and SERVICE_URL is unset.
      const { documents } = await (async () => {
        const created = await split.origin.built.app.inject({
          method: 'POST',
          url: '/v1/referrals',
          headers: key(split),
          payload: referralBody(),
        });
        const res = await split.origin.built.app.inject({
          method: 'POST',
          url: `/v1/referrals/${created.json<{ id: string }>().id}/handoff`,
          headers: key(split),
        });
        return res.json<{ documents: { outcome: string; reason?: string }[] }>();
      })();
      expect(documents.map((d) => d.reason)).toEqual(['url_not_allowed', 'url_not_allowed']);
    } finally {
      await split.close();
    }

    const fixed = await startWorld({ originEnv: { PUBLIC_URL: 'https://shop.example.com' }, originServiceUrl: true });
    try {
      const created = await fixed.origin.built.app.inject({
        method: 'POST',
        url: '/v1/referrals',
        headers: key(fixed),
        payload: referralBody(),
      });
      const res = await fixed.origin.built.app.inject({
        method: 'POST',
        url: `/v1/referrals/${created.json<{ id: string }>().id}/handoff`,
        headers: key(fixed),
      });
      expect(res.json<{ documents: { outcome: string }[] }>().documents.map((d) => d.outcome)).toEqual([
        'stored',
        'stored',
      ]);
    } finally {
      await fixed.close();
    }
  });
});
