import type { Clock } from '../clock.js';
import type { Queryable } from '../db.js';

/**
 * Consent is read from the database at the moment of sending, not when the event is queued.
 *
 * It used to be checked once, on the way into the queue, and the payload was frozen. The queue runs every few minutes
 * with backoff of up to an hour, so an event can leave hours after it was queued. If the person withdrew consent in that
 * gap the data left anyway, and "withdraw at any time" quietly meant "until the queue runs". The payload is immutable on
 * purpose (it is what was authorised), so the check cannot read it from there: it has to go to the table, now.
 */

/** Which purpose each event type needs. A type that is not listed is NOT sent: better stuck and visible than leaking. */
export const PURPOSE_BY_EVENT: Readonly<Record<string, string>> = {
  'intake.decided': 'status_back',
};

export type ConsentVerdict = { ok: true } | { ok: false; reason: 'revoked' | 'no_consent' | 'unknown_event_type' };

export async function grantConsent(db: Queryable, clock: Clock, subjectId: string, purpose: string): Promise<void> {
  await db.query(
    `INSERT INTO consents (subject_id, purpose, granted_at) VALUES ($1, $2, $3)
     ON CONFLICT (subject_id, purpose) DO UPDATE SET granted_at = EXCLUDED.granted_at, revoked_at = NULL`,
    [subjectId, purpose, clock.now()],
  );
}

export async function revokeConsent(db: Queryable, clock: Clock, subjectId: string, purpose: string): Promise<boolean> {
  const result = await db.query(
    'UPDATE consents SET revoked_at = $3 WHERE subject_id = $1 AND purpose = $2 AND revoked_at IS NULL',
    [subjectId, purpose, clock.now()],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function consentStillHolds(db: Queryable, subjectId: string, eventType: string): Promise<ConsentVerdict> {
  const purpose = PURPOSE_BY_EVENT[eventType];
  if (!purpose) return { ok: false, reason: 'unknown_event_type' };
  const { rows } = await db.query<{ revoked_at: Date | null }>(
    'SELECT revoked_at FROM consents WHERE subject_id = $1 AND purpose = $2',
    [subjectId, purpose],
  );
  const row = rows[0];
  if (!row) return { ok: false, reason: 'no_consent' };
  return row.revoked_at ? { ok: false, reason: 'revoked' } : { ok: true };
}
