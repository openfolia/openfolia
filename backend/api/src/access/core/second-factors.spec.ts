import {
  coveredBySecondFactor,
  hashRecoveryCode,
  mintRecoveryCodes,
  readSecondFactorCode,
} from './second-factors.js';

describe('recovery codes', () => {
  it('are ten, 80 bits each, in groups that read aloud', () => {
    const codes = mintRecoveryCodes();
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) {
      expect(code).toMatch(
        /^[0-9a-hjkmnp-tv-z]{4}(-[0-9a-hjkmnp-tv-z]{4}){3}$/,
      );
      expect(readSecondFactorCode(code)).toEqual({
        kind: 'recovery-code',
        code: code.replaceAll('-', ''),
      });
    }
  });

  it('are hashed for their person, the dashes left out', () => {
    const hash = hashRecoveryCode('pat', 'abcd-efgh-jkmn-pqrs');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRecoveryCode('pat', 'abcdefghjkmnpqrs')).toBe(hash);
    expect(hashRecoveryCode('sam', 'abcdefghjkmnpqrs')).not.toBe(hash);
  });
});

describe('readSecondFactorCode', () => {
  it.each(['123456', ' 123 456 ', '123-456'])(
    'reads %j as the app’s code',
    (typed) => {
      expect(readSecondFactorCode(typed)).toEqual({
        kind: 'totp',
        code: '123456',
      });
    },
  );

  it('reads a recovery code however it is typed, its look-alikes back', () => {
    for (const typed of [
      '0abc-1def-2ghj-3kmn',
      '0ABC 1DEF 2GHJ 3KMN',
      'OabcIdef2ghj3kmn',
      'oabcldef2ghj3kmn',
    ]) {
      expect(readSecondFactorCode(typed)).toEqual({
        kind: 'recovery-code',
        code: '0abc1def2ghj3kmn',
      });
    }
  });

  it.each(['', '12345', '1234567', '0abc1def2ghj3km', 'uuuuuuuuuuuuuuuu'])(
    'takes %j for neither',
    (typed) => {
      expect(readSecondFactorCode(typed)).toBeUndefined();
    },
  );
});

it('covers the ways in that end here, never a provider’s', () => {
  expect(['password', 'email-code'].every(coveredBySecondFactor)).toBe(true);
  expect(['oidc', 'saml', '', undefined].some(coveredBySecondFactor)).toBe(
    false,
  );
});
