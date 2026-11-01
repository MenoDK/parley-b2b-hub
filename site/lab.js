/* The lab: five tabs, each one a way to try to break the hand-over. Loaded before kit.js; it only declares things.
   Everything that came from the API is inserted as text. The page can only talk to the shop (strict CSP), so the
   partner is reached through the shop's lab routes, which call the partner's real endpoints. */
(() => {
  'use strict';

  const PDF_B64 = btoa('%PDF-1.4\n% a tiny fictional document\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
  const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const RETURN_URLS = [
    ['Allowed: https://shop.example.com/orders/7', 'https://shop.example.com/orders/7'],
    ['Look-alike host: shop.example.com.evil.test', 'https://shop.example.com.evil.test/login'],
    ['Plain http on the right host', 'http://shop.example.com/orders/7'],
    ['Credentials in the URL', 'https://shop.example.com@evil.test/orders/7'],
  ];
  const short = (id) => (id ? String(id).slice(0, 8) : '—');
  const time = (iso) => (iso ? new Date(iso).toISOString().slice(11, 19) : '—');
  const statusKind = (s) => ({ approved: 'ok', sent: 'ok', stored: 'ok', served: 'ok', pending: 'warn', handed_over: 'warn', draft: '', sending: 'warn', rejected: 'bad', failed: 'bad', cancelled_by_revocation: 'bad' })[s] || '';

  const enc = new TextEncoder();
  const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  async function hmac(keyData, message) {
    if (!window.crypto?.subtle) throw new Error('Signing in the browser needs a secure context (localhost or https).');
    const key = await crypto.subtle.importKey('raw', typeof keyData === 'string' ? enc.encode(keyData) : keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return crypto.subtle.sign('HMAC', key, enc.encode(message));
  }
  /* The same envelope as src/lib/signing.ts: <event id>.<timestamp>.<raw body>, HMAC-SHA256, hex. */
  const signEnvelope = async (secret, id, ts, body) => hex(await hmac(secret, `${id}.${ts}.${body}`));
  /* The same link as src/lib/document-links.ts: the key is derived from the secret, never the secret itself. */
  async function mintLink(secret, documentId, expiresAt) {
    const key = await hmac(secret, 'document-link.v1');
    return `${documentId}.${expiresAt}.${hex(await hmac(key, `${documentId}.${expiresAt}`))}`;
  }

  async function labState(api) {
    const r = await api('/v1/lab/state');
    if (!r.ok) throw new Error('Could not read the shop state.');
    return r.data;
  }
  async function peerState(api) {
    const r = await api('/v1/lab/peer-state');
    if (!r.ok) throw new Error('Could not read the partner state.');
    return r.data;
  }
  const serverSeconds = (state) => Math.floor(Date.parse(state.now) / 1000);

  /* ---------------------------------------------------------------- hand-over */
  function handoverTab(panel, k) {
    const { api, h, button, badge, box, kv, out, toast } = k;
    const name = h('input', { id: 'h-name', type: 'text' });
    const email = h('input', { id: 'h-email', type: 'text' });
    const taxId = h('input', { id: 'h-tax', type: 'text' });
    const ret = h('select', { id: 'h-return' }, RETURN_URLS.map(([l, v]) => h('option', { value: v }, l)));
    const docs = h('input', { id: 'h-docs', type: 'checkbox', checked: true });
    const consent = h('input', { id: 'h-consent', type: 'checkbox', checked: true });
    const list = h('div', {});
    const partner = h('div', {});
    const results = h('div', {});
    let counter = 0;
    const fill = () => {
      const i = counter % 4;
      counter += 1;
      name.value = ['Ana Souza', 'Bruno Lima', 'Carla Dias', 'Diego Rocha'][i];
      email.value = `${name.value.split(' ')[0].toLowerCase()}@example.com`;
      taxId.value = ['529.982.247-25', '111.444.777-35', '390.533.447-05', '168.995.350-09'][i];
    };
    fill();

    async function refresh() {
      const [shop, peer] = await Promise.all([api('/v1/referrals'), peerState(api).catch(() => null)]);
      if (!shop.ok) throw new Error('Could not list referrals.');
      list.replaceChildren(
        shop.data.length
          ? h('ul', { class: 'trace' }, shop.data.map((r) => h('li', {},
              h('strong', {}, r.customer.name), badge(r.status, statusKind(r.status)), h('code', {}, short(r.id)),
              button(r.partnerIntakeId ? 'Hand over again' : 'Hand over', () => handOver(r), { small: true, variant: r.partnerIntakeId ? 'secondary' : 'primary' }))))
          : h('p', { class: 'hint' }, 'Nothing yet. Record a referral above.'));
      partner.replaceChildren(
        peer?.intakes?.length
          ? h('ul', { class: 'trace' }, peer.intakes.map((i) => h('li', {}, h('strong', {}, i.customer_name), badge(i.status, statusKind(i.status)), h('code', {}, short(i.id)),
              h('span', {}, i.continuation_used_at ? 'link used' : `link valid until ${time(i.continuation_expires_at)}`))))
          : h('p', { class: 'hint' }, 'The partner holds nothing yet.'));
    }

    async function record() {
      const documents = docs.checked ? [
        { kind: 'proof_of_address', filename: 'address.pdf', mime: 'application/pdf', contentBase64: PDF_B64 },
        { kind: 'id_photo', filename: 'id.png', mime: 'image/png', contentBase64: PNG_B64 },
      ] : [];
      const r = await api('/v1/referrals', { method: 'POST', body: { customer: { name: name.value, email: email.value, taxId: taxId.value }, consent: { statusBack: consent.checked }, returnUrl: ret.value, documents } });
      if (!r.ok) { toast(r.data?.error?.message || `Refused (${r.status})`); return; }
      toast('Recorded on the shop side.');
      fill();
      await refresh();
    }

    async function handOver(referral) {
      const r = await api(`/v1/referrals/${referral.id}/handoff`, { method: 'POST' });
      const d = r.data;
      const card = h('div', { class: 'box arrive' });
      if (!r.ok) {
        card.append(h('h3', {}, `Hand-over refused · ${r.status}`), h('p', { class: 'hint' }, d?.error?.message || 'The request failed.'));
      } else {
        const path = new URL(d.continuationUrl).pathname;
        const followOut = h('div', {});
        card.append(
          h('h3', {}, 'Handed over ', badge(d.duplicate ? 'duplicate' : 'created', d.duplicate ? 'warn' : 'ok')),
          kv({ referral: short(referral.id), 'partner intake': short(d.intakeId) }),
          d.documents?.length ? h('ul', { class: 'trace', style: 'margin-top:12px' }, d.documents.map((x) => h('li', {}, h('strong', {}, x.kind), badge(x.outcome, statusKind(x.outcome)), x.reason ? h('code', {}, x.reason) : null))) : h('p', { class: 'hint' }, d.duplicate ? 'A repeat creates nothing, so there is no document list.' : 'No documents attached.'),
          h('h3', { style: 'margin-top:16px' }, 'Single-use link for the person'),
          out(path),
          h('div', { class: 'row' }, button('Follow link', async () => {
            const f = await api('/v1/lab/follow', { method: 'POST', body: { path } });
            const status = f.data?.status;
            followOut.replaceChildren(h('div', { class: 'arrive' }, h('p', {}, badge(String(status), status === 200 ? 'ok' : 'bad'), ' ', status === 200 ? 'The person arrives.' : 'Gone: used, expired, or replaced by a newer link.'), out(JSON.stringify(f.data?.body, null, 2))));
            await refresh();
          }, { small: true, variant: 'primary', ic: 'arrow' })),
          followOut);
      }
      results.prepend(card);
      await refresh();
    }

    panel.append(
      h('div', { class: 'cols' },
        h('div', {},
          box('1 · The shop records a referral', 'A customer, a consent and, optionally, two documents. Nothing leaves the shop yet.',
            h('label', { for: 'h-name' }, 'Name'), name, h('label', { for: 'h-email' }, 'E-mail'), email, h('label', { for: 'h-tax' }, 'Tax id (stored encrypted)'), taxId,
            h('label', { for: 'h-return' }, 'Where the partner may send the person back to'), ret,
            h('div', { class: 'row' }, h('label', { class: 'check' }, docs, ' attach two documents'), h('label', { class: 'check' }, consent, ' person consents to a status update')),
            h('div', { class: 'row' }, button('Record referral', record, { variant: 'primary', ic: 'arrow' }))),
          box('2 · Hand over', 'Each press is one signed hand-over. Press it twice.', list),
          results),
        h('div', {},
          box('What the partner holds', 'Read live from the partner’s own database.', partner,
            h('div', { class: 'row' }, button('Refresh', refresh, { small: true, ic: 'refresh' })))))
    );
    return refresh();
  }

  /* ---------------------------------------------------------------- forge */
  function forgeTab(panel, k) {
    const { api, h, button, badge, box, out } = k;
    let state = null;
    let referrals = [];
    const targetEl = h('select', { id: 'f-target' }, [h('option', { value: 'origin' }, 'The shop (this service)'), h('option', { value: 'partner' }, 'The partner')]);
    const sampleEl = h('select', { id: 'f-sample' });
    const refEl = h('select', { id: 'f-ref' });
    const idEl = h('input', { id: 'f-id', type: 'text' });
    const bodyEl = h('textarea', { id: 'f-body', spellcheck: 'false' });
    const sigEl = h('div', {});
    const log = h('ul', { class: 'trace' });
    const newId = () => { idEl.value = crypto.randomUUID(); };
    newId();

    const samples = {
      lie: { label: 'Decision (a lie: approved)', target: 'origin', build: (ref) => ({ type: 'intake.decided', data: { origin_ref: ref?.id || crypto.randomUUID(), intake_id: ref?.partnerIntakeId || crypto.randomUUID(), status_hint: 'approved' } }) },
      unknown: { label: 'An event type nobody handles', target: 'origin', build: () => ({ type: 'mystery.happened', data: {} }) },
      ssrf: { label: 'Referral with a document on another host', target: 'partner', build: () => ({ type: 'referral.created', data: { origin_ref: crypto.randomUUID(), customer: { name: 'Eve', email: 'eve@example.com', taxId: '390.533.447-05' }, return_url: null, consents: { status_back: false }, documents: [{ kind: 'proof', filename: 'x.pdf', mime: 'application/pdf', size: 120, sha256: 'a'.repeat(64), url: 'http://169.254.169.254/latest/meta-data/' }] } }) },
    };
    for (const [key, s] of Object.entries(samples)) sampleEl.append(h('option', { value: key }, s.label));
    const loadSample = () => {
      const s = samples[sampleEl.value];
      targetEl.value = s.target;
      const ref = referrals.find((r) => r.id === refEl.value);
      bodyEl.value = JSON.stringify(s.build(ref));
    };
    sampleEl.addEventListener('change', () => { newId(); loadSample(); });
    refEl.addEventListener('change', loadSample);

    async function post(label, { body = bodyEl.value, header = 'sign', eventId = idEl.value, timestamp, secret } = {}) {
      state = await labState(api);
      const toPartner = targetEl.value === 'partner';
      const ts = String(timestamp ?? serverSeconds(state));
      const used = secret ?? (toPartner ? state.secrets.out : state.secrets.in);
      const signature = header === null ? null : header === 'sign' ? await signEnvelope(used, eventId, ts, body) : header;
      sigEl.replaceChildren(out(signature === null ? '(no signature header)' : `x-parley-signature: ${signature}\nx-parley-timestamp: ${ts}\nx-parley-event-id: ${eventId}`));
      let status;
      let data;
      if (toPartner) {
        const r = await api('/v1/lab/send-to-peer', { method: 'POST', body: { raw: body, eventId, timestamp: ts, signature } });
        status = r.data?.status;
        data = r.data?.body;
      } else {
        const headers = { 'x-parley-event-id': eventId, 'x-parley-timestamp': ts, 'content-type': 'application/json' };
        if (signature) headers['x-parley-signature'] = signature;
        const r = await api('/v1/events', { method: 'POST', auth: false, body, headers });
        status = r.status;
        data = r.data;
      }
      const msg = data?.result ? JSON.stringify(data.result) : data?.status || data?.error?.message || JSON.stringify(data);
      log.prepend(h('li', { class: 'arrive' }, badge(String(status), status < 300 ? 'ok' : 'bad'), h('strong', {}, label), h('span', {}, msg)));
    }

    async function refresh() {
      const r = await api('/v1/referrals');
      referrals = r.ok ? r.data.filter((x) => x.partnerIntakeId) : [];
      refEl.replaceChildren(...(referrals.length ? referrals.map((x) => h('option', { value: x.id }, `${x.customer.name} · ${short(x.id)} · ${x.status}`)) : [h('option', { value: '' }, 'Hand a referral over first (Hand-over tab)')]));
      loadSample();
    }

    panel.append(
      h('div', { class: 'cols' },
        h('div', {},
          box('Compose an event', 'The browser signs it with the secret the lab exposes, using WebCrypto: HMAC-SHA256 over “id.timestamp.body”.',
            h('label', { for: 'f-sample' }, 'Start from'), sampleEl,
            h('label', { for: 'f-target' }, 'Send it to'), targetEl,
            h('label', { for: 'f-ref' }, 'About this referral'), refEl,
            h('label', { for: 'f-id' }, 'Event id'), idEl,
            h('label', { for: 'f-body' }, 'Body (what gets signed, byte for byte)'), bodyEl,
            h('div', { class: 'row' }, h('button', { type: 'button', class: 'button secondary small', onclick: () => { newId(); loadSample(); } }, 'New event id'))),
          box('Last signature sent', null, sigEl)),
        h('div', {},
          box('Send it', 'Each button sends one request. Compare the answers.',
            h('div', { class: 'row' },
              button('Send valid', () => post('valid signature'), { variant: 'primary', ic: 'arrow' }),
              button('Send again (same id)', () => post('replay of the same event id')),
              button('Tamper with the body', async () => {
                state = await labState(api);
                const ts = serverSeconds(state);
                const secret = targetEl.value === 'partner' ? state.secrets.out : state.secrets.in;
                await post('body edited after signing', { body: bodyEl.value.replace('approved', 'rejected').replace('proof', 'proof2'), header: await signEnvelope(secret, idEl.value, ts, bodyEl.value), timestamp: ts });
              }),
              button('Back-date the timestamp', async () => {
                state = await labState(api);
                await post('timestamp from an hour ago', { timestamp: serverSeconds(state) - 3600 });
              }),
              button('Wrong secret', () => post('signed with another secret', { secret: 'not-the-secret-not-the-secret' })),
              button('No signature', () => post('no signature header', { header: null }))),
            h('p', { class: 'hint' }, 'Tampering, a stale timestamp, a wrong secret and a missing header all get the same generic 401; the reason is only counted on the server. A valid signature on a lie is accepted, then the shop checks the truth.')),
          box('Responses', null, log),
          h('div', { class: 'row' }, button('Refresh referrals', refresh, { small: true, ic: 'refresh' }))))
    );
    return refresh();
  }

  /* ---------------------------------------------------------------- outbox */
  function outboxTab(panel, k) {
    const { api, h, button, badge, box, toast } = k;
    const controls = h('div', {});
    const intakes = h('div', {});
    const queue = h('div', {});
    const shop = h('div', {});
    const dispatchOut = h('div', {});

    async function refresh() {
      const [s, p] = await Promise.all([labState(api), peerState(api)]);
      const down = s.outage !== 'none';
      controls.replaceChildren(
        h('p', { class: 'hint' }, 'The shop is ', badge(s.outage === 'none' ? 'up' : s.outage === 'down' ? 'down (503)' : 'route not deployed (404)', down ? 'bad' : 'ok'), ` · clocks are +${s.clockOffsetSeconds} s`),
        h('div', { class: 'row' },
          button('Take the shop down', async () => { await api('/v1/lab/outage', { method: 'POST', body: { mode: 'down' } }); await refresh(); }, { small: true }),
          button('Answer 404 (not deployed yet)', async () => { await api('/v1/lab/outage', { method: 'POST', body: { mode: 'not_deployed' } }); await refresh(); }, { small: true }),
          button('Bring the shop back', async () => { await api('/v1/lab/outage', { method: 'POST', body: { mode: 'none' } }); await refresh(); }, { small: true, variant: 'primary' })),
        h('div', { class: 'row' }, [['+60 s', 60], ['+2 min', 120], ['+4 min', 240], ['+1 h', 3600]].map(([l, sec]) =>
          button(`Advance clocks ${l}`, async () => { await api('/v1/lab/clock', { method: 'POST', body: { advanceSeconds: sec, target: 'both' } }); await refresh(); }, { small: true, ic: 'clock' }))),
        h('p', { class: 'hint' }, 'Both clocks move together. If only one did, the other side’s ±300 s signature window would refuse the message as coming from the future.'));
      intakes.replaceChildren(
        p.intakes?.length
          ? h('ul', { class: 'trace' }, p.intakes.map((i) => {
              const consent = (p.consents || []).find((c) => c.subject_id === i.id);
              return h('li', {},
                h('strong', {}, i.customer_name), badge(i.status, statusKind(i.status)), h('code', {}, short(i.id)),
                consent ? badge(consent.revoked_at ? 'consent withdrawn' : 'consent given', consent.revoked_at ? 'bad' : 'ok') : badge('no consent', ''),
                i.status === 'pending' ? button('Approve', async () => { await api('/v1/lab/decide', { method: 'POST', body: { intakeId: i.id, decision: 'approved', target: 'peer' } }); await refresh(); }, { small: true, variant: 'primary' }) : null,
                i.status === 'pending' ? button('Reject', async () => { await api('/v1/lab/decide', { method: 'POST', body: { intakeId: i.id, decision: 'rejected', target: 'peer' } }); await refresh(); }, { small: true }) : null,
                consent && !consent.revoked_at ? button('Withdraw consent', async () => { await api('/v1/lab/consent/revoke', { method: 'POST', body: { subjectId: i.id, target: 'peer' } }); toast('Consent withdrawn.'); await refresh(); }, { small: true, variant: 'danger' }) : null);
            }))
          : h('p', { class: 'hint' }, 'Nothing to decide. Hand a referral over first.'));
      queue.replaceChildren(
        p.outbox?.length
          ? h('ul', { class: 'trace' }, p.outbox.map((e) => h('li', {},
              h('code', {}, short(e.id)), badge(e.status, statusKind(e.status)), h('span', {}, `attempt ${e.attempts}`),
              e.status === 'pending' && e.next_attempt_at ? h('span', {}, `next ${time(e.next_attempt_at)}`) : null, e.last_error ? h('code', {}, e.last_error) : null)))
          : h('p', { class: 'hint' }, 'The partner’s outbox is empty.'));
      shop.replaceChildren(
        s.referrals?.length
          ? h('ul', { class: 'trace' }, s.referrals.map((r) => h('li', {}, h('strong', {}, r.customer_name), badge(r.status, statusKind(r.status)), r.status_mismatches ? badge(`${r.status_mismatches} mismatch`, 'warn') : null)))
          : h('p', { class: 'hint' }, 'No referrals on the shop yet.'));
    }

    panel.append(
      h('div', { class: 'cols' },
        h('div', {},
          box('The shop’s availability', 'The decision travels partner → shop, so the shop is the one to take down.', controls),
          box('The partner’s intakes', 'Decide one, withdraw consent on another.', intakes)),
        h('div', {},
          box('The partner’s outbox', 'Press the dispatcher; it only claims what is due.', queue,
            h('div', { class: 'row' }, button('Run dispatcher', async () => {
              const r = await api('/v1/lab/dispatch', { method: 'POST', body: { target: 'peer' } });
              const d = r.data?.peer?.self ?? r.data?.peer ?? {};
              dispatchOut.replaceChildren(h('p', { class: 'hint arrive' }, `claimed ${d.claimed ?? 0} · delivered ${d.delivered ?? 0} · rescheduled ${d.rescheduled ?? 0} · failed ${d.failed ?? 0} · cancelled ${d.cancelled ?? 0}`));
              await refresh();
            }, { variant: 'primary', ic: 'refresh' })), dispatchOut),
          box('What the shop knows', null, shop)))
    );
    return refresh();
  }

  /* ---------------------------------------------------------------- links */
  function linksTab(panel, k) {
    const { api, h, button, badge, box, out, toast } = k;
    const docEl = h('select', { id: 'l-doc' });
    const tokenEl = h('textarea', { id: 'l-token', spellcheck: 'false' });
    const result = h('div', {});
    const accessLog = h('div', {});
    let state = null;

    async function refresh() {
      state = await labState(api);
      const docs = state.documents || [];
      const previous = docEl.value;
      docEl.replaceChildren(...(docs.length ? docs.map((d) => h('option', { value: d.id }, `${d.filename} · ${short(d.id)}${d.revoked_at ? ' · revoked' : ''}`)) : [h('option', { value: '' }, 'Hand a referral over first (with documents)')]));
      if (previous && docs.some((d) => d.id === previous)) docEl.value = previous;
      accessLog.replaceChildren(
        (state.documentAccess || []).length
          ? h('ul', { class: 'trace' }, state.documentAccess.map((a) => h('li', {}, h('code', {}, short(a.document_id)), badge(a.outcome, statusKind(a.outcome) || (a.outcome === 'served' ? 'ok' : 'bad')), h('span', {}, time(a.at)))))
          : h('p', { class: 'hint' }, 'No one has asked for a document yet.'));
    }
    async function mint() {
      await refresh();
      if (!docEl.value) { toast('There is no document to link to yet.'); return; }
      tokenEl.value = await mintLink(state.secrets.out, docEl.value, serverSeconds(state) + 3600);
    }
    async function fetchIt(label) {
      const r = await api(`/v1/documents/${encodeURIComponent(tokenEl.value.trim())}`, { auth: false });
      const ok = r.status === 200;
      result.replaceChildren(h('div', { class: 'box arrive' }, h('h3', {}, label, ' ', badge(String(r.status), ok ? 'ok' : 'bad')),
        h('p', { class: 'hint' }, ok ? `Served ${r.headers.get('content-type')} (${String(r.data).length} characters), as an attachment, never cached.` : r.data?.error?.message || 'Refused.'),
        ok ? null : out(JSON.stringify(r.data))));
      await refresh();
    }
    const edit = (fn) => () => { tokenEl.value = fn(tokenEl.value.trim()); };
    panel.append(
      h('div', { class: 'cols' },
        h('div', {},
          box('1 · Mint a link', 'The browser derives the key from the lab secret and signs “document id.expiry” with it. The shop would do exactly this.',
            h('label', { for: 'l-doc' }, 'Document'), docEl,
            h('div', { class: 'row' }, button('Mint a link (valid 1 h)', mint, { variant: 'primary', ic: 'key' })),
            h('label', { for: 'l-token' }, 'Link (editable)'), tokenEl),
          box('2 · Use it, then abuse it', 'Every refusal returns the same 403 body.',
            h('div', { class: 'row' },
              button('Fetch', () => fetchIt('Fetched'), { variant: 'primary', ic: 'arrow' }),
              button('Change the expiry', async () => { edit((t) => { const [i, e, m] = t.split('.'); return `${i}.${Number(e) + 9999}.${m}`; })(); await fetchIt('Later expiry'); }),
              button('Flip a signature character', async () => { edit((t) => { const p = t.split('.'); const c = p[2][0] === '0' ? '1' : '0'; return `${p[0]}.${p[1]}.${c}${p[2].slice(1)}`; })(); await fetchIt('Altered signature'); })),
            h('div', { class: 'row' },
              button('Advance the shop’s clock 2 h', async () => { await api('/v1/lab/clock', { method: 'POST', body: { advanceSeconds: 7200 } }); await fetchIt('After two hours'); }, { ic: 'clock' }),
              button('Revoke this document', async () => { await api(`/v1/documents/${docEl.value}/revoke`, { method: 'POST' }); toast('Revoked.'); await refresh(); }, { variant: 'danger' })),
            result)),
        h('div', {}, box('Access log', 'The only place the reason for a refusal is written down.', accessLog, h('div', { class: 'row' }, button('Refresh', refresh, { small: true, ic: 'refresh' })))))
    );
    return refresh();
  }

  /* ---------------------------------------------------------------- vault */
  function vaultTab(panel, k) {
    const { api, h, button, badge, box, kv, out, toast } = k;
    const ring = h('div', {});
    const rows = h('div', {});
    const findEl = h('input', { id: 'v-find', type: 'text' });
    findEl.value = '529982247-25';
    const found = h('div', {});

    async function refresh() {
      const s = await labState(api);
      ring.replaceChildren(kv({ 'current key': s.vault.currentVersion, 'rows in the shop': String(s.vault.rows.length) }));
      rows.replaceChildren(
        s.vault.rows.length
          ? h('ul', { class: 'trace' }, s.vault.rows.map((r) => h('li', {}, h('code', {}, short(r.id)), badge(r.version, r.version === s.vault.currentVersion ? 'ok' : 'warn'), badge(r.readable ? 'readable' : 'unreadable', r.readable ? 'ok' : 'bad'), h('code', {}, `${r.tax_id_enc.slice(0, 30)}…`))))
          : h('p', { class: 'hint' }, 'No rows. Record a referral in the Hand-over tab.'));
    }
    const act = (path, msg) => async () => { const r = await api(path, { method: 'POST' }); toast(msg(r.data)); await refresh(); };
    panel.append(
      h('div', { class: 'cols' },
        h('div', {},
          box('Keys', 'The key version is the first part of every stored value, which is what makes rotation possible.', ring,
            h('div', { class: 'row' },
              button('1 · Add a new key', act('/v1/lab/vault/new-key', (d) => `Current key is now ${d.currentVersion}.`), { small: true, variant: 'primary' }),
              button('2 · Rotate rows', act('/v1/lab/vault/rotate', (d) => `Re-encrypted ${d.rotated}, unreadable ${d.unreadable}.`), { small: true }),
              button('3 · Drop old keys', act('/v1/lab/vault/drop-old-keys', () => 'Only the current key is left.'), { small: true, variant: 'danger' }))),
          box('Look someone up without decrypting', 'The blind index is an HMAC under its own key: equal inputs give equal values, nothing else leaks.',
            h('label', { for: 'v-find' }, 'Tax id (any formatting)'), findEl,
            h('div', { class: 'row' }, button('Find', async () => {
              const r = await api('/v1/lab/find', { method: 'POST', body: { taxId: findEl.value } });
              found.replaceChildren(h('div', { class: 'arrive' }, out(JSON.stringify(r.data, null, 2))));
            }, { variant: 'primary', ic: 'search' })), found)),
        h('div', {}, box('Stored values', 'Straight from the table: ciphertext, never the tax id.', rows, h('div', { class: 'row' }, button('Refresh', refresh, { small: true, ic: 'refresh' })))))
    );
    return refresh();
  }

  window.LAB = {
    eyebrow: 'The lab',
    title: 'Try to break it.',
    text: 'Five ways to push on the hand-over, each backed by tests. Two services run on this machine against fictional data; the page talks to the shop and reaches the partner through it.',
    reset: {
      label: 'Start over',
      hint: 'Both databases emptied, clocks back to now, the shop up, the original encryption key restored.',
      done: 'Back to a clean slate.',
      run: async ({ api }) => {
        const r = await api('/v1/lab/reset', { method: 'POST', body: { target: 'both' } });
        if (!r.ok) throw new Error('Could not reset the lab.');
      },
    },
    tabs: [
      { id: 'handover', label: 'Hand-over', icon: 'link', render: (p, k) => handoverTab(p, k) },
      { id: 'forge', label: 'Forge', icon: 'key', render: (p, k) => forgeTab(p, k) },
      { id: 'outbox', label: 'Outbox', icon: 'clock', render: (p, k) => outboxTab(p, k) },
      { id: 'links', label: 'Links', icon: 'doc', render: (p, k) => linksTab(p, k) },
      { id: 'vault', label: 'At rest', icon: 'database', render: (p, k) => vaultTab(p, k) },
    ],
  };

  /* ---------------------------------------------------------------- sign-in (API key) */
  window.SITE.auth.build = async (authPage, session) => {
    const cfgRes = await fetch('/v1/lab/config').catch(() => null);
    const cfg = cfgRes && cfgRes.ok ? await cfgRes.json() : null;
    const modes = {
      login: {
        eyebrow: 'Lab access',
        title: cfg ? 'Enter the lab' : 'Lab mode is off',
        lead: cfg
          ? 'Each service uses one API key, not accounts (by design: see the README limitations). The development key is filled in for you.'
          : 'Start the services with LAB_MODE=true (make demo does) to use the lab. The landing page works without it.',
        fields: [{ name: 'key', label: 'API key', type: 'password', icon: 'key', default: cfg?.default_key_in_use ? 'change-me' : '', placeholder: 'X-API-Key', autocomplete: 'off' }],
        submit: 'Enter the lab',
        busy: 'Checking the key…',
      },
    };
    await authPage({
      modes,
      tag: 'Parley lab',
      bottom: 'Local only. Fictional data. The key never leaves this browser tab.',
      stories: [
        { title: 'Hand a person over twice.', text: 'Press the hand-over again and see what the partner does with the duplicate and with the first link.' },
        { title: 'Lie with a valid signature.', text: 'Sign a decision that was never taken and watch the shop check the truth before it believes you.' },
        { title: 'Take a company down.', text: 'Decide while the shop is unreachable, move the clock, and watch the retries double.' },
      ],
      demo: {
        title: 'Start from a scenario',
        subtitle: 'Pick what you want to try first',
        text: 'This only changes the story on the right; every tab is open to you.',
        label: 'Scenario',
        placeholder: 'Choose a scenario',
        options: [
          { label: 'Integration engineer: duplicates', story: 0, values: {} },
          { label: 'Security reviewer: forge an event', story: 1, values: {} },
          { label: 'SRE: an outage mid-decision', story: 2, values: {} },
        ],
        note: cfg?.default_key_in_use ? 'Development key in use: change-me' : null,
      },
      onSubmit: async (_mode, values) => {
        if (!cfg) throw new Error('Lab mode is off on this server.');
        const res = await fetch('/v1/lab/state', { headers: { 'x-api-key': values.key || '' } });
        if (res.status === 401) throw new Error('That key was not accepted.');
        if (!res.ok) throw new Error(`The server answered ${res.status}.`);
        session.set(values.key);
      },
    });
  };
})();
