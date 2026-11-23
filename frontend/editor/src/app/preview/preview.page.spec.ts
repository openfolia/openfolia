import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';

import { provideZard } from '@openfolia/ui/core';

import { API_DEMO_USER, ReadRef } from '../api';
import {
  apiErrorInterceptor,
  demoUserInterceptor,
} from '../api/api-interceptors';
import { MeService } from '../permissions/me';
import { ChangeSetSession } from '../session/change-set-session';
import { provideChangeSetUrl } from '../session/change-set-url';
import { PreviewPage } from './preview.page';

const CS = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const BRANCH = `change-sets/${CS}`;
const HASH = 'b'.repeat(64);

const config = {
  data: {
    type: 'ProjectConfig',
    id: 'config',
    attributes: {
      languages: { source: 'en', targets: ['de'] },
      moduleTypes: [{ id: 'concept', label: 'Concept' }],
      audiences: [{ id: 'public', label: 'Public' }],
      facets: [],
      variantAttributes: [
        {
          id: 'model',
          label: 'Model',
          kind: 'enum',
          values: [
            { id: 'small', label: 'Small' },
            { id: 'large', label: 'Large' },
          ],
        },
      ],
      textAttributes: [],
      safetySymbols: [],
      outputLabels: {},
    },
  },
};

const page = (data: unknown[]) => ({
  data,
  meta: {
    page: { currentPage: 1, lastPage: 1, perPage: 100, total: data.length },
  },
  links: { self: '', first: '', last: '', prev: null, next: null },
});

const manuals = page([
  {
    type: 'Manual',
    id: 'operating',
    attributes: {
      schemaVersion: 1,
      title: 'Operating manual',
      variants: [{ model: 'small' }, { model: 'large' }],
      textAttributes: {},
      entries: [{ module: 'charging' }],
    },
    meta: {
      variants: [
        { slug: 'model=small', label: 'Small', values: { model: 'small' } },
        { slug: 'model=large', label: 'Large', values: { model: 'large' } },
      ],
      issues: [],
    },
  },
]);

const summaries = page([
  {
    type: 'ModuleSummary',
    id: 'charging',
    attributes: {
      moduleId: 'charging',
      title: 'Charging',
      titleLang: 'en',
      moduleType: 'concept',
      facets: {},
      keywords: [],
      languages: ['en', 'de'],
      variants: ['model=large'],
    },
    meta: { changed: true },
  },
]);

/** A withdrawn release with the tag `tag`, as `GET /releases?filter[state]=withdrawn` lists it. */
const release = (tag: string) => ({
  type: 'Release',
  id: `id-${tag}`,
  attributes: {
    product: 'north',
    productFacet: 'region',
    revision: '2.1',
    tag,
    tagObject: 'a'.repeat(40),
    commit: 'c'.repeat(40),
    notes: null,
    notesByLanguage: {},
    major: false,
    publishedBy: { kind: 'user', id: 'sample-publisher' },
    publishedAt: '2026-01-01T10:00:00Z',
    withdrawal: {
      by: { kind: 'user', id: 'sample-publisher' },
      at: '2026-01-02T10:00:00Z',
      reason: 'Wrong torque values.',
    },
  },
});

const html = `<!doctype html><html lang="en"><head><title>Charging</title>
<link rel="stylesheet" href="../../../preview/theme.css">
<script>alert(1)</script></head>
<body><article class="of-content of-module"><h1>Charging</h1><p>Plug it in.</p>
<img alt="Charger" src="../../../assets/${HASH}?ref=${encodeURIComponent(BRANCH)}"></article></body></html>`;

const hidden = (total: number) => ({
  data: [
    {
      type: 'HiddenContent',
      id: 'block:charging#large-only',
      attributes: {
        kind: 'block',
        module: 'charging',
        blockId: 'large-only',
        condition: { op: 'in', attr: 'model', values: ['large'] },
      },
      meta: { label: 'Large battery pack', expression: 'model in (large)' },
    },
  ].slice(0, total),
  meta: {
    page: { currentPage: 1, lastPage: 1, perPage: 25, total },
    commit: 'c1',
  },
  links: { self: '', first: '', last: '', prev: null, next: null },
});

async function render(url: string) {
  localStorage.setItem(
    'openfolia.change-set',
    JSON.stringify({ id: CS, title: 'Trial', branch: BRANCH }),
  );
  TestBed.configureTestingModule({
    providers: [
      provideRouter([
        {
          path: 'preview',
          component: PreviewPage,
          data: { changeSetParam: 'session' },
        },
      ]),
      provideChangeSetUrl(),
      provideHttpClient(
        withInterceptors([demoUserInterceptor, apiErrorInterceptor]),
      ),
      { provide: API_DEMO_USER, useValue: signal('author') },
      provideHttpClientTesting(),
      provideZard(),
    ],
  });
  TestBed.inject(ReadRef).ref.set(BRANCH);
  TestBed.inject(MeService).set({
    id: 'author',
    kind: 'user',
    name: 'Author',
    role: '',
    permissions: new Set(['content.read']),
  });
  const { RouterTestingHarness } = await import('@angular/router/testing');
  const harness = await RouterTestingHarness.create();
  const http = TestBed.inject(HttpTestingController);
  void harness.navigateByUrl(url);
  const settle = async () => {
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 0));
      await harness.fixture.whenStable();
    }
  };
  await settle();
  return {
    http,
    settle,
    el: () => harness.routeNativeElement as HTMLElement,
  };
}

/** Answers what the page reads first: the configuration, the manuals and the module. */
async function answerContext(
  http: HttpTestingController,
  settle: () => Promise<void>,
  module = true,
) {
  http.expectOne((r) => r.url === '/api/config').flush(config);
  http.expectOne((r) => r.url === '/api/manuals').flush(manuals);
  if (module) {
    http.expectOne((r) => r.url === '/api/module-summaries').flush(summaries);
  }
  await settle();
}

describe('PreviewPage', () => {
  let created = 0;
  beforeEach(() => {
    created = 0;
    // Spies, not assignments: undone after each test (testing/test-setup.ts).
    vi.spyOn(URL, 'createObjectURL').mockImplementation(
      () => `blob:test/${++created}`,
    );
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  });

  it('shows the module for the manual’s first variant in a sandboxed frame, with what it hides', async () => {
    const { http, settle, el } = await render(
      `/preview?module=charging&lang=en`,
    );
    await answerContext(http, settle);

    const pageReq = http.expectOne((r) =>
      r.url.endsWith('/api/modules/en/charging/preview'),
    );
    expect(pageReq.request.params.get('variant')).toBe('model=small');
    expect(pageReq.request.params.get('ref')).toBe(BRANCH);
    expect(pageReq.request.params.get('theme')).toBe('light');
    expect(pageReq.request.params.has('view')).toBe(false);
    expect(pageReq.request.headers.get('Accept')).toBe('text/html');
    expect(pageReq.request.responseType).toBe('text');
    const hiddenReq = http.expectOne((r) =>
      r.url.endsWith('/api/modules/en/charging/hidden-content'),
    );
    expect(hiddenReq.request.params.get('variant')).toBe('model=small');
    expect(hiddenReq.request.params.get('ref')).toBe(BRANCH);
    hiddenReq.flush(hidden(1));
    pageReq.flush(html);
    await settle();

    // The image is read with the person's credentials, then shown as a blob.
    const image = http.expectOne((r) => r.url.includes(`/api/assets/${HASH}`));
    expect(image.request.responseType).toBe('blob');
    // Under the API's base, so the person's identity goes with it (a draft's images are theirs).
    expect(image.request.url.startsWith('/api/assets/')).toBe(true);
    expect(image.request.headers.get('X-Ccms-User')).toBe('author');
    image.flush(new Blob(['png'], { type: 'image/png' }));
    await settle();

    const frame = el().querySelector('iframe');
    expect(frame?.getAttribute('sandbox')).toBe('allow-same-origin');
    const srcdoc = frame?.srcdoc ?? '';
    expect(srcdoc).toContain('Plug it in.');
    expect(srcdoc).toContain('src="blob:test/1"');
    expect(srcdoc).toContain("script-src 'none'");
    expect(srcdoc).not.toContain('<script');
    expect(frame?.getAttribute('title')).toBe('Preview of Charging');

    const text = el().textContent ?? '';
    expect(text).toContain('Draft preview.');
    expect(text).toContain('Hidden for this variant:');
    expect(text).toContain('Large battery pack');
    expect(text).toContain('(Model: Large)');

    const show = [...el().querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Show hidden blocks',
    );
    expect(show?.getAttribute('aria-expanded')).toBe('false');
    show?.click();
    await settle();
    expect(TestBed.inject(Router).url).toContain('hidden=shown');
    expect(el().textContent).toContain('Block in charging');
    http.verify();
  });

  it('shows a module as released: everything read at the release’s tag, no draft', async () => {
    const tag = 'release/north/2.1';
    const { http, settle, el } = await render(
      `/preview?module=charging&lang=en&tag=${encodeURIComponent(tag)}`,
    );
    const configReq = http.expectOne((r) => r.url === '/api/config');
    expect(configReq.request.params.get('ref')).toBe(tag);
    configReq.flush(config);
    const manualsReq = http.expectOne((r) => r.url === '/api/manuals');
    expect(manualsReq.request.params.get('ref')).toBe(tag);
    manualsReq.flush(manuals);
    const summariesReq = http.expectOne(
      (r) => r.url === '/api/module-summaries',
    );
    expect(summariesReq.request.params.get('ref')).toBe(tag);
    summariesReq.flush(summaries);
    await settle();

    const pageReq = http.expectOne((r) =>
      r.url.endsWith('/api/modules/en/charging/preview'),
    );
    expect(pageReq.request.params.get('ref')).toBe(tag);
    expect(pageReq.request.method).toBe('GET');
    const hiddenReq = http.expectOne((r) =>
      r.url.endsWith('/api/modules/en/charging/hidden-content'),
    );
    expect(hiddenReq.request.params.get('ref')).toBe(tag);
    hiddenReq.flush(hidden(0));
    pageReq.flush(html);
    await settle();
    http.match((r) => r.url.includes('/api/assets/'));

    const text = el().textContent ?? '';
    expect(text).toContain(`Release ${tag}`);
    expect(text).toContain('Content as released.');
    expect(text).not.toContain('Include unsaved changes');
    // The release stands: not marked withdrawn.
    http
      .expectOne((r) => r.url === '/api/releases')
      .flush(page([release('release/south/1.0')]));
    await settle();
    expect(el().querySelector('[data-slot="withdrawal"]')).toBeNull();
    expect(el().querySelector('[data-slot="withdrawn-badge"]')).toBeNull();
  });

  it('marks a withdrawn release read at its tag, with who, when and why (#330)', async () => {
    const tag = 'release/north/2.1';
    const { http, settle, el } = await render(
      `/preview?module=charging&lang=en&tag=${encodeURIComponent(tag)}`,
    );
    const releasesReq = http.expectOne((r) => r.url === '/api/releases');
    expect(releasesReq.request.params.get('filter[state]')).toBe('withdrawn');
    expect(releasesReq.request.params.get('ref')).toBeNull();
    releasesReq.flush(page([release('release/south/1.0'), release(tag)]));
    await settle();

    const note = el().querySelector('[data-slot="withdrawal"]');
    expect(note?.getAttribute('role')).toBe('note');
    expect(note?.textContent).toContain(
      `Release ${tag} was withdrawn by sample-publisher on`,
    );
    expect(note?.textContent).toContain('Wrong torque values.');
    expect(
      el().querySelector('[data-slot="withdrawn-badge"]')?.textContent,
    ).toContain('Withdrawn');
    http.match(() => true);
  });

  it('previews the whole manual for the chosen variant, and says when nothing is hidden', async () => {
    const { http, settle, el } = await render(
      `/preview?module=charging&scope=manual&variant=model%3Dlarge&lang=de`,
    );
    await answerContext(http, settle);
    const pageReq = http.expectOne((r) =>
      r.url.endsWith('/api/manuals/operating/variants/model%3Dlarge/de/html'),
    );
    expect(pageReq.request.params.has('variant')).toBe(false);
    // The editor's view of the manual: its page breaks show.
    expect(pageReq.request.params.get('view')).toBe('editor');
    http
      .expectOne((r) =>
        r.url.endsWith(
          '/api/manuals/operating/variants/model%3Dlarge/de/hidden-content',
        ),
      )
      .flush(hidden(0));
    pageReq.flush(html.replace(/<img[^>]*>/, ''));
    await settle();
    expect(el().textContent).toContain('Nothing is hidden for this variant.');
    expect(el().textContent).not.toContain('Show hidden blocks');
    const back = [...el().querySelectorAll('a')].find(
      (a) => a.textContent?.trim() === 'Back to editor',
    );
    expect(back?.getAttribute('href')).toBe(`/content/de/charging?cs=${CS}`);
    http.verify();
  });

  it('shows a failed preview with a retry, and reads it again', async () => {
    const { http, settle, el } = await render(`/preview?module=charging`);
    await answerContext(http, settle);
    http.expectOne((r) => r.url.endsWith('/hidden-content')).flush(hidden(0));
    http
      .expectOne((r) => r.url.endsWith('/preview'))
      .flush(
        { errors: [{ status: '503', code: 'unavailable', title: 'Busy' }] },
        { status: 503, statusText: 'Service Unavailable' },
      );
    await settle();
    expect(el().textContent).toContain('The preview could not be loaded');
    expect(el().querySelector('iframe')).toBeNull();
    const retry = [...el().querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Try again',
    );
    retry?.click();
    await settle();
    http.expectOne((r) => r.url.endsWith('/preview')).flush(html);
    http.match((r) => r.url.endsWith('/hidden-content'));
    await settle();
    http.match((r) => r.url.includes('/assets/'));
  });

  it('says a module that is not there is not there', async () => {
    const { http, settle, el } = await render(`/preview?module=charging`);
    await answerContext(http, settle);
    http.expectOne((r) => r.url.endsWith('/hidden-content')).flush(hidden(0));
    http
      .expectOne((r) => r.url.endsWith('/preview'))
      .flush(
        { errors: [{ status: '404', code: 'not-found', title: 'Not Found' }] },
        { status: 404, statusText: 'Not Found' },
      );
    await settle();
    expect(el().textContent).toContain('Nothing to preview here');
  });

  it('builds the manual’s PDF in the PDF output, listing what the manual hides', async () => {
    const { http, settle, el } = await render(
      `/preview?module=charging&output=pdf`,
    );
    await answerContext(http, settle);
    http.expectNone((r) => r.url.endsWith('/preview'));
    http
      .expectOne((r) =>
        r.url.endsWith(
          '/api/manuals/operating/variants/model%3Dsmall/en/hidden-content',
        ),
      )
      .flush(hidden(1));
    await settle();
    const text = el().textContent ?? '';
    expect(text).toContain('PDF of “Operating manual”');
    expect(text).toContain('Built for Small in English');
    expect(
      [...el().querySelectorAll('button')].some(
        (b) => b.textContent?.trim() === 'Build and open PDF',
      ),
    ).toBe(true);
    http.verify();
  });

  it('includes the unsaved changes of the person’s own draft by default, and leaves them out on request', async () => {
    const { http, settle, el } = await render(
      `/preview?module=charging&lang=en`,
    );
    void TestBed.inject(ChangeSetSession).refresh();
    http
      .expectOne((r) => r.url === '/api/change-sets')
      .flush(
        page([
          {
            type: 'ChangeSet',
            id: CS,
            attributes: {
              title: 'Trial',
              state: 'draft',
              branch: BRANCH,
              author: { id: 'author' },
              createdAt: '2026-01-01T00:00:00Z',
            },
          },
        ]),
      );
    await answerContext(http, settle);
    const live = http.expectOne((r) => r.url.endsWith('/preview'));
    expect(live.request.params.get('workingCopy')).toBe('true');
    expect(live.request.params.get('ref')).toBe(BRANCH);
    const liveHidden = http.expectOne((r) => r.url.endsWith('/hidden-content'));
    expect(liveHidden.request.params.get('workingCopy')).toBe('true');
    liveHidden.flush(hidden(0));
    live.flush(html.replace(/<img[^>]*>/, ''));
    await settle();
    expect(el().textContent).toContain('Draft preview, with unsaved changes.');

    const toggle = el().querySelector<HTMLButtonElement>(
      'z-switch button[role="switch"]',
    );
    expect(toggle?.getAttribute('aria-checked')).toBe('true');
    toggle?.click();
    await settle();
    expect(TestBed.inject(Router).url).toContain('unsaved=off');
    const committed = http.expectOne((r) => r.url.endsWith('/preview'));
    expect(committed.request.params.has('workingCopy')).toBe(false);
    expect(committed.request.params.get('ref')).toBe(BRANCH);
    const committedHidden = http.expectOne((r) =>
      r.url.endsWith('/hidden-content'),
    );
    expect(committedHidden.request.params.has('workingCopy')).toBe(false);
  });

  it('offers no unsaved changes for someone else’s draft', async () => {
    const { http, settle, el } = await render(
      `/preview?module=charging&lang=en`,
    );
    void TestBed.inject(ChangeSetSession).refresh();
    http
      .expectOne((r) => r.url === '/api/change-sets')
      .flush(
        page([
          {
            type: 'ChangeSet',
            id: CS,
            attributes: {
              title: 'Trial',
              state: 'draft',
              branch: BRANCH,
              author: { id: 'other' },
              createdAt: '2026-01-01T00:00:00Z',
            },
          },
        ]),
      );
    await answerContext(http, settle);
    expect(
      http
        .expectOne((r) => r.url.endsWith('/preview'))
        .request.params.has('workingCopy'),
    ).toBe(false);
    http.expectOne((r) => r.url.endsWith('/hidden-content'));
    expect(el().querySelector('z-switch')).toBeNull();
  });

  it('says what to do without a module or manual', async () => {
    const { http, settle, el } = await render('/preview');
    await answerContext(http, settle, false);
    expect(el().textContent).toContain('Nothing to preview');
    expect(el().querySelector('z-select')).toBeNull();
    http.verify();
  });
});
