import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  type TestRequest,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';

import { provideZard } from '@openfolia/ui/core';

import { ReadRef } from '../api';
import { MeService } from '../permissions/me';
import { ChangeSetSession } from '../session/change-set-session';
import { TerminologyPage } from './terminology.page';

const config = {
  languages: { source: 'en', targets: ['de'] },
  moduleTypes: [],
  audiences: [],
  facets: [],
  variantAttributes: [],
  textAttributes: [],
  safetySymbols: [],
  outputLabels: {},
};

const term = (
  id: string,
  status: 'proposed' | 'approved' | 'deprecated',
  languages: Record<string, string>,
  extra: Record<string, unknown> = {},
) => ({
  type: 'Term',
  id,
  attributes: {
    schemaVersion: 1,
    status,
    ...extra,
    languages: Object.fromEntries(
      Object.entries(languages).map(([lang, preferred]) => [
        lang,
        { preferred, allowed: [], forbidden: [] },
      ]),
    ),
  },
  meta: { issues: [] },
});

const terms = [
  term(
    'battery',
    'approved',
    { en: 'battery', de: 'Akku' },
    {
      domain: 'power',
    },
  ),
  term(
    'power-pack',
    'deprecated',
    { en: 'power pack' },
    { domain: 'power', replacedBy: 'battery' },
  ),
];

const page = (data: unknown[], perPage = 25) => ({
  data,
  meta: {
    page: { currentPage: 1, lastPage: 1, perPage, total: data.length },
  },
  links: { self: '', first: '', last: '', prev: null, next: null },
});

const flush = () => new Promise((resolve) => setTimeout(resolve));

async function render(url = '/terminology', permissions = ['content.read']) {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: 'terminology', children: [] }]),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideZard(),
    ],
  });
  TestBed.inject(MeService).set({
    id: 'u1',
    kind: 'user',
    name: 'U',
    role: '',
    permissions: new Set(permissions),
    editsEverything: true,
  });
  const router = TestBed.inject(Router);
  await router.navigateByUrl(url);
  const fixture = TestBed.createComponent(TerminologyPage);
  const http = TestBed.inject(HttpTestingController);
  const draw = async () => {
    for (let i = 0; i < 3; i++) {
      await flush();
      fixture.detectChanges();
    }
  };
  await draw();
  http
    .match('/api/config')
    .forEach((r) => r.flush({ data: { attributes: config } }));
  // The index (200 a page): every term.
  http
    .match(
      (r) => r.url === '/api/terms' && r.params.get('page[size]') === '200',
    )
    .forEach((r) => r.flush(page(terms, 200)));
  await draw();
  const list = (): TestRequest => {
    const found = http
      .match(
        (r) => r.url === '/api/terms' && r.params.get('page[size]') !== '200',
      )
      .filter((r) => !r.cancelled);
    expect(found.length).toBeGreaterThan(0);
    return found.at(-1)!;
  };
  const el = fixture.nativeElement as HTMLElement;
  return { fixture, http, el, draw, list, router };
}

describe('the terminology page', () => {
  afterEach(() => document.querySelector('.cdk-overlay-container')?.remove());

  it('lists the terms with a column per language, the definition, domain and status in words', async () => {
    const { el, draw, list } = await render();
    const req = list();
    expect(req.request.params.get('page[size]')).toBe('25');
    expect(req.request.params.get('page[number]')).toBe('1');
    req.flush(page(terms));
    await draw();
    const heads = Array.from(el.querySelectorAll('th')).map((th) =>
      th.textContent?.trim(),
    );
    expect(heads).toEqual([
      'English',
      'German',
      'Definition',
      'Domain',
      'Status',
    ]);
    const rows = Array.from(
      el.querySelectorAll<HTMLElement>('[data-slot="term-row"]'),
    );
    expect(rows.map((r) => r.dataset['term'])).toEqual([
      'battery',
      'power-pack',
    ]);
    expect(rows[0]!.textContent).toContain('Akku');
    // The ID only where it differs from the preferred term.
    expect(rows[0]!.querySelector('[data-slot="term-id"]')).toBeNull();
    expect(rows[1]!.querySelector('[data-slot="term-id"]')?.textContent).toBe(
      'power-pack',
    );
    // A missing language says so to a screen reader, not only with a dash.
    expect(rows[1]!.textContent).toContain('Not in this language');
    expect(
      rows.map((r) =>
        r.querySelector('[data-slot="term-status"]')?.textContent?.trim(),
      ),
    ).toEqual(['Approved', 'Deprecated']);
    // The rows scroll in their frame, long values wrap; the pagination sits outside.
    const table = el.querySelector('[data-slot="terms-table"]') as HTMLElement;
    expect(table.innerHTML).toContain('[overflow-wrap:anywhere]');
    expect(el.textContent).toContain('Page 1 of 1 (2 in total)');
  });

  it('asks the API for the filters and the search, kept in the URL', async () => {
    const { list, draw, router } = await render(
      '/terminology?lang=de&domain=power&status=deprecated&q=pack&page=2',
    );
    const req = list();
    const params = req.request.params;
    expect(params.get('filter[lang]')).toBe('de');
    expect(params.get('filter[domain]')).toBe('power');
    expect(params.get('filter[status]')).toBe('deprecated');
    expect(params.get('filter[q]')).toBe('pack');
    expect(params.get('page[number]')).toBe('2');
    req.flush(page([]));
    await draw();
    expect(router.url).toContain('status=deprecated');
  });

  it('says when no term matches the filters, with a way back', async () => {
    const { el, list, draw } = await render('/terminology?status=proposed');
    list().flush(page([]));
    await draw();
    expect(el.textContent).toContain('No term matches');
    expect(el.querySelector('[data-slot="filters-reset"]')).not.toBeNull();
  });

  it('opens a term in the panel from its row, in the URL, read-only without a revision', async () => {
    const { el, list, draw, router, http } = await render('/terminology', [
      'content.read',
      'content.edit',
    ]);
    list().flush(page(terms));
    await draw();
    (
      el.querySelector('[data-term="power-pack"] button') as HTMLButtonElement
    ).click();
    await draw();
    expect(router.url).toContain('term=power-pack');
    http
      .match((r) => r.url === '/api/terms/power-pack')
      .forEach((r) => r.flush({ data: terms[1] }));
    await draw();
    const panel = el.querySelector('[data-slot="term-panel"]') as HTMLElement;
    expect(panel).not.toBeNull();
    expect(panel.textContent).toContain('power pack');
    expect(panel.textContent).toContain('Replaced by');
    expect(panel.textContent).toContain('Choose or start a revision');
    expect(panel.querySelector('input')).toBeNull();
  });

  it('offers New term to an editor (blocked without a revision) and never to a reader', async () => {
    const editor = await render('/terminology', [
      'content.read',
      'content.edit',
    ]);
    editor.list().flush(page(terms));
    await editor.draw();
    const button = editor.el.querySelector(
      '[data-slot="new-term"]',
    ) as HTMLButtonElement;
    expect(button).not.toBeNull();
    expect(button.getAttribute('aria-disabled')).toBe('true');
    TestBed.resetTestingModule();

    const reader = await render();
    reader.list().flush(page(terms));
    await reader.draw();
    expect(
      reader.el.querySelector('[data-slot="new-term"]')?.hasAttribute('hidden'),
    ).toBe(true);
    // Export is for everyone who reads.
    expect(reader.el.querySelector('[data-slot="export-tbx"]')).not.toBeNull();
    expect(reader.el.querySelector('[data-slot="export-csv"]')).not.toBeNull();
  });

  it('keeps no configuration read before a switch that answers while it is unanswered (#716)', async () => {
    const { fixture, http, draw, list } = await render();
    list().flush(page(terms));
    await draw();
    const shown = () =>
      (
        fixture.componentInstance as unknown as {
          config: () => { languages: { targets: string[] } } | null;
        }
      ).config()?.languages.targets;
    expect(shown()).toEqual(['de']);
    // Read again at another branch; a switch begins before the configuration answers.
    TestBed.inject(ReadRef).ref.set('change-sets/cs1');
    await draw();
    const before = http.match((r) => r.url === '/api/config');
    expect(before).toHaveLength(1);
    TestBed.inject(ChangeSetSession).beginSwitch();
    await draw();
    before[0]!.flush({
      data: {
        attributes: { ...config, languages: { source: 'en', targets: ['fr'] } },
      },
    });
    await draw();
    expect(shown()).not.toEqual(['fr']);
  });
});
