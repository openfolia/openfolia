import { safeReturnPath } from './sign-in.controller.js';

describe('safeReturnPath (#37)', () => {
  it('keeps a path inside the editor', () => {
    expect(safeReturnPath('/content/en/a?x=1#b')).toBe('/content/en/a?x=1#b');
  });

  it('takes anything else as the start page', () => {
    for (const raw of [
      undefined,
      ['/a'],
      '',
      'manuals',
      'https://attacker.example/',
      '//attacker.example/',
      '/\\attacker.example',
      '/a\\b',
      '/a\r\nSet-Cookie: x=1',
      '/a\u0000b',
      '/a\u007fb',
      `/${'a'.repeat(2000)}`,
    ]) {
      expect(safeReturnPath(raw)).toBe('/');
    }
  });
});
