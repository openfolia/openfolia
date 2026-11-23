import { passwordLength, passwordProblem } from './passwords.js';

describe('passwordProblem (#610)', () => {
  it('takes a long password, without composition rules', () => {
    for (const ok of [
      'a long and quiet river',
      'correct horse battery stable',
      'züge über brücken fahren',
      'Ünïcödé-sätze-sind-gut',
    ]) {
      expect([ok, passwordProblem(ok)]).toEqual([ok, undefined]);
    }
  });

  it('counts characters, not bytes, and Unicode forms alike', () => {
    expect(passwordLength('ä'.repeat(12))).toBe(12);
    // "a" with a combining diaeresis is one character, as "ä" is.
    expect(passwordLength('ä'.repeat(12))).toBe(12);
    expect(passwordProblem('äöüäöüäöüäö')).toBe('password-too-short');
  });

  it('refuses fewer than 12 and more than 256 characters', () => {
    expect(passwordProblem('elevenchars')).toBe('password-too-short');
    expect(passwordProblem('x'.repeat(257))).toBe('password-too-long');
  });

  it('refuses common passwords and their simple variations', () => {
    for (const common of [
      'password1234',
      'Password1234!',
      'P@ssw0rd2024',
      '123456789012',
      'qwertyuiop12',
      'qwertyqwerty',
      'aaaaaaaaaaaa',
      'abcabcabcabc',
      'iloveyouforever',
      'correcthorsebatterystaple',
      'Correct Horse Battery Staple',
      '!!letmein!!!',
      'asdfghjklasd',
      '0987654321098',
    ]) {
      expect([common, passwordProblem(common)]).toEqual([
        common,
        'password-too-common',
      ]);
    }
  });

  it('refuses the person’s own address or its local part', () => {
    const person = { email: 'pat.longname@example.org' };
    expect(passwordProblem('pat.longname@example.org', person)).toBe(
      'password-too-common',
    );
    expect(passwordProblem('pat.longname2024', person)).toBe(
      'password-too-common',
    );
    expect(passwordProblem('pat.longname writes docs', person)).toBe(undefined);
  });
});
