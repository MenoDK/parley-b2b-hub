# ADR 0005: Versioned field encryption with a blind index, and rotation as a process

Status: Accepted

## Context
A tax id identifies a person. It must not sit in a table in clear text, the service must still be able to find a person by
it, and the key must be replaceable without a maintenance window.

## Decision
- AES-256-GCM, a fresh random 12-byte IV per operation, stored as `v<version>.<base64url(iv ‖ tag ‖ ciphertext)>`. GCM
  is authenticated: a flipped byte makes decryption throw instead of returning garbage.
- **No key, no encryption.** `encrypt` throws; it never falls back to plain text because a variable was missing.
- The **blind index** is `HMAC-SHA256(blind key, normalised value)` under a key that is not the encryption key. Equal inputs
  give equal values and nothing else; the value is normalised first so `529.982.247-25` and `52998224725` find the same row.
- The version in front of the value makes rotation a process: **add** a key in front (old rows stay readable), **re-encrypt**
  rows one by one, and only then **retire** the old key. A row nobody rotated is unreadable after that, and the services
  say so (`(unreadable: key not available)`) instead of failing the whole list.
- The tax id is shown masked everywhere (`•••••••••25`): enough to recognise a row, never enough to use it.

## Rejected alternatives
- **Database-level column encryption.** The key lives next to the data it protects, and lookups need the key anyway.
- **Deterministic encryption for search.** Leaks equality *and* is weaker than a keyed hash for that purpose.
- **A hash without a key for the index.** A tax id has little entropy; an attacker with the table recomputes every value.
- **Re-encrypt everything on every key change in one transaction.** Locks the table; a crash leaves it half-done.

## Consequences
- (+) `test/vault.test.ts` covers tampering, truncation, wrong key, rotation and fail-closed behaviour; the lab lets you
  retire the key too early on purpose.
- (−) The blind index reveals which rows share a value. That is the price of search.
- (−) A per-tenant key with envelope encryption and a managed key service is the production step (listed in the README).
