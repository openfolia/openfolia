import {
  base32,
  matchingStep,
  mintTotpSecret,
  otpauthUrl,
  TOTP_STEP_MS,
  totpCode,
  totpStep,
} from './totp.js';

/** RFC 6238, appendix B: the SHA-1 secret, in base32. */
const RFC_SECRET = base32(Buffer.from('12345678901234567890'));

describe('totp', () => {
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ])('makes the code RFC 6238 gives for %i s', (seconds, code) => {
    expect(totpCode(RFC_SECRET, totpStep(seconds * 1000))).toBe(code);
  });

  it('encodes base32 as RFC 4648, without padding', () => {
    expect(
      ['f', 'fo', 'foo', 'foob', 'fooba', 'foobar'].map((text) =>
        base32(Buffer.from(text)),
      ),
    ).toEqual(['MY', 'MZXQ', 'MZXW6', 'MZXW6YQ', 'MZXW6YTB', 'MZXW6YTBOI']);
  });

  it('mints 160-bit secrets, each its own', () => {
    const secret = mintTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(mintTotpSecret()).not.toBe(secret);
  });

  it('accepts one step before and after the clock, never two', () => {
    const now = 1_700_000_010_000;
    const at = (steps: number) =>
      matchingStep(
        RFC_SECRET,
        totpCode(RFC_SECRET, totpStep(now) + steps),
        now,
      );
    expect(at(0)).toBe(totpStep(now));
    expect(at(-1)).toBe(totpStep(now) - 1);
    expect(at(1)).toBe(totpStep(now) + 1);
    expect(at(-2)).toBeUndefined();
    expect(at(2)).toBeUndefined();
  });

  it('refuses a code of another length or secret', () => {
    const now = 59_000;
    for (const code of ['', '28708', '2870822', '287083', 'abcdef']) {
      expect(matchingStep(RFC_SECRET, code, now)).toBeUndefined();
    }
    expect(matchingStep(mintTotpSecret(), '287082', now)).toBeUndefined();
    expect(TOTP_STEP_MS).toBe(30_000);
  });

  it('names the installation and the account, a colon in them never splitting the label', () => {
    expect(
      otpauthUrl({
        secret: 'ABC',
        issuer: 'Docs: Ünit & Co',
        account: 'pat@example.org',
      }),
    ).toBe(
      'otpauth://totp/Docs%20%20%C3%9Cnit%20%26%20Co:pat%40example.org?secret=ABC&issuer=Docs%20%20%C3%9Cnit%20%26%20Co&algorithm=SHA1&digits=6&period=30',
    );
  });

  it('leaves an over-long name to its default, so the code stays scannable', () => {
    const url = otpauthUrl({
      secret: 'A'.repeat(32),
      issuer: '文'.repeat(80),
      account: `${'x'.repeat(300)}@example.org`,
    });
    expect(url).toContain('/OpenFolia:account?');
    const longest = otpauthUrl({
      secret: 'A'.repeat(32),
      issuer: 'x'.repeat(240),
      account: 'y'.repeat(240),
    });
    // What `qrCodeSvg` holds.
    expect(longest.length).toBeLessThan(1000);
  });
});
