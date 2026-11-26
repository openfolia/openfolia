import { readFileSync } from 'node:fs';
import { DEFAULT_PRODUCT_NAME } from '../../branding/core/branding.js';
import { contrast } from '../../branding/core/brand-colours.js';
import { headerText, isMailAddress, mailLanguage } from './mail.js';
import {
  buttonColours,
  DEFAULT_PRIMARY,
  escapeHtml,
  renderHtml,
} from './templates/layout.js';
import { publicLink, renderMail } from './templates/render.js';

describe('isMailAddress', () => {
  it.each(['a@example.com', 'first.last+tag@sub.example.org', 'x@b.co'])(
    'takes %s',
    (address) => expect(isMailAddress(address)).toBe(true),
  );

  it.each([
    'a@example.com\r\nBcc: b@example.com',
    'a@example.com\n',
    'A <a@example.com>',
    'a@example.com,b@example.com',
    'a b@example.com',
    '"a"@example.com',
    'a@@example.com',
    'a@localhost',
    '',
    `${'a'.repeat(250)}@example.com`,
  ])('refuses %j', (address) => expect(isMailAddress(address)).toBe(false));
});

describe('headerText', () => {
  it('makes one line of anything', () => {
    expect(headerText('Docs\r\nBcc: x@example.com', 80)).toBe(
      'Docs Bcc: x@example.com',
    );
    expect(headerText('  a\t\tb   c\u0000 ', 80)).toBe('a b c');
  });

  it('cuts at the limit, by characters', () => {
    expect(headerText('äöü'.repeat(10), 5)).toBe('äöüäö');
  });
});

describe('mailLanguage', () => {
  it.each([
    ['de', 'de'],
    ['de-AT', 'de'],
    ['EN_gb', 'en'],
    ['fr', 'en'],
    [null, 'en'],
    ['', 'en'],
  ] as const)('%s → %s', (wanted, language) =>
    expect(mailLanguage(wanted, 'en')).toBe(language),
  );
});

describe('escapeHtml', () => {
  it('escapes markup and both quotes', () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });
});

describe('buttonColours', () => {
  it('reads at 4.5:1 or better, whatever the primary', () => {
    for (const primary of [
      null,
      '#000000',
      '#ffffff',
      '#808080',
      '#0b5394',
      '#ffd966',
      '#ff0000',
    ] as const) {
      const { fill, text } = buttonColours(primary);
      expect(contrast(fill, text)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('is the theme’s primary without a brand', () => {
    expect(buttonColours(null).fill).toBe(DEFAULT_PRIMARY);
  });

  it('is the theme’s primary as frontend/theme writes it', () => {
    const css = readFileSync(
      new URL('../../../../../frontend/theme/src/theme.css', import.meta.url),
      'utf8',
    );
    expect(css).toContain('--primary: oklch(0.5222 0.0965 139.98);');
  });
});

describe('the default product name', () => {
  it('is the editor’s', () => {
    const config = readFileSync(
      new URL(
        '../../../../../frontend/editor/src/docs.config.ts',
        import.meta.url,
      ),
      'utf8',
    );
    expect(config).toContain(`productName: '${DEFAULT_PRODUCT_NAME}',`);
  });
});

describe('publicLink', () => {
  it('is a path under the public URL', () => {
    expect(publicLink('https://example.com/docs/', 'invite/abc')).toBe(
      'https://example.com/docs/invite/abc',
    );
    expect(publicLink('https://example.com/docs/', '')).toBe(
      'https://example.com/docs/',
    );
    expect(publicLink(null, 'invite/abc')).toBeNull();
  });

  it.each([
    '/elsewhere',
    '//evil.example',
    'https://evil.example/',
    'javascript:alert(1)',
    '../up',
  ])('never leaves it: %s', (path) =>
    expect(() => publicLink('https://example.com/docs/', path)).toThrow(),
  );
});

describe('renderHtml', () => {
  it('refuses a link that is not http(s)', () => {
    expect(() =>
      renderHtml(
        {
          subject: 's',
          heading: 'h',
          paragraphs: [],
          action: { label: 'x', href: 'javascript:alert(1)' },
          reason: 'r',
          footer: 'f',
        },
        { productName: 'Docs', primary: null, logo: null },
        'en',
      ),
    ).toThrow();
  });
});

describe('renderMail', () => {
  it('refuses params its template does not take', () => {
    expect(() =>
      renderMail({
        template: 'test',
        params: { extra: '<b>' },
        language: 'en',
        to: { address: 'a@example.com' },
        from: 'docs@example.com',
        brand: { productName: 'Docs', primary: null, logo: null },
        publicUrl: null,
      }),
    ).toThrow();
  });

  it('keeps the recipient’s name to one line', () => {
    const mail = renderMail({
      template: 'test',
      params: {},
      language: 'en',
      to: { address: 'a@example.com', name: 'Ann\r\nBcc: b@example.com' },
      from: 'docs@example.com',
      brand: { productName: 'Docs', primary: null, logo: null },
      publicUrl: null,
    });
    expect(mail.to.name).toBe('Ann Bcc: b@example.com');
  });

  it.each([
    [
      'en',
      'Pat signed in to Docs with the emergency account',
      'Open the audit log',
    ],
    [
      'de',
      'Pat hat sich bei Docs mit dem Notfallkonto angemeldet',
      'Audit-Log öffnen',
    ],
  ] as const)(
    'tells an administrator of a use of the emergency account (%s, #378)',
    (language, subject, label) => {
      const mail = renderMail({
        template: 'emergency-sign-in',
        params: { by: 'Pat' },
        language,
        to: { address: 'a@example.com' },
        from: 'docs@example.com',
        brand: { productName: 'Docs', primary: null, logo: null },
        publicUrl: 'https://docs.example.org',
      });
      expect(mail.subject).toBe(subject);
      expect(mail.html).toContain(label);
      expect(mail.text).toContain(
        'https://docs.example.org/admin/audit?action=user.break-glass-sign-in',
      );
    },
  );
});
