import { Argon2PasswordHasher } from './argon2-password-hasher.js';

describe('Argon2PasswordHasher (#610)', () => {
  // Small parameters: the format and the checks, not the cost.
  const small = { memory: 64, passes: 1, parallelism: 1 };

  it('hashes with argon2id in the PHC format, a fresh salt each time', async () => {
    const hasher = new Argon2PasswordHasher(small);
    const a = await hasher.hash('a long and quiet river');
    const b = await hasher.hash('a long and quiet river');
    expect(a).toMatch(
      /^\$argon2id\$v=19\$m=64,t=1,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/,
    );
    expect(a).not.toBe(b);
    expect(await hasher.verify(a, 'a long and quiet river')).toBe(true);
    expect(await hasher.verify(a, 'a long and quiet rivers')).toBe(false);
  });

  it('compares the NFC form, so both spellings of one character match', async () => {
    const hasher = new Argon2PasswordHasher(small);
    const stored = await hasher.hash('Grüße aus der Stadt');
    expect(await hasher.verify(stored, 'Grüße aus der Stadt')).toBe(true);
  });

  it('keeps verifying a hash of older parameters, and says it needs rehashing', async () => {
    const old = await new Argon2PasswordHasher(small).hash(
      'a long and quiet river',
    );
    const current = new Argon2PasswordHasher({ ...small, passes: 2 });
    expect(await current.verify(old, 'a long and quiet river')).toBe(true);
    expect(current.needsRehash(old)).toBe(true);
    expect(current.needsRehash(await current.hash('x'.repeat(12)))).toBe(false);
  });

  it('refuses a malformed hash, and parameters this server would never make', async () => {
    const hasher = new Argon2PasswordHasher(small);
    expect(await hasher.verify('plain', 'plain')).toBe(false);
    expect(
      await hasher.verify(
        '$argon2id$v=19$m=9999999,t=1,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        'x',
      ),
    ).toBe(false);
    await expect(hasher.verifyNothing('anything')).resolves.toBeUndefined();
  });
});
