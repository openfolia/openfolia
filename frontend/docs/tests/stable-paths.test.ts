import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  checkStablePaths,
  pageFile,
  STABLE_FILES,
  STABLE_PAGES,
} from '../scripts/lib/stable-paths.mjs';

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
});
