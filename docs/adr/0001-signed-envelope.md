# ADR 0001: Sign the event id, the timestamp and the exact bytes, and answer every refusal the same way

Status: Accepted

## Context
`POST /v1/events` is how one company tells another that something happened. Anyone who can reach the URL can send a
request, so the receiver has to establish who sent it, that it was not edited, that it is not an old capture, and that a
retry of something it already handled is not handled twice, without telling an attacker which check failed.

## Decision
- The signature is `HMAC-SHA256(secret, "<event id>.<timestamp>.<raw body>")`, lowercase hex, in three headers
  (`x-parley-event-id`, `x-parley-timestamp`, `x-parley-signature`). The `.` separators matter: without them
  `id="12", ts="345"` and `id="123", ts="45"` sign the same string.
- The body enters as the **bytes that were received**. The JSON parser keeps the raw buffer; nothing re-serialises.
- A window of ±300 s bounds how long a capture is useful. The timestamp is inside the MAC, so editing it breaks the signature.
- The event id is claimed with one `INSERT … ON CONFLICT DO NOTHING` in the same transaction as the handler. The first
  caller wins; every other concurrent or later delivery is answered `{"status":"duplicate"}` with a 200.
- Each direction has its own secret. A message signed with the other direction's secret is refused, so a capture of
  what we sent cannot be played back at us.
- `SECRET_IN` is a list: the first entry is current, the others still verify. A secret is rotated without downtime.
- Every refusal (`malformed`, `bad_signature`, `outside_window`) is **one generic 401**. The reason is counted on the
  server, where an operator can read it.
- A handler may refuse the *content* with a `Rejection`. That answers 422 and **keeps the claim** (inside a savepoint, so
  the handler's writes are undone), so a sender that retries a deterministic rejection gets the same answer instead of a
  second attempt. Any other error rolls the whole transaction back, claim included, and the sender retries.
- The reply is sent only after `COMMIT`. A sender must never be told "accepted" about something that was rolled back.
- A signed event of a type nobody handles is refused 422 **without** claiming its id.

## Rejected alternatives
- **A bearer token header.** Replayable, and says nothing about the body.
- **The timestamp in a separate, unsigned header.** An old capture could be refreshed by editing it.
- **Re-serialising the parsed body before verifying.** Key order and escapes change the bytes; the symptom is a
  signature that fails only for some senders.
- **Check-then-set for de-duplication.** Two concurrent deliveries both pass the check. The claim has to be one statement.
- **A distinct error per failed check.** Helpful to a sender while debugging, and equally helpful to an attacker learning
  which check to defeat.
- **One shared secret for both directions.** Convenient, and it turns every captured message into a valid one for its sender.
- **Releasing the claim on every error.** A malformed event would be redelivered for ever.

## Consequences
- (+) Replay, tampering, forgery and double delivery each have a named defence and a test
  (`test/signing.test.ts`, `test/trust.test.ts`); `make mutate` removes the claim and a test fails.
- (−) Sender and receiver clocks must agree within the window. The lab moves both clocks together for that reason.
- (−) The inbox table grows without bound; a retention job is listed under "Not built yet".
