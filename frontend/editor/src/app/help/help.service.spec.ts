import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { provideZard } from '@openfolia/ui/core';
import { LanguageService, provideI18nTesting } from '@openfolia/ui/i18n';
import { PAGE_HELP, PageHeaderComponent } from '@openfolia/ui/shell';

// The library's texts are files, not code (as `testing/test-providers.ts` reads them).
// eslint-disable-next-line no-restricted-imports, @nx/enforce-module-boundaries
import uiEn from '../../../../ui/src/i18n/en.json';
// eslint-disable-next-line no-restricted-imports, @nx/enforce-module-boundaries
import uiDe from '../../../../ui/src/i18n/de.json';
import editorDe from '../../i18n/de.json';
import editorEn from '../../i18n/en.json';
import { provideApi } from '../api';
import {
  docsBase,
  GUIDE_INDEX_LOADER,
  guideHref,
  HelpService,
  parseGuideIndex,
} from './help.service';
import { HelpMenuItemsComponent } from './help-menu-items.component';
import { ShortcutsOverlay } from '../shortcuts/shortcuts-overlay.component';

const DOCS = 'https://docs.example.org/';

const INDEX = {
  articles: [
    {
      id: 'guide.writing.content-browser',
      urls: {
        en: '/guide/writing/content-browser',
        de: '/de/guide/writing/content-browser',
      },
      title: { en: 'Find a module', de: 'Ein Modul finden' },
      summary: {
        en: 'The Content list: groups, filters, search.',
        de: 'Die Liste Inhalte: Gruppen, Filter, Suche.',
      },
    },
    {
      id: 'guide.writing.terminology',
      urls: {
        en: '/guide/writing/terminology',
        de: '/de/guide/writing/terminology',
      },
      title: { en: 'Terminology', de: 'Terminologie' },
      summary: {
        en: 'Keep the words everyone must use, and export them for translators.',
        de: 'Pflegen Sie die Wörter, die alle verwenden müssen.',
      },
    },
  ],
};

const about = (docsUrl: string | null) => ({
  data: {
    type: 'About',
    id: 'about',
    attributes: {
      license: 'AGPL-3.0-only',
      licenseUrl: 'https://www.gnu.org/licenses/agpl-3.0.html',
      sourceUrl: null,
      docsUrl,
    },
  },
});

@Component({ template: '' })
class Blank {}

@Component({
  selector: 'of-test-page',
  imports: [PageHeaderComponent],
  template: `<of-page-header title="Content" />`,
})
class Page {}

/** Lets the service's promise chains finish. */
const settled = () => new Promise((resolve) => setTimeout(resolve));

describe('the in-app help', () => {
  let http: HttpTestingController;
  let loader: () => Promise<unknown>;

  beforeEach(() => {
    loader = () => Promise.resolve(INDEX);
    TestBed.configureTestingModule({
      providers: [
        provideZard(),
        provideI18nTesting({
          en: { ui: uiEn, editor: editorEn },
          de: { ui: uiDe, editor: editorDe },
        }),
        provideApi(),
        provideHttpClientTesting(),
        provideRouter([
          {
            path: 'content',
            data: { help: 'guide.writing.content-browser' },
            children: [
              { path: '', component: Page },
              {
                path: 'terms',
                data: { help: 'guide.writing.terminology' },
                component: Blank,
              },
            ],
          },
          { path: 'elsewhere', component: Page },
        ]),
        { provide: GUIDE_INDEX_LOADER, useValue: () => loader() },
        {
          provide: PAGE_HELP,
          useFactory: () => TestBed.inject(HelpService).page,
        },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    vi.restoreAllMocks();
    // A language chosen here is remembered: the next spec starts in English again.
    localStorage.clear();
  });

  /** The service, read: `GET /about` answered with `docsUrl`. */
  const ready = async (docsUrl: string | null = DOCS) => {
    const help = TestBed.inject(HelpService);
    help.load();
    http.expectOne('/api/about').flush(about(docsUrl));
    await settled();
    return help;
  };

  it('links a screen to its page by the article ID its route names, the deepest one', async () => {
    const help = await ready();
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/content');
    expect(help.page()).toEqual({
      href: `${DOCS}guide/writing/content-browser`,
      title: 'Find a module',
    });
    await router.navigateByUrl('/content/terms');
    expect(help.page()?.href).toBe(`${DOCS}guide/writing/terminology`);
    await router.navigateByUrl('/elsewhere');
    expect(help.page()).toBeNull();
  });

  it('opens the page in the interface language', async () => {
    const help = await ready();
    await TestBed.inject(Router).navigateByUrl('/content');
    await TestBed.inject(LanguageService).choose('de');
    expect(help.page()).toEqual({
      href: `${DOCS}de/guide/writing/content-browser`,
      title: 'Ein Modul finden',
    });
  });

  it('keeps a docs site under a sub-path, and adds its trailing slash', async () => {
    const help = await ready('https://intranet.example.org/docs/v2');
    expect(help.href('guide.writing.terminology')).toBe(
      'https://intranet.example.org/docs/v2/guide/writing/terminology',
    );
  });

  it('shows no link while the operator turned the links off', async () => {
    const help = await ready(null);
    await TestBed.inject(Router).navigateByUrl('/content');
    expect(help.enabled()).toBe(false);
    expect(help.page()).toBeNull();
    expect(help.search('filters')).toEqual([]);
  });

  it('shows no link for an index it cannot read, and reads it again on the next call', async () => {
    let calls = 0;
    loader = () => {
      calls++;
      return calls === 1
        ? Promise.reject(new Error('offline'))
        : Promise.resolve(INDEX);
    };
    const help = await ready();
    expect(help.enabled()).toBe(false);
    help.load();
    await settled();
    expect(help.enabled()).toBe(true);
    expect(calls).toBe(2);
  });

  it('finds a page by a word of its summary, titles holding the words first', async () => {
    const help = await ready();
    expect(help.search('translators').map((m) => m.id)).toEqual([
      'guide.writing.terminology',
    ]);
    expect(help.search('FILTERS search').map((m) => m.href)).toEqual([
      `${DOCS}guide/writing/content-browser`,
    ]);
    expect(help.search('module').map((m) => m.id)).toEqual([
      'guide.writing.content-browser',
    ]);
    expect(help.search('   ')).toEqual([]);
    await TestBed.inject(LanguageService).choose('de');
    expect(help.search('worter').map((m) => m.title)).toEqual(['Terminologie']);
  });

  it('puts the link into every page header, with the page’s title', async () => {
    await ready();
    await TestBed.inject(Router).navigateByUrl('/content');
    const fixture = TestBed.createComponent(Page);
    fixture.detectChanges();
    const link = (
      fixture.nativeElement as HTMLElement
    ).querySelector<HTMLAnchorElement>('[data-slot="page-help"]');
    expect(link?.href).toBe(`${DOCS}guide/writing/content-browser`);
    expect(link?.target).toBe('_blank');
    expect(link?.rel).toBe('noopener noreferrer');
    expect(link?.getAttribute('aria-label')).toBe(
      'Help: Find a module (opens in a new tab)',
    );
  });

  it('opens the page and the shortcuts from the account menu', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    await TestBed.inject(Router).navigateByUrl('/content');
    const fixture = TestBed.createComponent(HelpMenuItemsComponent);
    http.expectOne('/api/about').flush(about(DOCS));
    await settled();
    fixture.detectChanges();
    const item = (id: string) =>
      (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>(
        `[data-testid="${id}"]`,
      );
    item('help-page')?.click();
    expect(open).toHaveBeenCalledWith(
      `${DOCS}guide/writing/content-browser`,
      '_blank',
      'noopener,noreferrer',
    );
    item('help-shortcuts')?.click();
    expect(TestBed.inject(ShortcutsOverlay).isOpen()).toBe(true);
  });
});

describe('the help links’ addresses', () => {
  it('take only an http(s) docs site without credentials', () => {
    expect(docsBase('https://docs.example.org')).toBe(
      'https://docs.example.org/',
    );
    expect(docsBase('http://10.0.0.5:8080/docs/?x=1#y')).toBe(
      'http://10.0.0.5:8080/docs/',
    );
    expect(docsBase('javascript:alert(1)')).toBeNull();
    expect(docsBase('data:text/html,hi')).toBeNull();
    expect(docsBase('https://user:secret@docs.example.org/')).toBeNull();
    expect(docsBase('not a url')).toBeNull();
    expect(docsBase(null)).toBeNull();
  });

  it('never leave the docs site', () => {
    expect(guideHref(DOCS, '/guide/x')).toBe(`${DOCS}guide/x`);
    expect(guideHref(DOCS, '//evil.example/x')).toBeNull();
    expect(guideHref(DOCS, 'https://evil.example/x')).toBeNull();
    expect(guideHref(`${DOCS}v2/`, '/../../x')).toBeNull();
  });

  it('read only well-formed articles from the index', () => {
    const parsed = parseGuideIndex({
      articles: [
        INDEX.articles[0],
        { id: 'no-urls', title: {}, summary: {} },
        { id: 3 },
        null,
      ],
    });
    expect([...parsed.keys()]).toEqual(['guide.writing.content-browser']);
    expect(parseGuideIndex('nonsense').size).toBe(0);
  });
});
