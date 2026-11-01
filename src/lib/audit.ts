import type { Clock } from '../clock.js';
import type { Queryable } from '../db.js';

/** A timeline that explains what happened and why, without ever holding personal data or document contents. */
export async function audit(
  db: Queryable,
  clock: Clock,
  kind: string,
  ref: string | null,
  detail: object = {},
): Promise<void> {
  await db.query('INSERT INTO audit_log (at, kind, ref, detail) VALUES ($1, $2, $3, $4)', [
    clock.now(),
    kind,
    ref,
    JSON.stringify(detail),
  ]);
}
