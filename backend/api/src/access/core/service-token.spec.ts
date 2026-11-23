import {
  hashServiceToken,
  isServiceToken,
  mintServiceToken,
  SERVICE_TOKEN_PATTERN,
  serviceTokenId,
  serviceTokenMatches,
} from './service-token.js';

describe('service tokens', () => {
  it('are minted with the prefix, a public ID and 256 random bits', () => {
    const { id, token, secretHash } = mintServiceToken();
    expect(token).toMatch(SERVICE_TOKEN_PATTERN);
    expect(token.startsWith(`ccms_sat_${id}_`)).toBe(true);
    expect(token).toHaveLength(9 + 16 + 1 + 64);
    expect(secretHash).toBe(hashServiceToken(token));
    expect(secretHash).not.toContain(token.slice(26));
    expect(isServiceToken(token)).toBe(true);
    expect(serviceTokenId(token)).toBe(id);
  });

  it('are never minted twice', () => {
    const tokens = new Set(
      Array.from({ length: 200 }, () => mintServiceToken().token),
    );
    expect(tokens.size).toBe(200);
  });

  it('match their hash only', () => {
    const { token, secretHash } = mintServiceToken();
    expect(serviceTokenMatches(token, secretHash)).toBe(true);
    expect(serviceTokenMatches(`${token.slice(0, -1)}0`, secretHash)).toBe(
      token.endsWith('0'),
    );
    expect(serviceTokenMatches(mintServiceToken().token, secretHash)).toBe(
      false,
    );
    // A malformed stored hash matches nothing.
    expect(serviceTokenMatches(token, 'not-hex')).toBe(false);
    expect(serviceTokenMatches(token, secretHash.toUpperCase())).toBe(false);
  });

  it('give no ID for anything malformed', () => {
    const { token } = mintServiceToken();
    for (const bad of [
      '',
      'ccms_sat_',
      token.toUpperCase(),
      `${token}0`,
      token.slice(0, -1),
      ` ${token}`,
      token.replace('ccms_sat_', 'ccms_xyz_'),
    ]) {
      expect(serviceTokenId(bad)).toBeUndefined();
    }
  });
});
