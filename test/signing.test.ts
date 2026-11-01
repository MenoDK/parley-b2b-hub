import { describe, expect, it } from 'vitest';
import { safeEqualHex, sign, signedString, verify } from '../src/lib/signing.js';
import { fresh } from './helpers.js';

const secret = fresh();
const body = '{"type":"referral.created","data":{"n":1}}';
const NOW = 1_800_000_000;
const good = () => ({
  secrets: [secret],
  eventId: 'evt-1',
  timestamp: String(NOW),
  signature: sign(secret, 'evt-1', NOW, body),
  rawBody: body,
  nowSeconds: NOW,
});

describe('signature envelope', () => {
  it('accepts what was signed', () => {
    expect(verify(good())).toEqual({ ok: true });
  });

  it('covers the body, the timestamp and the event id: changing any one is refused', () => {
    expect(verify({ ...good(), rawBody: `${body} ` })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verify({ ...good(), timestamp: String(NOW + 1) })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verify({ ...good(), eventId: 'evt-2' })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('the separator keeps neighbouring (id, timestamp) pairs apart', () => {
    expect(signedString('12', '345', 'x')).not.toBe(signedString('123', '45', 'x'));
    expect(sign(secret, '12', '345', 'x')).not.toBe(sign(secret, '123', '45', 'x'));
  });

  it('signs bytes: the same object serialised differently does not verify', () => {
    const reordered = '{"data":{"n":1},"type":"referral.created"}';
    expect(verify({ ...good(), rawBody: reordered })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('refuses a wrong secret and a missing piece', () => {
    expect(verify({ ...good(), secrets: [fresh()] })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verify({ ...good(), signature: undefined })).toEqual({ ok: false, reason: 'malformed' });
    expect(verify({ ...good(), eventId: undefined })).toEqual({ ok: false, reason: 'malformed' });
    expect(verify({ ...good(), secrets: [] })).toEqual({ ok: false, reason: 'malformed' });
  });

  it('the window is symmetric: a partner clock that runs fast is as acceptable as one that runs slow', () => {
    const at = (offset: number) => ({
      ...good(),
      timestamp: String(NOW + offset),
      signature: sign(secret, 'evt-1', NOW + offset, body),
    });
    expect(verify(at(300)).ok).toBe(true);
    expect(verify(at(-300)).ok).toBe(true);
    expect(verify(at(301))).toEqual({ ok: false, reason: 'outside_window' });
    expect(verify(at(-301))).toEqual({ ok: false, reason: 'outside_window' });
  });

  it('milliseconds are refused as malformed rather than silently landing outside the window', () => {
    expect(verify({ ...good(), timestamp: String(NOW * 1000) })).toEqual({ ok: false, reason: 'malformed' });
  });

  it('a forged request is "bad signature" whatever its date says: expiry is not an oracle', () => {
    const forged = { ...good(), signature: 'a'.repeat(64), timestamp: String(NOW - 10_000) };
    expect(verify(forged)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('a rotated secret keeps working until it is removed from the list', () => {
    const previous = fresh();
    const signedWithOld = { ...good(), signature: sign(previous, 'evt-1', NOW, body) };
    expect(verify({ ...signedWithOld, secrets: [secret, previous] }).ok).toBe(true);
    expect(verify({ ...signedWithOld, secrets: [secret] }).ok).toBe(false);
  });

  it('compares in constant time and refuses anything that is not 64 lowercase hex characters', () => {
    expect(safeEqualHex('a'.repeat(64), 'a'.repeat(64))).toBe(true);
    expect(safeEqualHex('a'.repeat(64), 'b'.repeat(64))).toBe(false);
    expect(safeEqualHex('a'.repeat(63), 'a'.repeat(63))).toBe(false);
    expect(safeEqualHex('A'.repeat(64), 'A'.repeat(64))).toBe(false);
  });
});
