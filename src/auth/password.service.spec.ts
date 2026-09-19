import { PasswordService } from './password.service.js';

describe('PasswordService', () => {
  const passwords = new PasswordService();
  it('uses salted Argon2id and verifies passwords', async () => {
    const hash = await passwords.hash('long-admin-password');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash).not.toBe(await passwords.hash('long-admin-password'));
    expect(await passwords.verify(hash, 'long-admin-password')).toBe(true);
    expect(await passwords.verify(hash, 'wrong-password')).toBe(false);
  });
  it('rejects malformed hashes', async () => {
    expect(await passwords.verify('invalid', 'password')).toBe(false);
  });
  it('performs a dummy verification for absent users', async () => {
    await expect(passwords.verifyMissing('unknown')).resolves.toBeUndefined();
  });
});
