import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

/**
 * Encryption at rest for personal fields: AES-256-GCM, versioned, fail-closed.
 *
 *   v2.<base64url( iv(12) ‖ tag(16) ‖ ciphertext )>
 *
 * - GCM is authenticated: a flipped byte makes `decrypt` throw. CBC would return garbage without an error, and silent
 *   garbage in a stored field is worse than an exception.
 * - A fresh random IV per operation. Reusing a (key, IV) pair breaks GCM completely.
 * - The version prefix is what makes rotation possible: old rows stay readable while new writes use the new key.
 * - No key, no encryption: `encrypt` throws. It never falls back to plain text because someone forgot a variable.
 *
 * The blind index lets us look a person up by tax id without decrypting every row: HMAC under a *separate* key, over
 * a normalised value. It reveals equality (that two rows share a value) and nothing else, which is the price of search.
 */

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export interface VaultKey {
  version: string;
  key: Buffer;
}

export class VaultError extends Error {}

/** `v2:<64 hex>,v1:<64 hex>`: the first entry is the current key. */
export function parseKeyRing(spec: string): VaultKey[] {
  const keys = spec
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [version, hex, ...rest] = part.split(':');
      if (!version || !hex || rest.length > 0 || !/^v\d+$/.test(version) || !/^[0-9a-f]{64}$/i.test(hex)) {
        throw new VaultError('each key must look like v<number>:<64 hex characters>');
      }
      return { version, key: Buffer.from(hex, 'hex') };
    });
  if (keys.length === 0) throw new VaultError('no encryption key configured');
  if (new Set(keys.map((k) => k.version)).size !== keys.length) throw new VaultError('duplicate key version');
  return keys;
}

export class Vault {
  readonly #ring: Map<string, Buffer>;
  readonly #current: VaultKey;
  readonly #blindKey: Buffer;

  constructor(ring: readonly VaultKey[], blindIndexKey: string) {
    const [current] = ring;
    if (!current) throw new VaultError('no encryption key configured');
    for (const { key } of ring) if (key.length !== KEY_BYTES) throw new VaultError('AES-256 needs a 32-byte key');
    if (blindIndexKey.length < 16) throw new VaultError('the blind-index key is too short');
    this.#ring = new Map(ring.map((k) => [k.version, k.key]));
    this.#current = current;
    this.#blindKey = Buffer.from(blindIndexKey, 'utf8');
  }

  get currentVersion(): string {
    return this.#current.version;
  }

  encrypt(plain: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.#current.key, iv);
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return `${this.#current.version}.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')}`;
  }

  decrypt(token: string): string {
    const [version, payload, ...rest] = token.split('.');
    const key = version ? this.#ring.get(version) : undefined;
    if (!key || !payload || rest.length > 0) throw new VaultError('unknown format or key version');
    const raw = Buffer.from(payload, 'base64url');
    if (raw.length < IV_BYTES + TAG_BYTES) throw new VaultError('truncated ciphertext');
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, IV_BYTES));
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    try {
      return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
    } catch {
      throw new VaultError('the ciphertext was altered or the key is wrong');
    }
  }

  get versions(): string[] {
    return [...this.#ring.keys()];
  }

  /** A vault with a fresh key in front and every existing key kept, so rows written before stay readable until rotated. */
  withNewKey(): Vault {
    const highest = Math.max(0, ...this.versions.map((v) => Number(v.slice(1))));
    const ring = [
      { version: `v${highest + 1}`, key: randomBytes(KEY_BYTES) },
      ...[...this.#ring].map(([version, key]) => ({ version, key })),
    ];
    return new Vault(ring, this.#blindKey.toString('utf8'));
  }

  /** A vault holding only the current key: what is left after the old keys are retired. Rows not yet rotated are lost. */
  retainOnlyCurrent(): Vault {
    return new Vault([this.#current], this.#blindKey.toString('utf8'));
  }

  versionOf(token: string): string {
    return token.split('.', 1)[0] ?? '';
  }

  needsRotation(token: string): boolean {
    return this.versionOf(token) !== this.#current.version;
  }

  /** Decrypts with whichever key wrote it and encrypts again with the current one. */
  rotate(token: string): string {
    return this.needsRotation(token) ? this.encrypt(this.decrypt(token)) : token;
  }

  /** Normalised first so "529.982.247-25" and "52998224725" find the same row. */
  blindIndex(value: string): string {
    const normalised = value.replace(/[\s.\-/]/g, '').toLowerCase();
    return createHmac('sha256', this.#blindKey).update(normalised, 'utf8').digest('hex');
  }
}
