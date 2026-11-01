#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
/**
 * Breaks each critical rule on purpose, one at a time, and runs the test suite. A mutant that the suite does not notice
 * means a rule that nothing is guarding, so the script exits non-zero when any mutant survives (or cannot be applied).
 *
 *   DATABASE_URL=postgresql://... node scripts/mutation-check.mjs [name fragment...]
 *
 * Each source file is restored afterwards, also on Ctrl-C.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required: the rules under test live in the database queries.');
  process.exit(2);
}

/** [name, file, exact text to find, replacement] */
const MUTANTS = [
  [
    'outbox: claim without SKIP LOCKED',
    'src/lib/outbox.ts',
    '                 FOR UPDATE SKIP LOCKED)',
    '                 )',
  ],
  ['outbox: consent is never re-read', 'src/lib/outbox.ts', 'if (event.subject_id) {', 'if (false as boolean) {'],
  ['outbox: 404 is not retried', 'src/lib/outbox.ts', 'new Set([404, 408,', 'new Set([408,'],
  [
    'outbox: a new event id on every attempt',
    'src/lib/outbox.ts',
    'eventId: event.id,',
    'eventId: crypto.randomUUID(),',
  ],
  [
    'outbox: claims while the peer is unconfigured',
    'src/lib/outbox.ts',
    'if (!this.#peer) {',
    'if (false as boolean) {',
  ],
  [
    'outbox: a crashed dispatcher is never recovered',
    'src/lib/outbox.ts',
    "OR (status = 'sending' AND locked_until < $1)",
    '',
  ],
  [
    'trust: the webhook is believed over the read-back',
    'src/origin/routes.ts',
    '        origin_ref,\n        truth,',
    '        origin_ref,\n        status_hint,',
  ],
  [
    'ssrf: any document host is fetched',
    'src/partner/routes.ts',
    'if (!ctx.peer || new URL(item.url).origin !== new URL(ctx.peer.url).origin)',
    'if (false as boolean)',
  ],
  [
    'documents: the hash is not checked',
    'src/partner/routes.ts',
    "if (sha256(content) !== item.sha256) return { reject: 'hash_mismatch' } as const;",
    '',
  ],
  [
    'continuation: the link works more than once',
    'src/partner/routes.ts',
    'WHERE continuation_hash = $1 AND continuation_used_at IS NULL AND',
    'WHERE continuation_hash = $1 AND',
  ],
  [
    'documents: a revoked document is still served',
    'src/origin/routes.ts',
    "if (doc.revoked_at) return refuse('revoked');",
    '',
  ],
  [
    'links: expiry is checked before the signature',
    'src/lib/document-links.ts',
    "  if (!safeEqualHex(mac(documentId, expiresAt, input.secret), received)) return { ok: false, reason: 'bad_signature' };\n  // Expiry comes after the signature: \"expired\" must never be the answer to a token that was never signed.\n  if (input.nowSeconds > expiresAt) return { ok: false, reason: 'expired' };",
    "  if (input.nowSeconds > expiresAt) return { ok: false, reason: 'expired' };\n  if (!safeEqualHex(mac(documentId, expiresAt, input.secret), received)) return { ok: false, reason: 'bad_signature' };",
  ],
  [
    'inbox: a repeated event id is processed again',
    'src/lib/inbox.ts',
    'ON CONFLICT (peer, event_id) DO NOTHING`',
    'ON CONFLICT (peer, event_id) DO UPDATE SET type = EXCLUDED.type`',
  ],
  [
    'return url: a prefix match instead of the origin',
    'src/lib/return-url.ts',
    'allowedOrigins.includes(target.origin) ? target.toString() : null',
    'allowedOrigins.some((o) => value.startsWith(o)) ? target.toString() : null',
  ],
  [
    'return url: credentials in the url are allowed',
    'src/lib/return-url.ts',
    'if (target.username || target.password) return null;',
    '',
  ],
  [
    'return url: plain http is allowed everywhere',
    'src/lib/return-url.ts',
    "target.protocol !== 'https:' &&",
    'false &&',
  ],
];

const filters = process.argv.slice(2);
const selected = MUTANTS.filter(([name]) => filters.length === 0 || filters.some((f) => name.includes(f)));
const originals = new Map();
const restore = () => {
  for (const [file, text] of originals) writeFileSync(file, text);
  originals.clear();
};
process.on('SIGINT', () => {
  restore();
  process.exit(130);
});

const problems = [];
for (const [name, rel, find, replacement] of selected) {
  const file = new URL(`../${rel}`, import.meta.url).pathname;
  const source = readFileSync(file, 'utf8');
  if (!source.includes(find)) {
    console.log(`CANNOT APPLY  ${name}  (the code moved: update scripts/mutation-check.mjs)`);
    problems.push(name);
    continue;
  }
  originals.set(file, source);
  writeFileSync(file, source.replace(find, replacement));
  try {
    const run = spawnSync('npx', ['vitest', 'run', '--reporter=dot'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 170_000,
    });
    const caught = run.status !== 0;
    console.log(`${caught ? 'caught   ' : 'SURVIVED '} ${name}`);
    if (!caught) problems.push(name);
  } finally {
    restore();
  }
}
console.log(
  `\n${selected.length - problems.length}/${selected.length} caught${problems.length ? `; not caught: ${problems.join('; ')}` : ''}`,
);
process.exit(problems.length ? 1 : 0);
