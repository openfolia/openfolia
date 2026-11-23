import {
  assetUrlFor,
  contentSecurityPolicy,
  pageHtml,
  relativeRoot,
} from './preview-page.js';
import { darkAsRoot } from '../repos/preview-files.js';

describe('contentSecurityPolicy', () => {
  it('lets only itself frame the page without editor origins', () => {
    const csp = contentSecurityPolicy([]);
    expect(csp.endsWith("frame-ancestors 'self'")).toBe(true);
    expect(csp).toContain("script-src 'none'");
  });

  it('adds the editor origins to frame-ancestors only', () => {
    expect(contentSecurityPolicy(['https://a.example', 'http://b:1'])).toMatch(
      /; frame-ancestors 'self' https:\/\/a\.example http:\/\/b:1$/,
    );
  });
});

describe('relativeRoot', () => {
  it('leads from the page’s own URL to the API root', () => {
    expect(relativeRoot('/modules/en/x/preview')).toBe('../../../');
    expect(relativeRoot('/modules/en/x/preview/')).toBe('../../../../');
    expect(relativeRoot('/manuals/m/variants/v/en/html')).toBe(
      '../../../../../',
    );
  });
});

describe('assetUrlFor', () => {
  it('carries the requested ref, encoded, and none when there was none', () => {
    const hash = 'a'.repeat(64);
    expect(assetUrlFor('/modules/en/x/preview', undefined)(hash)).toBe(
      `../../../assets/${hash}`,
    );
    expect(assetUrlFor('/modules/en/x/preview', 'agent/x y&z')(hash)).toBe(
      `../../../assets/${hash}?ref=agent%2Fx%20y%26z`,
    );
  });
});

describe('pageHtml', () => {
  const preview = {
    html: '<article></article>',
    title: '<b>"A" & B</b>',
    lang: 'de',
    dir: 'ltr' as const,
    issueCount: 0,
  };

  it('sets the language and its direction on the page (#458)', () => {
    expect(pageHtml(preview, 'auto', '')).toContain(
      '<html lang="de" dir="ltr">',
    );
    expect(
      pageHtml({ ...preview, lang: 'ar', dir: 'rtl' }, 'dark', ''),
    ).toContain('<html lang="ar" dir="rtl" class="dark">');
  });

  it('escapes the title and language', () => {
    const html = pageHtml({ ...preview, lang: 'x"><script>' }, 'auto', '');
    expect(html).toContain(
      '<title>&lt;b&gt;&quot;A&quot; &amp; B&lt;/b&gt;</title>',
    );
    expect(html).not.toContain('<script>');
  });
});

describe('darkAsRoot', () => {
  it('turns the theme’s .dark block into :root values', () => {
    expect(darkAsRoot('.light { --a: 1; }\n\n.dark {\n  --a: 2;\n}\n')).toBe(
      ':root { color-scheme: dark; --a: 2; }\n',
    );
  });

  it('fails loudly when the theme has no .dark block', () => {
    expect(() => darkAsRoot(':root { --a: 1; }')).toThrow(/\.dark/);
  });
});
