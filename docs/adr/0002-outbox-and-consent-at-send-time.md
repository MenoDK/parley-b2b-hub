# ADR 0002: A transactional outbox that rereads consent when the event leaves

Status: Accepted

## Context
When the partner decides, the shop must be told, even if the shop is down for ten minutes, even if the partner restarts
mid-send, and even if the person withdrew consent while the message was waiting.

## Decision
- The event is **inserted in the same transaction as the decision** (`outbox_events`). Either both exist or neither does;
  there is no window in which a decision was taken and the message was lost.
- A dispatcher claims due rows with `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED LIMIT n) RETURNING …`. Two
  dispatchers running at once (a slow tick makes that happen by itself) never see each other's rows.
- A row left `sending` by a crashed process comes back once its **lease** (`locked_until`) runs out.
- The id of the row **is** the event id, so every retry carries the same id and the receiver's de-duplication has
  something to catch.
- Retries wait 1, 2, 4, … times the base (60 s), capped at an hour, for at most six attempts, then the row stays `failed`
  and visible. Statuses worth retrying are 404, 408, 429 and 5xx. 404 is on the list on purpose: a route that is not
  deployed yet answers 404 for a few seconds on every release, and giving up costs the event.
- **Consent is read from the table at the moment of sending.** If it was withdrawn, the row becomes
  `cancelled_by_revocation`: not `failed`, because "retry the failed ones" must never be able to send data a person
  asked us to stop sending. An event type with no consent purpose is cancelled too (fail closed).
- With no peer configured the dispatcher **claims nothing**. Claiming would spend an attempt of every event per tick
  against a destination that does not exist, and in six ticks the queue would be `failed` because a variable was never set.

## Rejected alternatives
- **Publish to a broker inside the request.** The broker cannot join the database transaction: a crash between the two
  loses the event or sends one for a decision that rolled back.
- **Check consent when enqueuing.** The payload is frozen at that moment and the queue can hold it for an hour, so
  "withdraw at any time" quietly meant "until the queue runs".
- **Mint a new event id per attempt.** Each retry would arrive as a new fact and de-duplication would have nothing to catch.
- **`SELECT … FOR UPDATE` without `SKIP LOCKED`.** Correct, and the second dispatcher queues behind the first: one slow
  tick stalls all of them. A test holds a row lock and requires the batch to return.
- **Mark withdrawn-consent events `failed`.** Buries the proof that we stopped when asked.

## Consequences
- (+) Each rule has a test against real PostgreSQL (`test/outbox.test.ts`) and a mutant (`make mutate`).
- (−) Delivery is at-least-once; the receiver must be idempotent (ADR 0001 makes it so).
- (−) Polling with a timer, not push. Fine at this volume; a worker process is the next step.
