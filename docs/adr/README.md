# Architecture decision records

Each record states the problem, what was chosen, **what was rejected and why**, and the cost that was accepted.

| # | Decision |
|---|----------|
| [0001](0001-signed-envelope.md) | Sign the event id, the timestamp and the exact bytes, and answer every refusal the same way |
| [0002](0002-outbox-and-consent-at-send-time.md) | A transactional outbox that rereads consent when the event leaves |
| [0003](0003-handover-is-two-calls.md) | The hand-over is two calls: one safe to repeat, one that mints the link |
| [0004](0004-signed-document-links.md) | Documents leave through our own signed, audited, revocable links |
| [0005](0005-vault-and-blind-index.md) | Versioned field encryption with a blind index, and rotation as a process |
| [0006](0006-a-lab-mode-that-cannot-reach-production.md) | A lab mode that makes failure visible and cannot reach production |

A record is never rewritten to hide a reversal: a new record supersedes it and the old one says so
(`Superseded by: ADR NNNN`). Template and rules: the `adr` skill in `.claude/skills/adr/`.
