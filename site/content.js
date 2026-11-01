/* Content for the landing page and the lab. Everything the page says about behaviour is backed by a test; the output in
   the tour is recorded from the running services (scripts/record-transcripts.ts) and a test fails if it drifts. */
window.SITE = {
  name: 'parley-b2b-hub',
  short: 'Parley',
  title: 'parley-b2b-hub · a hand-over between two companies that does not fail quietly',
  logo: 'link',
  repo: 'https://github.com/MenoDK/parley-b2b-hub',
  accent: {
    light: { fill: '#8a7cf5', ink: '#4a3bc4', on: '#14103a', soft: '#e9e6fd', onNavy: '#a99dff' },
    dark: { fill: '#9a8ff7', ink: '#b6adff', on: '#12103a', soft: '#262058', onNavy: '#a99dff' },
  },
  loading: {
    context: 'B2B hand-over',
    title: 'Opening the channel',
    text: 'Checking the shared secrets, the outbox and the other company.',
    icon: 'link',
    satellites: ['lock', 'clock', 'doc'],
    foot: 'Local demo · two services on this machine',
    sketch: 'M12 120C60 40 100 150 168 78S290 24 330 96',
  },
  lab: { href: 'lab.html', cta: 'Enter the lab', signin: 'Sign in' },
  auth: { header: 'x-api-key' },

  hero: {
    eyebrow: 'B2B integration · signed, retried, audited',
    lead: 'Hand a customer to another company',
    soft: 'without losing, leaking or doubling anything.',
    text: 'Two services stand in for two companies. A shop hands a customer, with documents, to a partner; the partner decides and tells the shop. Every message is signed and counted once, delivery survives outages, and a withdrawn consent stops the data even when it is already in the queue.',
    primary: { label: 'Open the lab', href: 'lab.html' },
    secondary: { label: 'See how it works', href: '#tour', icon: 'layers' },
    pilot: 'Runs on your laptop · two services and a database, no accounts',
    proof: [
      { icon: 'lock', a: 'Documents travel by', b: 'signed, expiring links' },
      { icon: 'flask', a: 'Every guarantee has a test', b: 'that tries to break it' },
    ],
    top: ['PARLEY', 'Signed, retried, never believed blindly.'],
    status: { icon: 'link', small: 'Last decision', strong: 'Queued with the decision. Delivered on the 4th try, once.' },
    art: `<svg viewBox="0 50 500 620" role="img" aria-label="A shop and a partner exchanging signed messages: a sealed envelope crosses from the shop to the partner, and a question comes back to check the answer. Below, an outbox shows one event sent, one waiting to retry and one cancelled because consent was withdrawn.">
      <g class="a-line"><path d="M0 120H500M0 240H500M0 360H500M0 480H500M0 600H500M100 30V700M250 30V700M400 30V700"/></g>
      <circle cx="250" cy="300" r="190" class="a-soft"/>

      <g>
        <rect x="26" y="150" width="124" height="150" rx="18" class="a-body"/>
        <path d="M26 186h124" class="a-line"/>
        <path d="M40 174h96" class="a-line"/>
        <rect x="44" y="204" width="28" height="22" rx="5" class="a-line"/>
        <rect x="80" y="204" width="28" height="22" rx="5" class="a-line"/>
        <rect x="116" y="204" width="20" height="22" rx="5" class="a-line"/>
        <rect x="62" y="248" width="52" height="52" rx="8" class="a-line"/>
        <text x="88" y="140" text-anchor="middle" class="a-text">SHOP</text>
      </g>
      <g>
        <rect x="350" y="150" width="124" height="150" rx="18" class="a-body"/>
        <path d="M350 186h124" class="a-line"/>
        <path d="M364 174h96" class="a-line"/>
        <rect x="368" y="204" width="88" height="14" rx="5" class="a-line"/>
        <rect x="368" y="230" width="88" height="14" rx="5" class="a-line"/>
        <rect x="368" y="256" width="56" height="14" rx="5" class="a-line"/>
        <circle cx="440" cy="263" r="6" class="a-accent pulse"/>
        <text x="412" y="140" text-anchor="middle" class="a-text">PARTNER</text>
      </g>

      <path d="M158 198H342" class="a-dash"/>
      <path d="M158 252H342" class="a-dash"/>
      <g class="travel"><rect x="186" y="190" width="24" height="16" rx="3" class="a-accent"/><path d="M186 190l12 9 12-9z" class="a-body"/></g>
      <g class="travel b"><rect x="256" y="190" width="24" height="16" rx="3" class="a-accent"/><path d="M256 190l12 9 12-9z" class="a-body"/></g>
      <g transform="rotate(180 250 252)"><g class="travel"><circle cx="190" cy="252" r="7" class="a-accent-s"/></g><g class="travel b"><circle cx="260" cy="252" r="7" class="a-accent-s"/></g></g>
      <circle cx="250" cy="198" r="15" class="a-body"/>
      <path d="M243 198l5 5 9-10" class="a-accent-s"/>
      <text x="250" y="170" text-anchor="middle" class="a-text-s">HMAC · ±300 s</text>
      <text x="250" y="284" text-anchor="middle" class="a-text-s">read back, not believed</text>

      <g>
        <rect x="70" y="352" width="360" height="176" rx="20" class="a-body"/>
        <text x="94" y="384" class="a-text">OUTBOX</text>
        <path d="M94 396H406" class="a-line"/>
        <circle cx="100" cy="424" r="6" class="a-accent"/>
        <text x="120" y="428" class="a-text-s">sent · same id on every retry</text>
        <circle cx="100" cy="458" r="6" class="a-accent pulse"/>
        <text x="120" y="462" class="a-text-s">retry in 2 min · attempt 3 of 6</text>
        <circle cx="100" cy="492" r="6" class="a-bad-f"/>
        <text x="120" y="496" class="a-text-s">cancelled · consent withdrawn</text>
      </g>
      <g>
        <rect x="140" y="556" width="220" height="40" rx="12" class="a-body"/>
        <path d="M160 576h26M160 584h18" class="a-line"/>
        <text x="198" y="581" class="a-text-s">link expires in 1 h</text>
      </g>
    </svg>`,
  },

  principles: {
    lead: ['Built to survive', 'the other side.'],
    items: [
      ['key', 'Signs everything'],
      ['refresh', 'Retries safely'],
      ['eye', 'Believes nothing'],
      ['flask', 'Proven by tests'],
    ],
  },

  tour: {
    eyebrow: 'A tour of the whole thing',
    title: ['Five things that go wrong', 'between two companies.'],
    text: 'Pick a tab. The output below is recorded from the two running services with fictional data; a test fails if it ever stops being true.',
    tag: 'Recorded output',
    tabs: [
      {
        id: 'handover',
        label: 'Hand-over',
        icon: 'link',
        title: 'Hand a person over once, however many times you ask.',
        text: 'The hand-over is two signed calls: one that is safe to repeat and one that mints a single-use link. A repeat creates nothing, and the first link dies the moment the second exists.',
        lab: 'lab.html#handover',
        transcript: (window.TRANSCRIPTS || {}).handover || '',
      },
      {
        id: 'signing',
        label: 'Signing',
        icon: 'key',
        title: 'Forgery, tampering and replay get the same blank wall.',
        text: 'The signature covers the event id, the timestamp and the exact bytes of the body. The id is claimed atomically, and every refusal is one generic 401.',
        lab: 'lab.html#forge',
        transcript: (window.TRANSCRIPTS || {}).signing || '',
      },
      {
        id: 'outbox',
        label: 'Outbox',
        icon: 'clock',
        title: 'The decision survives the other side being down.',
        text: 'It is queued in the same transaction as the decision, retried with doubling waits under one event id, and cancelled, not failed, if the person withdraws consent before it leaves.',
        lab: 'lab.html#outbox',
        transcript: (window.TRANSCRIPTS || {}).outbox || '',
      },
      {
        id: 'trust',
        label: 'Trust',
        icon: 'eye',
        title: 'A signed message is a hint. The truth is read back.',
        text: 'A correctly signed lie changes nothing, because the shop asks the partner what the status really is, and counts the mismatch. Documents leave only through signed, revocable, audited links.',
        lab: 'lab.html#forge',
        transcript: (window.TRANSCRIPTS || {}).trust || '',
      },
      {
        id: 'atrest',
        label: 'At rest',
        icon: 'database',
        title: 'Personal data is encrypted, searchable and rotatable.',
        text: 'AES-256-GCM with the key version in front, a blind index for lookups, and a rotation that is a process: add a key, re-encrypt, only then retire the old one.',
        lab: 'lab.html#vault',
        transcript: (window.TRANSCRIPTS || {}).atRest || '',
      },
    ],
    modulesTitle: 'Everything in the box.',
    modulesNote: 'Each one has a test file and a place in the lab',
    modules: [
      ['key', 'Signed envelope', 'HMAC-SHA256 over id, timestamp and raw body, a replay window, constant-time comparison and secrets that rotate without downtime.'],
      ['refresh', 'Transactional outbox', 'Row claims with SKIP LOCKED, doubling backoff, a lease for crashed dispatchers and a stable event id across retries.'],
      ['users', 'Consent at send time', 'Consent is read when the event leaves, not when it was queued, so withdrawing it works even for events already waiting.'],
      ['link', 'Idempotent hand-over', 'Repeating it creates nothing. A separate call mints the single-use, hashed, expiring continuation link, and the latest one wins.'],
      ['doc', 'Signed document links', 'Derived key, expiry checked after the signature, every outcome logged, one answer for every refusal and instant revocation.'],
      ['fingerprint', 'Vault and blind index', 'Versioned AES-256-GCM for personal fields and an HMAC index under a separate key, so lookups never decrypt a table.'],
    ],
    transparency: {
      strong: 'Honest about the demo.',
      text: 'Both “companies” run here, in one Compose project, each with its own database. The documents are stored in PostgreSQL to keep the demo to one dependency; production would put them in object storage behind the same links. The limitations list in the README is complete.',
    },
  },

  challenges: {
    eyebrow: 'The hard parts',
    title: ['Go on,', 'try to break it.'],
    text: 'These are the seven things that are easy to claim and hard to get right. Each has a recipe, what you should see, and a button that opens the lab on that exact tab.',
    items: [
      {
        label: 'Hand over twice',
        icon: 'link',
        access: 'Lab · Hand-over',
        title: 'Double-click the hand-over, then use the first link.',
        text: 'Retries are normal. Duplicates are the bug.',
        steps: [
          'In <code>Hand-over</code>, record a referral and press “Hand over”.',
          'Press “Hand over” again, then press “Follow link” on the first card.',
          'Follow the new link, then follow it a second time.',
        ],
        expect: 'The second hand-over says <code>duplicate: true</code> and the partner still has one intake. The first link answers 410, the new link works once, and a second visit answers 410 with the same message as a link that never existed.',
        lab: 'lab.html#handover',
      },
      {
        label: 'Lie with a valid signature',
        icon: 'eye',
        access: 'Lab · Forge',
        title: 'Make the shop believe a decision that was never taken.',
        text: 'Signatures prove who sent a message, not that it is true.',
        steps: [
          'Hand a referral over in the <code>Hand-over</code> tab. Leave it undecided.',
          'In <code>Forge</code>, choose “Decision (a lie: approved)” and press “Send valid”.',
          'Read the response, then open the referrals list on the shop side.',
        ],
        expect: 'The event is accepted, but the response says <code>applied: pending</code> and <code>mismatch: true</code>. The shop read the real status from the partner, kept it, and counted the lie.',
        lab: 'lab.html#forge',
      },
      {
        label: 'Take a company down',
        icon: 'clock',
        access: 'Lab · Outbox',
        title: 'Decide while the shop is down, then bring it back.',
        text: 'A queue is only believable once you have watched it wait.',
        steps: [
          'In <code>Outbox</code>, switch the shop off, pick an undecided intake and press “Approve”.',
          'Press “Run dispatcher” three times with “Advance the clock” in between (60 s, then 120 s).',
          'Switch the shop on, advance 240 s and run the dispatcher once more.',
        ],
        expect: 'Attempts 1, 2, 3 with waits of 60, 120, 240 seconds, nothing claimed when you run early, then <code>sent</code> on attempt 4 and exactly one inbox row on the shop under one event id.',
        lab: 'lab.html#outbox',
      },
      {
        label: 'Withdraw consent mid-queue',
        icon: 'users',
        access: 'Lab · Outbox',
        title: 'Take the permission back after the event was queued.',
        text: 'Consent that is only checked on the way in is consent until the queue runs.',
        steps: [
          'Switch the shop off, approve an intake, and run the dispatcher so the event is waiting to retry.',
          'Press “Withdraw consent” on that intake, then switch the shop on and advance the clock.',
          'Run the dispatcher and look at the row.',
        ],
        expect: 'The row becomes <code>cancelled_by_revocation</code>, not <code>failed</code>, and the shop never learns the decision. The data stopped because the person asked.',
        lab: 'lab.html#outbox',
      },
      {
        label: 'Steal a document link',
        icon: 'doc',
        access: 'Lab · Links',
        title: 'Reuse, alter and outlive a signed link.',
        text: 'A link is a bearer secret. See what it cannot do.',
        steps: [
          'In <code>Links</code>, pick a document and press “Mint a link”. Fetch it.',
          'Change the expiry, then change one character of the signature, then advance the clock two hours.',
          'Revoke the document and fetch the original link again.',
        ],
        expect: 'The valid link serves the file once. Every other attempt gets 403 with the same body; the reasons (<code>bad_signature</code>, <code>expired</code>, <code>revoked</code>) appear only in the access log.',
        lab: 'lab.html#links',
      },
      {
        label: 'Point it at your network',
        icon: 'alert',
        access: 'Lab · Forge',
        title: 'Send a hand-over whose document lives somewhere else.',
        text: 'Fetching a URL that arrives in a payload is server-side request forgery.',
        steps: [
          'In <code>Forge</code>, pick the target “Partner” and the sample “Referral with a document on another host”.',
          'Press “Send valid”: the signature is correct.',
          'Read the document outcomes in the response.',
        ],
        expect: 'The referral is accepted and the document is <code>rejected: url_not_allowed</code>. The partner never opened a connection to the address, because only the origin it already trusts is allowed.',
        lab: 'lab.html#forge',
      },
      {
        label: 'Lose the key',
        icon: 'database',
        access: 'Lab · At rest',
        title: 'Retire the old key before re-encrypting.',
        text: 'Rotation is a process. Skip a step and the data is gone.',
        steps: [
          'In <code>At rest</code>, add a new key. The old rows stay readable.',
          'Press “Drop old keys” without rotating.',
          'Look at the rows, then use “Start over” and repeat with “Rotate rows” first.',
        ],
        expect: 'Rows written under the old key show <code>readable: false</code> after the drop; with the rotation first they all read under the new key. The blind index never changed, so lookups work either way.',
        lab: 'lab.html#vault',
      },
    ],
  },

  run: {
    eyebrow: 'Run it in a minute',
    title: ['One command.', 'Both companies on localhost.'],
    text: 'You need Docker. There are no API keys, no accounts to create and nothing leaves your machine.',
    steps: [
      ['terminal', 'Clone', 'git clone, then cd into the folder.'],
      ['play', 'Start', 'make demo builds the image and starts the shop, the partner and PostgreSQL, health-gated.'],
      ['globe', 'Open', 'http://localhost:8000 is this page. Press “Enter the lab”.'],
      ['flask', 'Break it', 'Use the hard parts above, or run make e2e for the browser suite.'],
    ],
    terminal: {
      title: 'bash',
      lines: [
        '# 1. get the code',
        'git clone https://github.com/MenoDK/parley-b2b-hub.git',
        'cd parley-b2b-hub',
        '# 2. start the shop, the partner and PostgreSQL',
        'make demo',
        '# 3. open http://localhost:8000 and press “Enter the lab”',
        '# optional: the browser tests against the same stack',
        'make e2e',
      ],
    },
  },

  under: {
    eyebrow: 'Under the hood',
    title: ['A small surface,', 'serious edges.'],
    text: 'The interesting code is short on purpose. The decisions behind it are written down with the alternatives that lost.',
    stackTitle: 'What it is built with',
    stack: [
      { group: 'Service', items: ['Node 22 · TypeScript (strict)', 'Fastify 5', 'zod', 'no ORM: SQL you can read'] },
      { group: 'Data', items: ['PostgreSQL 16', 'FOR UPDATE SKIP LOCKED', 'Partial indexes', 'One database per company'] },
      { group: 'Security', items: ['HMAC-SHA256 envelope', 'AES-256-GCM + blind index', 'Signed, derived-key links', 'Strict CSP on the demo'] },
      { group: 'Quality', items: ['Vitest on real PostgreSQL', 'Mutation checks on the invariants', 'Playwright + axe', 'Biome · tsc --strict'] },
      { group: 'Delivery', items: ['Multi-stage Dockerfile, non-root', 'Compose, health-gated', 'GitHub Actions · gitleaks'] },
    ],
    proofTitle: 'What is measured, and the records behind it',
    numbers: [
      ['74', 'tests, 38 of them on a real PostgreSQL with both services running'],
      ['16', 'mutants of the critical rules, all caught by a test'],
      ['6', 'decision records, each with rejected alternatives'],
      ['0', 'errors under tsc --strict'],
    ],
    decisions: [
      ['Sign the id, the time and the bytes', 'ADR 0001: why the envelope has three parts and why one 401 covers every refusal.', 'docs/adr/0001-signed-envelope.md'],
      ['An outbox that rereads consent', 'ADR 0002: why the check moved from enqueue time to send time.', 'docs/adr/0002-outbox-and-consent-at-send-time.md'],
      ['Two calls, not one, for the hand-over', 'ADR 0003: why a repeat cannot return the link, and what was rejected instead.', 'docs/adr/0003-handover-is-two-calls.md'],
      ['Our own signed document links', 'ADR 0004: audit, revocation and a derived key.', 'docs/adr/0004-signed-document-links.md'],
    ],
    measuredOn: 'Measured on 2026-11-01. Counts come from the commands in the README, not from memory.',
    future: [
      ['Object storage', 'for documents, behind the same signed links.'],
      ['A key per tenant', 'with envelope encryption and a managed key service.'],
      ['A worker process', 'for the dispatcher once one instance is not enough.'],
    ],
  },

  about: {
    why: 'Parley is the integration side of my work: two systems owned by different companies that have to agree on what happened. The ideas come from systems I have built and operated; the code in this repository is written fresh and tested.',
  },

  faq: [
    ['Is there a real sign-up?', 'No, on purpose. Each service uses one API key (see the limitations in the README); accounts and tenants live in bulkhead-saas. The lab still shows the same sign-in screen and fills in the development key for you.'],
    ['Why a PostgreSQL outbox and not a message broker?', 'Because the event has to commit with the business change, and a broker cannot join that transaction. A broker is a fine next step at higher volume, behind the same Outbox class. ADR 0002 has the reasoning.'],
    ['What happens if the same event arrives twice?', 'The id is claimed with one INSERT ... ON CONFLICT DO NOTHING in the same transaction as the handler, so exactly one of any number of concurrent deliveries wins and the rest are answered “duplicate”.'],
    ['Can the lab mode reach production?', 'No. The settings validator refuses LAB_MODE when APP_ENV is production, and a test pins that. The clock, the outage switch and the exposed secrets do not exist outside it.'],
    ['Is it production-ready?', 'It is built and tested to that standard: strict types, real-database tests, mutation checks. It has not carried real traffic, and what it lacks is listed under “Not built yet” and in the README limitations.'],
  ],

  closing: {
    eyebrow: 'Your turn',
    title: ['Try to make the other side', 'believe something false.'],
    button: 'Open the lab',
    fine: 'Local only · fictional data · nothing is sent anywhere',
  },
};
