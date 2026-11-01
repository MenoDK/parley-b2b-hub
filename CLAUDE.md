# parley-b2b-hub

Two services standing in for two companies: a shop hands a customer, with documents, to a partner, and the partner's
decision comes back. Signed events, an idempotent hand-over, a consent-aware transactional outbox, signed document links
and encrypted fields. Node 22, TypeScript (strict), Fastify 5, PostgreSQL 16, no ORM.

## Start here

- Map of every document: [docs/00-READ-FIRST.md](docs/00-READ-FIRST.md). Open a document only when the map says to.
- Resuming work: `docs/HANDOFF.md` first; rewrite it before you stop.
- Commands and definition of done: @AGENTS.md

## Layout

- `src/lib/`: the building blocks, each one small and testable alone: `signing`, `inbox`, `outbox`, `consent`, `vault`,
  `document-links`, `return-url`, `peer` (the one place that builds a signed request), `audit`, `http`.
- `src/origin/` (the shop) and `src/partner/`: routes and event handlers for each role. One image, `ROLE` picks the side.
- `src/app.ts` is the composition root; `src/config.ts` is the only reader of the environment.
- `src/lab/routes.ts`: lab mode, off by default and refused in production (ADR 0006).
- `site/`: landing page and lab UI, plain JS and CSS served by the shop when `SITE_DIR` is set. `e2e/`: Playwright tests.
- `scripts/record-transcripts.ts` writes `site/transcripts.js` from the running code; `scripts/mutation-check.mjs` breaks the rules on purpose.

## Rules that apply to every task

1. **Sign the id, the time and the raw bytes; answer every refusal with the same 401.** See ADR 0001.
2. **Claim an event id in the same transaction as its handler, and reply only after COMMIT.** See ADR 0001.
3. **Consent is read when the event leaves, not when it is queued.** Withdrawn consent is `cancelled_by_revocation`,
   never `failed`. See ADR 0002.
4. **The hand-over that is safe to repeat never returns the link.** See ADR 0003.
5. **The partner fetches documents only from the origin it already trusts**, checks MIME, size while streaming, and the hash. See ADR 0004.
6. **Personal fields are encrypted with a versioned key and found by blind index**; there is no plain-text fallback. See ADR 0005.
7. **Lab mode never reaches production.** The settings validator refuses it; do not add another way in. See ADR 0006.
8. **Tests build their own secrets at run time** and use fictitious data only.
9. **The site loads nothing from another origin** and keeps inline script and style out (strict CSP); `make e2e` checks it.
10. **Docs are code.** A new document is added to the map in the same commit; `docsguard check` must pass.

Advice versus enforcement: this file is advice. If `docsguard` is installed, `.claude/settings.json` turns the key rules
into hooks (destructive git is refused, and so are writes to secrets and keys).
