// @vitest-environment jsdom
/// <reference lib="dom" />
import fc from 'fast-check';
import {
  OFFLINE_SEARCH_SCRIPT,
  OFFLINE_SITE_CSS,
  offlineContentSecurityPolicy,
  offlineIndexHtml,
  offlineLabels,
  offlinePageHtml,
  type OfflineIndex,
} from './offline-site.js';
import { manualHeadings, renderManualHtml } from './render.js';
import { resolve } from '../testing/fixture.js';

const fixtureManual = () => resolve('large').manual;

const HOSTILE = [
  '<script>alert(1)</script>',
  '"><img src=x onerror=alert(1)>',
  "'><svg onload=alert(1)>",
  '</script><script>alert(1)</script>',
  '<!--',
  'javascript:alert(1)',
  '\u2028\u2029',
  '&amp;',
];
const hostile = fc.oneof(fc.constantFrom(...HOSTILE), fc.string());

const parse = (html: string) =>
  new DOMParser().parseFromString(html, 'text/html');

/** Every element and attribute the offline pages may carry (the fragment aside). */
const ELEMENTS = new Set([
  'html',
  'head',
  'meta',
  'title',
  'link',
  'body',
  'nav',
  'a',
  'main',
  'footer',
  'header',
  'p',
  'h1',
  'h2',
  'h3',
  'div',
  'label',
  'input',
  'ol',
  'ul',
  'li',
  'script',
]);

function index(over: Partial<OfflineIndex> = {}): OfflineIndex {
  return {
    lang: 'en',
    dir: 'ltr',
    title: 'North 2.0',
    subtitle: 'English · Public',
    manuals: [
      {
        title: 'Operating manual',
        variants: [
          {
            label: 'Small',
            page: 'manuals/operating/model-small.html',
            pdf: 'pdf/operating/en/model-small.pdf',
          },
          { label: 'Large', page: 'manuals/operating/model-large.html' },
        ],
      },
    ],
    search: [
      {
        text: 'Charging',
        page: 'manuals/operating/model-small.html#of-charging',
        context: 'Operating manual · Small',
      },
      {
        text: 'Laden über Nacht',
        page: 'manuals/operating/model-large.html#of-night',
        context: 'Operating manual · Large',
      },
    ],
    footer: 'North 2.0',
    ...over,
  };
}

describe('offlineIndexHtml', () => {
  it('lists every manual and variant with its page and PDF, relative to the package', () => {
    const doc = parse(offlineIndexHtml(index()));
    const links = [...doc.querySelectorAll('a')].map((a) => [
      a.textContent,
      a.getAttribute('href'),
    ]);
    expect(links).toEqual([
      ['Small', 'manuals/operating/model-small.html'],
      ['PDF', 'pdf/operating/en/model-small.pdf'],
      ['Large', 'manuals/operating/model-large.html'],
    ]);
    expect(doc.documentElement.lang).toBe('en');
    expect(doc.title).toBe('North 2.0');
  });

  it('carries the policy: its own files only, its search script and no inline script', () => {
    const doc = parse(offlineIndexHtml(index()));
    const csp = doc
      .querySelector('meta[http-equiv="Content-Security-Policy"]')
      ?.getAttribute('content');
    expect(csp).toBe(offlineContentSecurityPolicy(true));
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toMatch(/https?:|unsafe-eval|script-src[^;]*unsafe-inline/);
    const scripts = [...doc.querySelectorAll('script')];
    // A data block (never run) and the search's file.
    expect(scripts.map((s) => [s.type, s.getAttribute('src')])).toEqual([
      ['application/json', null],
      ['', 'assets/search.js'],
    ]);
    expect(
      [...doc.querySelectorAll('link')].map((l) => l.getAttribute('href')),
    ).toEqual([
      'assets/theme.css',
      'assets/theme-dark.css',
      'assets/render-html.css',
      'assets/site.css',
    ]);
  });

  it('writes no markup of the content, and its search data reads back as given', () => {
    fc.assert(
      fc.property(hostile, hostile, hostile, (title, text, context) => {
        const made = index({
          title,
          subtitle: text,
          footer: context,
          manuals: [
            {
              title: text,
              variants: [{ label: title, page: 'manuals/m/v.html' }],
            },
          ],
          search: [{ text, page: 'manuals/m/v.html#of-a', context }],
        });
        const doc = parse(offlineIndexHtml(made));
        for (const el of doc.querySelectorAll('*')) {
          expect(ELEMENTS.has(el.localName)).toBe(true);
          for (const attr of el.attributes) {
            expect(attr.name.startsWith('on')).toBe(false);
          }
        }
        expect(doc.querySelectorAll('script')).toHaveLength(2);
        expect(doc.querySelector('title')?.textContent).toBe(
          title.replace(/\0/g, '\ufffd'),
        );
        const data = doc.getElementById('of-search-index')?.textContent;
        expect(JSON.parse(data ?? '')).toEqual([
          [text, 'manuals/m/v.html#of-a', context],
        ]);
      }),
    );
  });

  it('refuses a link out of the package, in the list and the search', () => {
    const doc = parse(
      offlineIndexHtml(
        index({
          manuals: [
            {
              title: 'M',
              variants: [
                { label: 'a', page: 'javascript:alert(1)' },
                { label: 'b', page: 'https://example.com/x.html' },
                { label: 'c', page: '/etc/passwd' },
              ],
            },
          ],
          search: [
            { text: 'x', page: 'https://example.com/', context: '' },
            { text: 'y', page: 'file:///etc/passwd', context: '' },
          ],
        }),
      ),
    );
    expect(
      [...doc.querySelectorAll('.of-offline__page')].map((a) =>
        a.getAttribute('href'),
      ),
    ).toEqual([null, null, null]);
    expect(
      JSON.parse(doc.getElementById('of-search-index')?.textContent ?? ''),
    ).toEqual([]);
  });

  it('says so when it holds no manuals', () => {
    const doc = parse(offlineIndexHtml(index({ manuals: [], lang: 'de' })));
    expect(doc.querySelector('.of-offline__empty')?.textContent).toBe(
      offlineLabels('de').noManuals,
    );
  });
});

describe('the search script', () => {
  function run(html: string) {
    document.documentElement.innerHTML = parse(html).documentElement.innerHTML;
    new Function(OFFLINE_SEARCH_SCRIPT)();
    const input = document.getElementById('of-search') as HTMLInputElement;
    return (value: string) => {
      input.value = value;
      input.dispatchEvent(new Event('input'));
      return [...document.querySelectorAll('#of-search-results li')].map(
        (li) => [
          li.querySelector('a')?.getAttribute('href') ?? null,
          li.textContent,
        ],
      );
    };
  }

  it('shows the search once it runs, and finds headings by every word, case and accents aside', () => {
    const search = run(offlineIndexHtml(index()));
    expect(
      (document.querySelector('.of-offline__search') as HTMLElement).hidden,
    ).toBe(false);
    expect(search('CHARG')).toEqual([
      [
        'manuals/operating/model-small.html#of-charging',
        'ChargingOperating manual · Small',
      ],
    ]);
    expect(search('uber nacht large')).toEqual([
      [
        'manuals/operating/model-large.html#of-night',
        'Laden über NachtOperating manual · Large',
      ],
    ]);
    expect(search('nothing like it')).toEqual([[null, 'Nothing found.']]);
    expect(search('  ')).toEqual([]);
  });

  it('writes the index as text only', () => {
    const search = run(
      offlineIndexHtml(
        index({
          search: [
            {
              text: '<img src=x onerror=alert(1)>',
              page: 'manuals/m/v.html',
              context: '<b>x</b>',
            },
          ],
        }),
      ),
    );
    expect(search('img')).toEqual([
      ['manuals/m/v.html', '<img src=x onerror=alert(1)><b>x</b>'],
    ]);
    expect(document.querySelector('#of-search-results img')).toBeNull();
  });
});

describe('offlinePageHtml', () => {
  it('wraps a rendered manual with a bar back to the index and its PDF, running no script', () => {
    const fragment = renderManualHtml(fixtureManual(), {
      assetUrl: (sha256) => `../../media/${sha256}.png`,
    }).html;
    const doc = parse(
      offlinePageHtml({
        lang: 'de',
        dir: 'ltr',
        title: 'Handbuch · Klein',
        root: '../../',
        fragment,
        pdf: 'pdf/m/de/v.pdf',
        footer: 'North 2.0',
      }),
    );
    expect(doc.documentElement.lang).toBe('de');
    expect(
      doc
        .querySelector('meta[http-equiv="Content-Security-Policy"]')
        ?.getAttribute('content'),
    ).toContain("script-src 'none'");
    expect(doc.querySelectorAll('script')).toHaveLength(0);
    expect(doc.querySelector('.of-offline__home')?.getAttribute('href')).toBe(
      '../../index.html',
    );
    expect(doc.querySelector('.of-offline__home')?.textContent).toBe(
      'Alle Handbücher',
    );
    expect(doc.querySelector('.of-offline__pdf')?.getAttribute('href')).toBe(
      '../../pdf/m/de/v.pdf',
    );
    expect(doc.querySelector('main article.of-manual')).not.toBeNull();
    for (const el of doc.querySelectorAll('[src]')) {
      expect(el.getAttribute('src')).toMatch(/^\.\.\/\.\.\//);
    }
  });

  it('escapes its title and footer', () => {
    fc.assert(
      fc.property(hostile, hostile, (title, footer) => {
        const doc = parse(
          offlinePageHtml({
            lang: 'en',
            dir: 'rtl',
            title,
            root: '../../',
            fragment: '',
            footer,
          }),
        );
        expect(doc.querySelectorAll('script, img, svg')).toHaveLength(0);
        expect(doc.querySelector('footer')?.textContent).toBe(
          footer.replace(/\r\n?/g, '\n').replace(/\0/g, '�'),
        );
      }),
    );
  });
});

describe('manualHeadings', () => {
  it('lists each module and section with the ID the rendered manual gives it', () => {
    const manual = fixtureManual();
    const html = renderManualHtml(manual, { assetUrl: () => '' }).html;
    const doc = parse(html);
    const headings = manualHeadings(manual);
    expect(headings.length).toBeGreaterThan(0);
    for (const h of headings) {
      expect(doc.getElementById(h.id)).not.toBeNull();
    }
    expect(new Set(headings.map((h) => h.id)).size).toBe(headings.length);
  });
});

describe('OFFLINE_SITE_CSS', () => {
  it('uses the theme’s variables, no colour of its own and nothing from outside', () => {
    expect(OFFLINE_SITE_CSS).not.toMatch(/#[0-9a-f]{3,8}\b|rgb|oklch|url\(/i);
    expect(OFFLINE_SITE_CSS).toContain('var(--background)');
  });
});
