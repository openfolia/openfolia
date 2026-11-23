import { isLinkHref, Mark } from './inline.js';

describe('link mark', () => {
  const link = (href: string) => Mark.safeParse({ type: 'link', href }).success;

  it('accepts http, https and mailto links', () => {
    expect(link('https://example.com/docs')).toBe(true);
    expect(link('http://example.com')).toBe(true);
    expect(link('mailto:support@example.com')).toBe(true);
  });

  it('rejects script and data URLs, which would run in rendered HTML', () => {
    expect(link('javascript:alert(1)')).toBe(false);
    expect(link('JavaScript:alert(1)')).toBe(false);
    expect(link('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(link('vbscript:msgbox(1)')).toBe(false);
  });
});

describe('link mark host', () => {
  it('rejects http(s) URLs without a host', () => {
    expect(Mark.safeParse({ type: 'link', href: 'https:foo' }).success).toBe(
      false,
    );
    expect(Mark.safeParse({ type: 'link', href: 'https:/foo' }).success).toBe(
      false,
    );
  });
});

describe('isLinkHref', () => {
  it('takes absolute http, https and mailto addresses only', () => {
    expect(isLinkHref('https://example.com/a?b=1#c')).toBe(true);
    expect(isLinkHref('HTTP://example.com')).toBe(true);
    expect(isLinkHref('mailto:someone@example.com')).toBe(true);
  });

  it('refuses every other scheme, relative addresses and what is not a string', () => {
    for (const href of [
      'javascript:alert(1)',
      ' javascript:alert(1)',
      'java\tscript:alert(1)',
      'JAVASCRIPT:alert(1)',
      'data:text/html,x',
      'vbscript:x',
      'file:///etc/passwd',
      'ftp://example.com',
      '/relative/path',
      '#fragment',
      '//example.com',
      'https:foo',
      'https://exa mple.com',
      'https://example.com/a\u0000b',
      'https://example.com/a\u0085b',
      'https://example.com/\u202egnp.exe',
      'https://example.com/a\u200bb',
      'https://\\example.com',
      'https://example.com/a\u00adb',
      'https://example.com/a\u061cb',
      '',
    ])
      expect(isLinkHref(href), href).toBe(false);
    expect(isLinkHref(null)).toBe(false);
    expect(isLinkHref(42)).toBe(false);
  });

  it('agrees with the link mark', () => {
    for (const href of ['https://example.com', 'javascript:x', '/a'])
      expect(isLinkHref(href)).toBe(
        Mark.safeParse({ type: 'link', href }).success,
      );
  });
});
