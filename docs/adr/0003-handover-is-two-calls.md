# ADR 0003: The hand-over is two calls: one safe to repeat, one that mints the link

Status: Accepted

## Context
The shop hands a person to the partner and the person must continue there. Handing over has to survive a double click, a
reload, a timeout where the shop never learns whether the partner got it, and an attacker who captured the request.

## Decision
1. `referral.created` is **idempotent**: its event id *is* the referral id. A repeat is answered `duplicate` and creates
   nothing at the partner. The partner pulls each document through a signed link, validates it (see ADR 0004), and replies
   with one outcome per document.
2. `intake.continuation` has a **fresh id every time** and asks the partner to mint a link: a 32-byte random token whose
   SHA-256 is stored, valid for 15 minutes, **single use**. A new link replaces the previous one ("latest wins").
- The link answers `410 Gone` for used, expired, replaced and never-existed alike, so a guess learns nothing.
- Only the hash is stored. A database leak cannot replay a link that is still valid.
- The return URL the partner may send the person back to is kept only if its **origin** is on an allow-list: never a prefix
  match (`shop.example.com.evil.test` starts with our domain), never `http` outside loopback in development, never
  credentials in the URL. A refused return URL does not fail the hand-over; the person loses the "back" button.
- The handover timeout on the shop is longer than the partner's budget to fetch documents; the configuration refuses the
  opposite order, because otherwise the shop gives up while the partner is still working and retries into a duplicate.

## Rejected alternatives
- **One call that returns the link.** Then a replay of the captured, correctly signed request would hand its sender a
  working link. With two calls, the idempotent one can only ever answer "duplicate".
- **Return the existing token on a duplicate.** Requires storing the token in clear.
- **A link that stays valid until it expires.** A forwarded e-mail becomes a second login.
- **Redirect to any return URL the shop sends.** An open redirect from a domain the victim trusts.

## Consequences
- (+) Repeating the hand-over is always safe; `test/handoff.test.ts` and the "Hand over twice" challenge show it.
- (−) Two round trips. Cheaper than being wrong, and the person is waiting on documents anyway.
