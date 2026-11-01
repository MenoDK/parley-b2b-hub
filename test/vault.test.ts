import { describe, expect, it } from 'vitest';
import { Vault, VaultError, parseKeyRing } from '../src/lib/vault.js';
import { fresh, freshKeyHex } from './helpers.js';

const blind = fresh();
const ringOf = (...versions: string[]) => parseKeyRing(versions.map((v) => `${v}:${freshKeyHex()}`).join(','));

describe('vault', () => {
  it('round-trips and never repeats a ciphertext for the same plaintext (fresh IV every time)', () => {
    const vault = new Vault(ringOf('v1'), blind);
    const a = vault.encrypt('529.982.247-25');
    const b = vault.encrypt('529.982.247-25');
    expect(a).not.toBe(b);
    expect(vault.decrypt(a)).toBe('529.982.247-25');
    expect(a.startsWith('v1.')).toBe(true);
    expect(a).not.toContain('529');
  });

  it('is authenticated: flipping one byte makes decryption throw instead of returning garbage', () => {
    const vault = new Vault(ringOf('v1'), blind);
    const token = vault.encrypt('secret value');
    const [version, payload] = token.split('.') as [string, string];
    const bytes = Buffer.from(payload, 'base64url');
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    expect(() => vault.decrypt(`${version}.${bytes.toString('base64url')}`)).toThrow(VaultError);
  });

  it('refuses another key, an unknown version, a truncated value and a malformed one', () => {
    const vault = new Vault(ringOf('v1'), blind);
    const other = new Vault(ringOf('v1'), blind);
    const token = vault.encrypt('x');
    expect(() => other.decrypt(token)).toThrow(VaultError);
    expect(() => vault.decrypt(`v9.${token.split('.')[1]}`)).toThrow(VaultError);
    expect(() => vault.decrypt('v1.AAAA')).toThrow(VaultError);
    expect(() => vault.decrypt('nonsense')).toThrow(VaultError);
    expect(() => vault.decrypt(`${token}.extra`)).toThrow(VaultError);
  });

  it('rotates: old rows stay readable while new writes use the new key, and rotate() moves a row forward', () => {
    const oldKey = `v1:${freshKeyHex()}`;
    const before = new Vault(parseKeyRing(oldKey), blind);
    const legacy = before.encrypt('kept across rotation');

    const after = new Vault(parseKeyRing(`v2:${freshKeyHex()},${oldKey}`), blind);
    expect(after.currentVersion).toBe('v2');
    expect(after.decrypt(legacy)).toBe('kept across rotation');
    expect(after.needsRotation(legacy)).toBe(true);
    const moved = after.rotate(legacy);
    expect(moved.startsWith('v2.')).toBe(true);
    expect(after.decrypt(moved)).toBe('kept across rotation');
    expect(after.rotate(moved)).toBe(moved); // already current: untouched

    // once v1 is dropped from the ring, a row that was never rotated is unreadable: this is why rotation is a process
    const dropped = new Vault(ringOf('v2'), blind);
    expect(() => dropped.decrypt(legacy)).toThrow(VaultError);
  });

  it('fails closed: no key, a short key or a bad format means no encryption, never plain text', () => {
    expect(() => parseKeyRing('')).toThrow(VaultError);
    expect(() => parseKeyRing('v1:abcd')).toThrow(VaultError);
    expect(() => parseKeyRing(`1:${freshKeyHex()}`)).toThrow(VaultError);
    expect(() => parseKeyRing(`v1:${freshKeyHex()},v1:${freshKeyHex()}`)).toThrow(VaultError);
    expect(() => new Vault([], blind)).toThrow(VaultError);
    expect(() => new Vault(ringOf('v1'), 'short')).toThrow(VaultError);
  });

  it('a blind index finds equal values across formats, reveals nothing else, and depends on its own key', () => {
    const vault = new Vault(ringOf('v1'), blind);
    expect(vault.blindIndex('529.982.247-25')).toBe(vault.blindIndex('52998224725'));
    expect(vault.blindIndex('52998224725')).not.toBe(vault.blindIndex('52998224726'));
    expect(vault.blindIndex('52998224725')).not.toBe(new Vault(ringOf('v1'), fresh()).blindIndex('52998224725'));
    expect(vault.blindIndex('52998224725')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('adding a key', () => {
  it('puts the new key first, keeps the old ones readable, and numbers versions without gaps or collisions', () => {
    const v1 = new Vault([{ version: 'v1', key: Buffer.from(freshKeyHex(), 'hex') }], fresh());
    const token = v1.encrypt('secret value');
    const v2 = v1.withNewKey();
    const v3 = v2.withNewKey();
    expect(v2.currentVersion).toBe('v2');
    expect(v3.currentVersion).toBe('v3');
    expect(v3.versions).toEqual(['v3', 'v2', 'v1']);
    expect(v3.decrypt(token)).toBe('secret value'); // still readable
    expect(v3.needsRotation(token)).toBe(true);
    expect(v3.versionOf(v3.rotate(token))).toBe('v3');
    expect(v3.retainOnlyCurrent().versions).toEqual(['v3']);
    expect(() => v3.retainOnlyCurrent().decrypt(token)).toThrow(VaultError); // rotation is a process, not a switch
  });
});
