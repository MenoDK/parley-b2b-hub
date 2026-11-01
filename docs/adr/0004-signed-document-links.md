# ADR 0004: Documents leave through our own signed, audited, revocable links

Status: Accepted

## Context
The partner needs the customer's documents, but the shop must not push bytes inside a webhook (size, retries, memory) and
must not hand out links that outlive a decision to withdraw the document.

## Decision
- The hand-over carries a **manifest** (kind, filename, mime, size, sha256, url). The partner pulls each document.
- A link is `<document id>.<expiry>.<hmac>`, one hour. The key is **derived**: `HMAC(secret, "document-link.v1")`, so a
  signed link can never pass as a webhook signature and the reverse. The label carries a version.
- The expiry is checked **after** the signature, so "expired" is never the answer to a token that was never signed.
- Every outcome is written to `document_access` (`served`, `bad_signature`, `expired`, `revoked`, `no_such_document`,
  `malformed`); the caller gets **one** 403 for all of them.
- Revoking the document kills every outstanding link at once, because every access goes through us.
- The partner validates **on its side of the wire**: the URL must be on the origin it already trusts (otherwise a signed
  event could aim it at an internal address: SSRF), the MIME type must be allowed, the size is enforced **while
  streaming** (a lying `content-length` cannot make it buffer a gigabyte), and the SHA-256 must match the manifest.
  Redirects are refused. A rejected document does not fail the intake: it is stored as `rejected` with the reason.
- `SERVICE_URL` (where the other company's *server* reaches us) is separate from `PUBLIC_URL` (where a *browser* does).
  In Docker the first is `http://origin:3000` and the second `http://localhost:8000`; one variable would be wrong for one of them.

## Rejected alternatives
- **Pre-signed URLs from an object store.** No audit of who fetched what, no instant revocation, and the storage layout
  leaks to the other company.
- **Embedding the bytes in the webhook.** Retries re-send megabytes; the receiver's memory sets the limit.
- **One secret for webhooks and links.** An oracle on one weakens the other.
- **Different errors for expired and invalid.** Tells a forger which part of a guess was right.

## Consequences
- (+) `test/handoff.test.ts` covers forgery, expiry, revocation, the access log, SSRF, MIME, size and hash.
- (−) Documents are stored in PostgreSQL (`bytea`) to keep the demo to one dependency. Production would use object
  storage behind the same links; the manifest and the links would not change.
