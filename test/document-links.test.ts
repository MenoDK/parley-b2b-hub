import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkDocumentLink, signDocumentLink } from '../src/lib/document-links.js';
import { sign } from '../src/lib/signing.js';
import { fresh } from './helpers.js';

const secret = fresh();
const NOW = 1_800_000_000;
const link = (over: Partial<Parameters<typeof signDocumentLink>[0]> = {}) =>
  signDocumentLink({ documentId: 'doc-1', secret, nowSeconds: NOW, ...over });

describe('signed document links', () => {
  it('opens within the lifetime and names the document', () => {
    expect(checkDocumentLink({ token: link(), secret, nowSeconds: NOW + 3599 })).toEqual({
      ok: true,
      documentId: 'doc-1',
    });
  });

  it('expires, but only after the signature has been checked', () => {
    expect(checkDocumentLink({ token: link(), secret, nowSeconds: NOW + 3601 })).toEqual({
      ok: false,
      reason: 'expired',
    });
    const forgedAndStale = `doc-1.${NOW - 99}.${'0'.repeat(64)}`;
    expect(checkDocumentLink({ token: forgedAndStale, secret, nowSeconds: NOW })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('refuses a link whose document id or expiry was edited', () => {
    const [, expiry, mac] = link().split('.') as [string, string, string];
    expect(checkDocumentLink({ token: `doc-2.${expiry}.${mac}`, secret, nowSeconds: NOW }).ok).toBe(false);
    expect(checkDocumentLink({ token: `doc-1.${Number(expiry) + 86_400}.${mac}`, secret, nowSeconds: NOW }).ok).toBe(
      false,
    );
  });

  it('refuses a malformed token, a wrong secret and a missing secret', () => {
    for (const token of ['', 'a.b', 'a.b.c.d', `doc-1.notanumber.${'0'.repeat(64)}`, `doc-1.${NOW}.zz`]) {
      expect(checkDocumentLink({ token, secret, nowSeconds: NOW })).toMatchObject({ ok: false });
    }
    expect(checkDocumentLink({ token: link(), secret: fresh(), nowSeconds: NOW })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(checkDocumentLink({ token: link(), secret: undefined, nowSeconds: NOW })).toEqual({
      ok: false,
      reason: 'no_secret',
    });
  });

  it('key separation: a webhook signature can never pass as a link, and a link can never pass as a webhook signature', () => {
    const expiresAt = NOW + 600;
    const asWebhook = sign(secret, 'doc-1', expiresAt, '');
    expect(checkDocumentLink({ token: `doc-1.${expiresAt}.${asWebhook}`, secret, nowSeconds: NOW }).ok).toBe(false);

    const underUnderivedKey = createHmac('sha256', secret).update(`doc-1.${expiresAt}`).digest('hex');
    expect(checkDocumentLink({ token: `doc-1.${expiresAt}.${underUnderivedKey}`, secret, nowSeconds: NOW }).ok).toBe(
      false,
    );
  });
});
