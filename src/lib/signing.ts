import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The envelope both sides sign: `<event id>.<timestamp>.<raw body>`, HMAC-SHA256, lowercase hex.
 *
 * Everything outside the MAC is a free variable for whoever intercepts the request:
 *   - body       → proves *what*: the content did not change on the way
 *   - timestamp  → proves *when*: without it a captured request can be re-dated and the window stops protecting
 *   - event id   → proves *which*: without it every copy of a request is a "new" legitimate event
 * The `.` separator matters: without it id="12" ts="345" and id="123" ts="45" sign the same string.
 * The body enters as the bytes that were received, never re-serialised: key order and escapes change the bytes.
 *
 * A signature alone still admits replay inside the window; the de-duplication on the event id closes that.
 * Neither is enough alone.
 */

export const WINDOW_SECONDS = 300;

export const HEADERS = {
  eventId: 'x-parley-event-id',
  timestamp: 'x-parley-timestamp',
  signature: 'x-parley-signature',
} as const;

export const signedString = (eventId: string, timestamp: string | number, rawBody: string | Buffer): string =>
  `${eventId}.${timestamp}.${Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody}`;

export function sign(secret: string, eventId: string, timestamp: string | number, rawBody: string | Buffer): string {
  return createHmac('sha256', secret)
    .update(signedString(eventId, timestamp, rawBody), 'utf8')
    .digest('hex');
}

const HEX_SHA256 = /^[0-9a-f]{64}$/;

/** Constant time. A wrong length is refused before comparing, which leaks nothing: the length of an HMAC is public. */
export function safeEqualHex(a: string, b: string): boolean {
  if (!HEX_SHA256.test(a) || !HEX_SHA256.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/** Why a request was refused. The caller must answer every one of these with the same generic 401. */
export type Refusal = 'malformed' | 'bad_signature' | 'outside_window';

export type Verdict = { ok: true } | { ok: false; reason: Refusal };

export interface VerifyInput {
  /** First is current, the others are still accepted: this is how a secret is rotated without downtime. */
  secrets: readonly string[];
  eventId: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
  rawBody: string | Buffer;
  nowSeconds: number;
  windowSeconds?: number;
}

export function verify(input: VerifyInput): Verdict {
  const { eventId, timestamp, signature, secrets } = input;
  if (!eventId || !timestamp || !signature || secrets.length === 0) return { ok: false, reason: 'malformed' };
  // Seconds, not milliseconds: sending ms is a factor-of-1000 mistake that always lands outside the window.
  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: 'malformed' };

  // Every secret is tried, with no early exit: how long this takes must not say which one matched.
  let matched = false;
  for (const secret of secrets)
    matched = safeEqualHex(sign(secret, eventId, timestamp, input.rawBody), signature) || matched;
  // The signature is checked before the clock. Reporting "expired" for an unsigned request would tell a forger that
  // the format is right and only the date is wrong, and the date is the one field they control.
  if (!matched) return { ok: false, reason: 'bad_signature' };

  // Both directions: a partner whose clock runs fast is as common as one that runs slow.
  const skew = Math.abs(input.nowSeconds - Number(timestamp));
  if (skew > (input.windowSeconds ?? WINDOW_SECONDS)) return { ok: false, reason: 'outside_window' };
  return { ok: true };
}
