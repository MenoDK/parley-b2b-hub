# Handoff

Updated: 2026-11-01

Rewritten at the end of every session. A fresh session must be able to resume from disk alone.

## 1. What is live

Nothing is deployed. `make demo` runs the stack locally (`origin` with the site on :8000, `partner` on :8001, one
PostgreSQL with a database for each) with the lab on; plain `docker compose up` without `LAB_MODE`/`SITE_DIR` would run the
services as they would run for real.

## 2. Where we stopped

The two services, the landing page and lab UI (`site/`), the browser tests (`e2e/`), the mutation check, delivery files and
documentation are complete and verified; the numbers are in section 8. Open items are in the checklist.

## 3. What the owner does now

Push to GitHub and enable Actions: the workflow in `.github/workflows/ci.yml` is linted but has never run there.

## 4. Deadlines

None.

## 5. What NOT to do

- Do not verify a signature over a re-serialised body, and do not answer different errors per failed check: [ADR 0001](adr/0001-signed-envelope.md).
- Do not check consent when queueing; it is read when the event leaves, and withdrawn consent is `cancelled_by_revocation`, never `failed`: [ADR 0002](adr/0002-outbox-and-consent-at-send-time.md).
- Do not make the idempotent hand-over return the link, and do not store a continuation token in clear: [ADR 0003](adr/0003-handover-is-two-calls.md).
- Do not fetch a document from a URL that is not on the trusted origin, and do not skip the size, MIME or hash check: [ADR 0004](adr/0004-signed-document-links.md).
- Do not add a plain-text fallback to the vault, and do not retire a key before the rows are rotated: [ADR 0005](adr/0005-vault-and-blind-index.md).
- Do not allow `LAB_MODE` with `APP_ENV=production`, and do not mount `/v1/lab` conditionally on anything else: [ADR 0006](adr/0006-a-lab-mode-that-cannot-reach-production.md).
- Do not edit `site/transcripts.js` by hand: `make transcripts` records it from the running code, and a test compares them.
- Do not add a script, font or stylesheet from another origin to `site/`; the Content Security Policy and the e2e suite refuse it.
- Do not hand-edit one language table to "fix" a string and leave the others: `site/i18n/<code>.js` mirrors `content.js` key for key (English is the source and the fallback), and `e2e/tests/i18n.spec.ts` reads the tables. Strings that quote the lab's English buttons stay English on purpose.
- Do not use a bare `ls` in this environment's shell (it is aliased and hangs); use `command ls`.

## 6. Decisions

- Envelope, outbox, hand-over, document links, vault, lab mode: [ADR 0001](adr/0001-signed-envelope.md) to [ADR 0006](adr/0006-a-lab-mode-that-cannot-reach-production.md).

## 7. Learned, not in the code

- A test that sets up concurrency (three dispatchers) can pass without the protection being there, because pooled
  connections open lazily and never overlap. Hold the lock yourself and assert on the outcome; then mutate the code to prove it.
- A mutant that only breaks syntax proves nothing. Each entry in `scripts/mutation-check.mjs` removes one rule and must
  fail one test; the script reports a mutant it can no longer apply instead of skipping it.
- `kit.css` and `kit.js` are shared with the other showcase repositories; the canonical copy is in the first one. Change a
  shared style there and copy it, not here.
- The browser container shares the shop's network namespace so the page is `http://localhost:3000`, a secure context (the
  lab signs with WebCrypto) without a browser flag; the container runs as the caller's user so files are deletable.
- `kit.css`, `kit.js` and `i18n/ui.js` (the page chrome in 14 languages) are shared; the per-language overlays `i18n/<code>.js` belong to each repository. With `?lang=` in the address the saved language lost after a reload; `switchLanguage` now rewrites the parameter.
- Right-to-left: SVG text anchored at its start ran off the artwork card when the page direction leaked into it; the artwork, recorded output and commands are forced left-to-right and a test measures the labels.

## 8. Suite state

Measured on 2026-11-01: 75 tests (36 pure, 39 against a real PostgreSQL with both services running), 44 browser tests
(`make e2e`, against the Compose stack, with axe scans of the landing page and every lab tab in both themes), 16 of 16 mutants
caught (`make mutate`), `biome` and `tsc --strict` clean, `hadolint` and `actionlint` clean.
