/**
 * Records the output shown in the landing page's tour by driving the real services (two Fastify apps, real PostgreSQL)
 * and writing what they answered. Nothing on that page is typed by hand: `test/transcripts.test.ts` records again and
 * fails when `site/transcripts.js` no longer matches, so the page cannot drift away from the code.
 *
 *   DATABASE_URL=postgresql://... npx tsx scripts/record-transcripts.ts
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { signDocumentLink } from '../src/lib/document-links.js';
import { sign } from '../src/lib/signing.js';
import { Vault } from '../src/lib/vault.js';
import {
  PDF,
  type Side,
  type World,
  decide,
  handedOver,
  key,
  referralBody,
  signedEnvelope,
  startWorld,
} from '../test/harness.js';

type Reply = { statusCode: number; body: string };

const escapeHtml = (text: string): string =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

/**
 * What the landing page's tour shows. The kit inserts a transcript as HTML, so every character is escaped here and the
 * four classes it styles (`tok-dim` for the story, `tok-k` for a request, `tok-ok` and `tok-bad` for the answer) are
 * added around whole lines. A placeholder such as `<id-1>` therefore reaches the reader as text, not as a tag.
 */
class Tape {
  readonly #entries: { cls?: string; text: string }[] = [];
  say(text: string): void {
    if (this.#entries.length > 0) this.#entries.push({ text: '' });
    this.#entries.push({ cls: 'tok-dim', text: `# ${text}` });
  }
  call(request: string, reply: Reply, shown?: (json: unknown) => unknown): void {
    this.#entries.push({ cls: 'tok-k', text: `→ ${request}` });
    this.#entries.push({ cls: reply.statusCode < 400 ? 'tok-ok' : 'tok-bad', text: `← ${reply.statusCode}` });
    let body: unknown = reply.body;
    try {
      body = JSON.parse(reply.body);
    } catch {
      /* not JSON (a PDF, say): keep the text */
    }
    const content = shown && typeof body === 'object' ? shown(body) : body;
    this.#entries.push({ text: typeof content === 'string' ? content : JSON.stringify(content, null, 2) });
  }
  raw(line: string): void {
    this.#entries.push({ text: line });
  }
  /** `transform` runs on the raw text of each line, before escaping, in order. */
  render(transform: (text: string) => string): string {
    return this.#entries
      .map(({ cls, text }) => {
        const shown = escapeHtml(transform(text));
        return cls ? `<span class="${cls}">${shown}</span>` : shown;
      })
      .join('\n');
  }
}

/** Ids, tokens and ports change on every run; what they mean does not. Replace them in order of appearance. */
function normaliser(world: World): (text: string) => string {
  const seen = new Map<string, string>();
  return (text) =>
    text
      .replaceAll(world.origin.url, 'http://origin:3000')
      .replaceAll(world.partner.url, 'http://partner:3000')
      .replace(/\.\d{10}\.[0-9a-f]{64}/g, '.<expiry>.<mac>')
      .replace(/\/v1\/continue\/[A-Za-z0-9_-]{43}/g, '/v1/continue/<token>')
      .replace(/\b(v\d+)\.[A-Za-z0-9_-]{30,}/g, '$1.<ciphertext>')
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (id) => {
        if (!seen.has(id)) seen.set(id, `<id-${seen.size + 1}>`);
        return seen.get(id) ?? id;
      });
}

const inject = (
  side: Side,
  method: 'GET' | 'POST',
  url: string,
  _world: World,
  payload?: unknown,
  headers: Record<string, string> = {},
) => side.built.app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });

async function handover(world: World): Promise<Tape> {
  const t = new Tape();
  t.say('The shop (origin) records a referral: a customer, a consent, and two documents.');
  const created = await inject(world.origin, 'POST', '/v1/referrals', world, referralBody(), key(world));
  const id = created.json<{ id: string }>().id;
  t.call('POST origin/v1/referrals', created);

  t.say(
    'Hand it over: two signed calls. The partner then pulls each document through a signed link and checks its hash.',
  );
  const hand = await inject(world.origin, 'POST', `/v1/referrals/${id}/handoff`, world, undefined, key(world));
  t.call(`POST origin/v1/referrals/${id}/handoff`, hand);
  const link = new URL(hand.json<{ continuationUrl: string }>().continuationUrl).pathname;

  t.say('The person follows the link they were given. It works once.');
  t.call(`GET partner${link}`, await inject(world.partner, 'GET', link, world));
  t.say('The same link again, and a link that never existed, get the same answer.');
  t.call(`GET partner${link}`, await inject(world.partner, 'GET', link, world));
  t.call(
    'GET partner/v1/continue/made-up-token',
    await inject(world.partner, 'GET', '/v1/continue/made-up-token', world),
  );

  t.say('Hand the same referral over again (a retry, a double click): nothing new is created.');
  const again = await inject(world.origin, 'POST', `/v1/referrals/${id}/handoff`, world, undefined, key(world));
  t.call(`POST origin/v1/referrals/${id}/handoff`, again, (j) => {
    const { documents: _documents, ...rest } = j as Record<string, unknown>;
    return rest;
  });
  return t;
}

async function signing(world: World): Promise<Tape> {
  const t = new Tape();
  const { intakeId } = await handedOver(world);
  await decide(world, intakeId, 'approved');
  const [queued] = (await world.sql(
    world.partner,
    'SELECT id, type, payload FROM outbox_events WHERE subject_id = $1',
    [intakeId],
  )) as {
    id: string;
    type: string;
    payload: object;
  }[];
  if (!queued) throw new Error('nothing was queued');

  t.say('The partner decides. The event is queued in the same transaction; the dispatcher sends it signed.');
  await world.partner.built.tick();
  t.raw(`event ${queued.id} (${queued.type}) -> sent`);

  const send = (headers: Record<string, string>, raw: string) =>
    world.origin.built.app.inject({ method: 'POST', url: '/v1/events', headers, payload: raw });
  const valid = signedEnvelope(world.secrets.partnerToOrigin, world.clock, queued.type, queued.payload, queued.id);

  t.say('An attacker captured that exact request and sends it again.');
  t.call('POST origin/v1/events   (same event id, same signature)', await send(valid.headers, valid.raw));

  t.say('Four ways to forge one. Every one gets the same answer, so a forger learns nothing about which check failed.');
  const tampered = signedEnvelope(world.secrets.partnerToOrigin, world.clock, queued.type, {
    ...queued.payload,
    status_hint: 'rejected',
  });
  t.call(
    'POST origin/v1/events   (body edited after signing)',
    await send({ ...tampered.headers, 'x-parley-signature': valid.headers['x-parley-signature'] }, tampered.raw),
  );
  const wrong = signedEnvelope('x'.repeat(40), world.clock, queued.type, queued.payload);
  t.call('POST origin/v1/events   (signed with another secret)', await send(wrong.headers, wrong.raw));
  const old = signedEnvelope(world.secrets.partnerToOrigin, world.clock, queued.type, queued.payload);
  const oldTs = String(Math.floor(world.clock.now().getTime() / 1000) - 3600);
  t.call(
    'POST origin/v1/events   (timestamp from an hour ago)',
    await send(
      {
        ...old.headers,
        'x-parley-timestamp': oldTs,
        'x-parley-signature': sign(world.secrets.partnerToOrigin, old.eventId, oldTs, old.raw),
      },
      old.raw,
    ),
  );
  t.call('POST origin/v1/events   (no signature at all)', await send({ 'content-type': 'application/json' }, old.raw));

  t.say(
    'A correct signature is not a licence: an event type this service does not handle is refused without using up its id.',
  );
  const stranger = signedEnvelope(world.secrets.partnerToOrigin, world.clock, 'mystery.happened', {});
  t.call('POST origin/v1/events   (valid signature, unknown type)', await send(stranger.headers, stranger.raw));
  return t;
}

async function outbox(world: World): Promise<Tape> {
  const t = new Tape();
  const { intakeId } = await handedOver(world);
  const row = async () =>
    (
      (await world.sql(
        world.partner,
        'SELECT status, attempts, next_attempt_at, last_error FROM outbox_events WHERE subject_id = $1',
        [intakeId],
      )) as Record<string, unknown>[]
    )[0];
  const show = async (label: string) => t.raw(`${label.padEnd(34)} ${JSON.stringify(await row())}`);

  t.say('The partner decides while the origin is down. The decision is already safe in the outbox.');
  await decide(world, intakeId, 'approved');
  world.origin.built.ctx.outage.mode = 'down';
  await show('queued');
  await world.partner.built.tick();
  await show('tick 1 (origin answers 503)');
  await world.partner.built.tick();
  await show('tick again, no waiting');
  t.say('Backoff doubles: 60 s, 120 s, 240 s. Ticking early claims nothing, so attempts do not move.');
  world.clock.advance(60);
  await world.partner.built.tick();
  await show('+60 s: attempt 2');
  world.clock.advance(120);
  await world.partner.built.tick();
  await show('+120 s: attempt 3');
  t.say('The origin comes back. The next eligible tick delivers it, under the same event id as every earlier try.');
  world.origin.built.ctx.outage.mode = 'none';
  world.clock.advance(240);
  await world.partner.built.tick();
  await show('+240 s: delivered');
  const [received] = await world.sql(world.origin, 'SELECT count(*)::int AS times FROM inbox_events');
  t.raw(`origin inbox rows for that id: ${(received as { times: number }).times === 1 ? 'exactly 1' : 'several'}`);

  t.say('Another customer withdraws consent between the decision and the send.');
  const second = await handedOver(world);
  await decide(world, second.intakeId, 'rejected');
  t.call(
    `POST partner/v1/intakes/${second.intakeId}/consents/status_back/revoke`,
    await inject(
      world.partner,
      'POST',
      `/v1/intakes/${second.intakeId}/consents/status_back/revoke`,
      world,
      undefined,
      key(world),
    ),
  );
  await world.partner.built.tick();
  const cancelled = (
    await world.sql(world.partner, 'SELECT status, attempts, last_error FROM outbox_events WHERE subject_id = $1', [
      second.intakeId,
    ])
  )[0];
  t.raw(`outbox row                         ${JSON.stringify(cancelled)}`);
  const told = (
    await world.sql(world.origin, 'SELECT status FROM referrals WHERE id = $1', [second.referralId])
  )[0] as { status: string };
  t.raw(`what the origin knows about it     ${JSON.stringify(told)}   (never told)`);
  return t;
}

async function trust(world: World): Promise<Tape> {
  const t = new Tape();
  const { referralId, intakeId } = await handedOver(world);

  t.say('The partner is still deciding. A message arrives, correctly signed, claiming "approved".');
  const lie = signedEnvelope(world.secrets.partnerToOrigin, world.clock, 'intake.decided', {
    origin_ref: referralId,
    intake_id: intakeId,
    status_hint: 'approved',
  });
  t.call(
    'POST origin/v1/events',
    await world.origin.built.app.inject({ method: 'POST', url: '/v1/events', headers: lie.headers, payload: lie.raw }),
  );
  const [state] = await world.sql(world.origin, 'SELECT status, status_mismatches FROM referrals WHERE id = $1', [
    referralId,
  ]);
  t.raw(`origin now records                 ${JSON.stringify(state)}`);

  t.say('Documents leave only through signed, short-lived links. Every outcome is written to an access log.');
  const [doc] = (await world.sql(
    world.origin,
    `SELECT id FROM documents WHERE referral_id = $1 AND kind = 'proof_of_address'`,
    [referralId],
  )) as { id: string }[];
  const now = Math.floor(world.clock.now().getTime() / 1000);
  const good = signDocumentLink({ documentId: doc?.id ?? '', secret: world.origin.config.secretOut, nowSeconds: now });
  const served = await inject(world.origin, 'GET', `/v1/documents/${good}`, world);
  t.call('GET origin/v1/documents/<signed-link>', {
    statusCode: served.statusCode,
    body: `${served.headers['content-type']}, ${served.rawPayload.length} bytes, sha256 matches the manifest: ${served.rawPayload.equals(PDF)}`,
  });
  const [id, expiry, mac] = good.split('.') as [string, string, string];
  t.call(
    'GET origin/v1/documents/<link with a later expiry>',
    await inject(world.origin, 'GET', `/v1/documents/${id}.${Number(expiry) + 99999}.${mac}`, world),
  );
  t.call(
    'GET origin/v1/documents/<link for a document that was never there>',
    await inject(
      world.origin,
      'GET',
      `/v1/documents/${signDocumentLink({ documentId: crypto.randomUUID(), secret: world.origin.config.secretOut, nowSeconds: now })}`,
      world,
    ),
  );
  t.say('Revoke the document: the link that worked a moment ago stops working, and so does every other copy of it.');
  t.call(
    `POST origin/v1/documents/${id}/revoke`,
    await inject(world.origin, 'POST', `/v1/documents/${id}/revoke`, world, undefined, key(world)),
  );
  t.call('GET origin/v1/documents/<the same link>', await inject(world.origin, 'GET', `/v1/documents/${good}`, world));
  const log = (await world.sql(world.origin, 'SELECT outcome FROM document_access ORDER BY id')) as {
    outcome: string;
  }[];
  t.raw(`access log, oldest first: ${log.map((r) => r.outcome).join(' → ')}`);
  t.raw("(the first two 'served' are the partner's own fetches during the hand-over)");
  return t;
}

async function atRest(world: World): Promise<Tape> {
  const t = new Tape();
  const { referralId } = await handedOver(world);
  const vault = world.origin.built.ctx.vault;
  const read = async () =>
    (
      await world.sql(world.origin, 'SELECT tax_id_enc, tax_id_blind FROM referrals WHERE id = $1', [referralId])
    )[0] as { tax_id_enc: string; tax_id_blind: string };

  t.say('The tax id never sits in the table in clear text: AES-256-GCM, with the key version in front.');
  const first = await read();
  t.raw(`tax_id_enc   ${first.tax_id_enc}`);
  t.raw(
    `tax_id_blind <${first.tax_id_blind.length} hex characters>   (HMAC under a separate key: searchable, not readable)`,
  );

  t.say('Rotate: a new key is added in front, old rows stay readable, then they are re-encrypted one by one.');
  vault.current = vault.current.withNewKey();
  t.raw(`versions in the ring: ${vault.current.versions.join(', ')}`);
  t.raw(`row version before rotating: ${vault.current.versionOf((await read()).tax_id_enc)}   readable: true`);
  const token = (await read()).tax_id_enc;
  await world.sql(world.origin, 'UPDATE referrals SET tax_id_enc = $2 WHERE id = $1', [
    referralId,
    vault.current.rotate(token),
  ]);
  t.raw(
    `row version after rotating:  ${vault.current.versionOf((await read()).tax_id_enc)}   blind index unchanged: ${(await read()).tax_id_blind === first.tax_id_blind}`,
  );

  t.say(
    'Retire the old key too early and the rows nobody rotated are gone for good. Rotation is a process, not a switch.',
  );
  const stale = new Vault([{ version: 'v1', key: Buffer.alloc(32, 1) }], 'a-blind-index-key-for-the-demo');
  const orphan = stale.encrypt('529.982.247-25');
  const retired = stale.withNewKey().retainOnlyCurrent();
  try {
    retired.decrypt(orphan);
  } catch (error) {
    t.raw(`decrypt a v1 row after dropping v1:  VaultError: ${(error as Error).message}`);
  }
  return t;
}

export async function record(): Promise<Record<string, string>> {
  const results: Record<string, string> = {};
  const scenarios: [string, (w: World) => Promise<Tape>][] = [
    ['handover', handover],
    ['signing', signing],
    ['outbox', outbox],
    ['trust', trust],
    ['atRest', atRest],
  ];
  for (const [name, run] of scenarios) {
    const world = await startWorld();
    try {
      results[name] = (await run(world)).render(normaliser(world));
    } finally {
      await world.close();
    }
  }
  return results;
}

export const render = (transcripts: Record<string, string>): string =>
  `/* Recorded from the running services by scripts/record-transcripts.ts. Do not edit: a test re-records and compares. */\nwindow.TRANSCRIPTS = ${JSON.stringify(transcripts, null, 2)};\n`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = fileURLToPath(new URL('../site/transcripts.js', import.meta.url));
  writeFileSync(target, render(await record()));
  console.log(`wrote ${target}`);
}
