import { describe, expect, it } from 'vitest';
import { RETRYABLE_STATUS, backoffMs } from '../src/lib/outbox.js';

describe('outbox rules', () => {
  it('backs off 1, 2, 4, 8, 16, 32 times the base and stops growing at the cap', () => {
    const base = 60_000;
    expect([1, 2, 3, 4, 5, 6].map((n) => backoffMs(n, base, 3_600_000) / base)).toEqual([1, 2, 4, 8, 16, 32]);
    expect(backoffMs(7, base, 3_600_000)).toBe(3_600_000);
    expect(backoffMs(40, base, 3_600_000)).toBe(3_600_000);
  });

  it('retries 404 (a route that is not deployed yet looks identical to a wrong path) and the usual transient statuses', () => {
    for (const status of [404, 408, 429, 500, 502, 503, 504]) expect(RETRYABLE_STATUS.has(status)).toBe(true);
  });

  it('does not retry what insisting cannot fix: bad request, bad signature, refused content', () => {
    for (const status of [400, 401, 403, 409, 413, 422]) expect(RETRYABLE_STATUS.has(status)).toBe(false);
  });
});
