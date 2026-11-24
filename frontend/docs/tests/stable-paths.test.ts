import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  checkStablePaths,
  pageFile,
  STABLE_FILES,
  STABLE_PAGES,
} from '../scripts/lib/stable-paths.mjs';
import {
  REDIRECTS,
  redirectPage,
  writeRedirectPages,
} from '../scripts/lib/redirects.mjs';

describe('the stable addresses', () => {
  let out: string;
  beforeEach(() => {
    out = mkdtempSync(join(tmpdir(), 'docs-out-'));
  });
  afterEach(() => rmSync(out, { recursive: true, force: true }));

  const put = (path: string, text: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  const site = () => {
    for (const path of STABLE_PAGES) {
      put(pageFile(out, path), '<html lang="en">');
      put(
        pageFile(out, path === '/' ? '/de' : `/de${path}`),
        '<html lang="de">',
      );
    }
    writeRedirectPages(out);
    // The page a redirect leads to.
    for (const to of Object.values(REDIRECTS)) {
      put(pageFile(out, to), '<html lang="en">');
      put(pageFile(out, `/de${to}`), '<html lang="de">');
    }
    for (const path of STABLE_FILES)
      put(
        join(out, path),
        path.endsWith('.json')
          ? '{"articles":[{"id":"guide","urls":{"en":"/guide","de":"/de/guide"}}]}'
          : 'text',
      );
  };

  it('hold in a site that has every one', () => {
    site();
    expect(checkStablePaths(out)).toEqual([]);
  });

  it('cover the addresses the landing page links to', () => {
    expect(STABLE_PAGES).toEqual(
      expect.arrayContaining([
        '/',
        '/api',
        '/api/delivery',
        '/api/management',
        '/getting-started',
        '/self-hosting',
        '/guides/rag',
        '/guides/mcp',
        '/changelog',
        '/agents',
        '/guide',
      ]),
    );
    expect(STABLE_FILES).toEqual(
      expect.arrayContaining([
        '/agents.md',
        '/llms.txt',
        '/llms-full.txt',
        '/guide-index.json',
      ]),
    );
  });

  it('fail for a missing page in either language, a page in the wrong language and a missing file', () => {
    site();
    rmSync(pageFile(out, '/de/api/delivery'));
    put(pageFile(out, '/de/guide'), '<html lang="en">');
    rmSync(join(out, 'llms.txt'));
    expect(checkStablePaths(out)).toEqual([
      expect.stringMatching(/^\/de\/api\/delivery: no page/),
      '/de/guide: the page is not in German',
      expect.stringMatching(/^\/llms\.txt: no file/),
    ]);
  });

  it('fail for an article of the guide index whose page is not in the site', () => {
    site();
    put(
      join(out, 'guide-index.json'),
      JSON.stringify({
        articles: [
          { id: 'guide', urls: { en: '/guide', de: '/de/guide' } },
          { id: 'guide.gone', urls: { en: '/guide/gone' } },
        ],
      }),
    );
    expect(checkStablePaths(out)).toEqual([
      '/guide-index.json: guide.gone (en) names /guide/gone, which is no page',
    ]);
  });

  it('keep an address that moved as a redirect page to the new one, in both languages', () => {
    expect(REDIRECTS['/guide/integrations/static-portal']).toBe(
      '/guide/portal',
    );
    site();
    const en = readFileSync(
      pageFile(out, '/guide/integrations/static-portal'),
      'utf8',
    );
    expect(en).toContain('<html lang="en">');
    expect(en).toContain(
      'http-equiv="refresh" content="0; url=/guide/portal/"',
    );
    expect(en).toContain('<a href="/guide/portal/">');
    const de = readFileSync(
      pageFile(out, '/de/guide/integrations/static-portal'),
      'utf8',
    );
    expect(de).toContain('<html lang="de">');
    expect(de).toContain('url=/de/guide/portal/"');
    expect(redirectPage('de', '/guide/portal')).toContain('umgezogen');
  });

  it('fail for a moved address without its redirect, or one that leads nowhere', () => {
    site();
    rmSync(pageFile(out, '/guide/integrations/static-portal'));
    rmSync(pageFile(out, '/de/guide/portal'));
    expect(checkStablePaths(out)).toEqual([
      expect.stringMatching(
        /^\/guide\/integrations\/static-portal: no redirect/,
      ),
      '/de/guide/integrations/static-portal: redirects to /de/guide/portal/, which is no page',
    ]);
  });
});
