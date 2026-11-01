# ADR 0006: A lab mode that makes failure visible and cannot reach production

Status: Accepted

## Context
The behaviour worth showing (backoff, replay, a withdrawn consent, a lost key) happens over minutes and across two
companies. A visitor cannot wait an hour for the third retry, or forge a request without the secret.

## Decision
- `LAB_MODE` mounts `/v1/lab/*`: a movable clock (`OffsetClock`, forward only), an outage switch for `/v1/events`
  (503 or 404), the exposed signing secrets, a dispatcher button, key-ring controls, and a reset that empties both databases.
- The lab reaches the partner **through the shop**, which calls the partner's own lab routes, and for actions it calls the
  partner's **real** endpoints (`/v1/intakes/:id/decision`), so the lab cannot behave differently from the product.
- **The settings validator refuses `LAB_MODE` when `APP_ENV=production`**, and refuses the default API key there. A test
  pins both. There is no second way in: the routes exist only when the flag is on.
- The browser signs with WebCrypto, so the lab needs a secure context (`localhost` qualifies). The page's Content Security
  Policy forbids inline script and style and any other origin; the e2e suite fails on a console error or a third-party request.
- Both clocks move together. If only one did, the other side's ±300 s window would refuse the message as coming from the future.

## Rejected alternatives
- **Mocks in the test suite only.** The point is that a person can press the button; and a mock cannot show a real 401.
- **A debug flag that is merely documented.** The validator makes the unsafe combination impossible to start.
- **A separate demo build.** Two code paths drift; this is one binary with one flag.

## Consequences
- (+) Every guarantee on the landing page has a button and a test (`test/lab.test.ts`, `e2e/tests/lab.spec.ts`).
- (−) The lab routes expose secrets by design. That is the reason for the validator, and why the README says so first.
