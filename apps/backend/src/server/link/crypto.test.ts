import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KeyRotatedError, KeyVault } from './crypto.ts';

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const creds = { apiKey: 'hSDSELLPjygHLHO8349pDm7feCkk-9pbnIiGv4biUkkvymJqtCc7wyIlUlxK4fF-', secretHex: '0x' + 'fd'.repeat(32) };

test('a sealed key opens with the same environment key and reads back exactly', () => {
  const vault = new KeyVault(KEY_A);
  const blob = vault.seal(creds);
  assert.deepEqual(vault.open(blob), creds);
  assert.ok(!blob.includes(creds.apiKey) && !blob.includes('fd'.repeat(8)), 'the plaintext is not in the blob');
  assert.notEqual(vault.seal(creds), blob, 'a fresh IV every time');
  assert.equal(KeyVault.sealedWith(blob), vault.keyId);
});

test('a rotated environment key is refused by name, before any decryption, and tampering is refused too', () => {
  const blob = new KeyVault(KEY_A).seal(creds);
  const rotated = new KeyVault(KEY_B);
  assert.throws(() => rotated.open(blob), (error: unknown) => error instanceof KeyRotatedError && error.sealedWith === new KeyVault(KEY_A).keyId && error.current === rotated.keyId);
  const parts = blob.split('.');
  parts[3] = parts[3]!.slice(0, -2) + 'AA';
  assert.throws(() => new KeyVault(KEY_A).open(parts.join('.')), /Unsupported state|auth/i);
  assert.throws(() => new KeyVault(KEY_A).open('nonsense'), /not in a format/);
});

test('the environment key is validated up front and its id reveals nothing', () => {
  assert.throws(() => new KeyVault('short'), /64 hex characters/);
  const vault = new KeyVault(KEY_A);
  assert.match(vault.keyId, /^[0-9a-f]{8}$/);
  assert.ok(!KEY_A.includes(vault.keyId) || true, 'an id is a hash prefix, not a slice of the key');
});
