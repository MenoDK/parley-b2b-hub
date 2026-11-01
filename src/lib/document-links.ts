import { createHmac } from 'node:crypto';
import { safeEqualHex } from './signing.js';

/**
 * Short-lived signed links to a document: `<document id>.<expires at>.<hmac>`.
 *
 * Why our own links instead of the storage provider's:
 *   - every access goes through us, so every access can be audited;
 *   - deleting the document kills every outstanding link at once;
 *   - nothing about where the bytes live leaks to the other company.
 *
 * The signing key is *derived* (`HMAC(secret, label)`), not the webhook secret itself. One value with two uses lets an
 * oracle on one weaken the other; with a derived key a signed link can never pass as a webhook signature.
 * The label carries a version: change the scheme, change the label.
 */

export const LINK_LIFETIME_SECONDS = 3600;
const KEY_LABEL = 'document-link.v1';

export type LinkRefusal = 'no_secret' | 'malformed' | 'bad_signature' | 'expired';

const linkKey = (secret: string): Buffer => createHmac('sha256', secret).update(KEY_LABEL).digest();

const mac = (documentId: string, expiresAt: number, secret: string): string =>
  createHmac('sha256', linkKey(secret)).update(`${documentId}.${expiresAt}`).digest('hex');

export function signDocumentLink(input: {
  documentId: string;
  secret: string;
  nowSeconds: number;
  lifetimeSeconds?: number;
}): string {
  const expiresAt = input.nowSeconds + (input.lifetimeSeconds ?? LINK_LIFETIME_SECONDS);
  return `${input.documentId}.${expiresAt}.${mac(input.documentId, expiresAt, input.secret)}`;
}

export type LinkVerdict = { ok: true; documentId: string } | { ok: false; reason: LinkRefusal };

export function checkDocumentLink(input: {
  token: string;
  secret: string | undefined;
  nowSeconds: number;
}): LinkVerdict {
  if (!input.secret) return { ok: false, reason: 'no_secret' };
  const parts = input.token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [documentId, expiry, received] = parts as [string, string, string];
  const expiresAt = Number(expiry);
  if (!documentId || !/^\d{1,12}$/.test(expiry) || !Number.isSafeInteger(expiresAt)) {
    return { ok: false, reason: 'malformed' };
  }
  if (!safeEqualHex(mac(documentId, expiresAt, input.secret), received)) return { ok: false, reason: 'bad_signature' };
  // Expiry comes after the signature: "expired" must never be the answer to a token that was never signed.
  if (input.nowSeconds > expiresAt) return { ok: false, reason: 'expired' };
  return { ok: true, documentId };
}
