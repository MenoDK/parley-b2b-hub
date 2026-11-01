import { randomBytes } from 'node:crypto';

/** Credentials for tests are made at run time: nothing here is, or ever was, a real secret. */
export const fresh = (bytes = 24): string => randomBytes(bytes).toString('base64url');
export const freshKeyHex = (): string => randomBytes(32).toString('hex');
