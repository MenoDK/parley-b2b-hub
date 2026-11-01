# Master checklist

_What_ and _when_. The _how_ lives in the code and tests, the _why_ in the [ADRs](adr/README.md).

| #   | Item                                                                       | Status  | Evidence                                                                                  |
| --- | -------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------- |
| 1   | Signed envelope (id, time, raw bytes), replay window, one generic 401      | done    | [ADR 0001](adr/0001-signed-envelope.md), `test/signing.test.ts`, `test/trust.test.ts`     |
| 2   | Atomic event claim in the handler's transaction; reply after COMMIT         | done    | [ADR 0001](adr/0001-signed-envelope.md), `test/trust.test.ts`                             |
| 3   | Transactional outbox: `SKIP LOCKED`, lease, doubling backoff, stable id     | done    | [ADR 0002](adr/0002-outbox-and-consent-at-send-time.md), `test/outbox.test.ts`            |
| 4   | Consent reread at send time; `cancelled_by_revocation`                      | done    | [ADR 0002](adr/0002-outbox-and-consent-at-send-time.md), `test/outbox.test.ts`            |
| 5   | Idempotent hand-over; single-use hashed continuation link; return-URL allow-list | done | [ADR 0003](adr/0003-handover-is-two-calls.md), `test/handoff.test.ts`, `test/return-url.test.ts` |
| 6   | Signed, audited, revocable document links; SSRF, MIME, size and hash checks | done    | [ADR 0004](adr/0004-signed-document-links.md), `test/handoff.test.ts`                     |
| 7   | "The webhook is a hint": status read back, mismatches counted               | done    | `test/trust.test.ts`                                                                      |
| 8   | Field encryption with key versions, blind index, rotation                   | done    | [ADR 0005](adr/0005-vault-and-blind-index.md), `test/vault.test.ts`, `test/lab.test.ts`   |
| 9   | Lab mode, landing page and lab UI, refused in production                    | done    | [ADR 0006](adr/0006-a-lab-mode-that-cannot-reach-production.md), `test/lab.test.ts`, `site/` |
| 10  | Landing page tour recorded from the running code, with a drift test         | done    | `scripts/record-transcripts.ts`, `test/transcripts.test.ts`                               |
| 11  | Mutation check of the critical rules                                        | done    | `scripts/mutation-check.mjs`, `make mutate`                                               |
| 12  | Containers and health-gated compose (one PostgreSQL, a database per company) | done  | `Dockerfile`, `docker-compose.yml`                                                        |
| 13  | Browser tests with accessibility scans, against the real stack              | done    | `e2e/`, `make e2e`                                                                        |
| 14  | CI workflow                                                                 | written | `.github/workflows/ci.yml`: linted with actionlint, not yet run on GitHub                 |
| 15  | Documents in object storage instead of `bytea`                              | todo    | README "Limitations"; the manifest and the links would not change                          |
| 16  | Retention for `inbox_events`, `audit_log` and `document_access`             | todo    | README "Limitations"                                                                      |
| 17  | A key per tenant (envelope encryption) and a managed key service           | todo    | ADR 0005                                                                                  |
| 18  | A worker process for the dispatcher                                         | todo    | ADR 0002                                                                                  |

Status is one of `todo`, `doing`, `done`, `written` (exists, not yet exercised where it will run), `dropped`.
