import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  type TestRequest,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';

import { provideZard } from '@openfolia/ui/core';

import { apiErrorInterceptor } from '../api/api-interceptors';
import { MeService } from '../permissions/me';
import { DownloadsPage } from './downloads.page';
import type { DownloadItem, DownloadVersionItem } from './downloads-model';
import { ReleaseFiles } from './release-files';
import {
  answer,
  config,
  paged,
  RELEASE_ID,
  OTHER_ID,
} from './testing/releases';

type Req = TestRequest['request'];

const SHEET = 'attachment:north:datasheet:sheet:en';
const PDF = 'manual:north:operating:en:model=small';
const release = (id = RELEASE_ID, revision = '2.0') => ({
  id,
  tag: `release/north/${revision}`,
  revision,
  publishedAt: '2026-11-20T10:00:00.000Z',
});

const download = (
  id: string,
  over: Partial<DownloadItem['attributes']> = {},
  moduleTitle: string | null = 'Technical data',
): DownloadItem =>
  ({
    type: 'Download',
    id,
    attributes: {
      kind: 'attachment',
      product: 'north',
      lang: 'en',
      name: 'Datasheet',
      description: 'The values of every model',
      sha256: 'a'.repeat(64),
      size: 48_200,
      mediaType: 'application/zip',
      fileName: 'datasheet-with-a-very-long-name-that-has-to-wrap.zip',
      moduleId: 'datasheet',
      blockId: 'sheet',
      manualId: null,
      variant: null,
      release: release(),
      ...over,
    },
    meta: { moduleTitle },
    links: {
      versions: `/downloads/${encodeURIComponent(id)}/versions`,
      file: `/downloads/${encodeURIComponent(id)}/versions/${RELEASE_ID}/file`,
    },
  }) as DownloadItem;

const downloads = [
  download(SHEET),
  download(
    PDF,
    {
      kind: 'manual',
      name: 'Operating manual',
      description: null,
      mediaType: 'application/pdf',
      fileName: 'operating_model-small_en_2.0.pdf',
      moduleId: null,
      blockId: null,
      manualId: 'operating',
      variant: 'model=small',
    },
    null,
  ),
];

const version = (
  id: string,
  state: DownloadVersionItem['attributes']['state'],
  revision: string,
  hash: string,
  notes: string | null,
  description: string | null,
): DownloadVersionItem =>
  ({
    type: 'DownloadVersion',
    id,
    attributes: {
      state,
      sha256: hash.repeat(64),
      size: 48_200,
      mediaType: 'application/zip',
      fileName: 'datasheet.zip',
      release: release(id, revision),
      changeNote: { notes, description },
    },
    links: { file: '' },
  }) as DownloadVersionItem;

const versions = [
  version(
    RELEASE_ID,
    'current',
    '2.0',
    'b',
    'New torque values.',
    'The values of every model',
  ),
  version(
    OTHER_ID,
    'superseded',
    '1.0',
    'c',
    'First release.',
    'The first sheet',
  ),
];

const handlers = (list: readonly DownloadItem[] = downloads) =>
  [
    [
      (r: Req) => r.url === '/api/config',
      () => ({
        data: { type: 'ProjectConfig', id: 'main', attributes: config() },
      }),
    ],
    [(r: Req) => r.url === '/api/downloads', () => paged(list)],
    [
      (r: Req) => /^\/api\/downloads\/[^/]+\/versions$/.test(r.url),
      () => paged(versions, versions.length, { truncated: false }),
    ],
  ] as const;

async function render(url: string) {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([
        { path: 'releases', children: [] },
        { path: 'releases/downloads', component: DownloadsPage },
      ]),
      provideHttpClient(withInterceptors([apiErrorInterceptor])),
      provideHttpClientTesting(),
      provideZard(),
    ],
  });
  TestBed.inject(MeService).set({
    id: 'reader',
    kind: 'user',
    name: 'Reader',
    role: '',
    permissions: new Set(['content.read']),
  });
  const harness = await RouterTestingHarness.create();
  const http = TestBed.inject(HttpTestingController);
  void harness.navigateByUrl(url);
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 0));
      await harness.fixture.whenStable();
    }
  };
  await settle();
  return {
    http,
    settle,
    el: () => harness.routeNativeElement as HTMLElement,
    url: () => TestBed.inject(Router).url,
  };
}

const text = (el: Element | null | undefined) =>
  el?.textContent?.replace(/\s+/g, ' ').trim();
const rows = (el: HTMLElement) =>
  [...el.querySelectorAll('[data-slot="download-row"]')].map((r) =>
    [...r.querySelectorAll('td')].map(text),
  );

describe('DownloadsPage', () => {
  it('lists the downloads with their name, module or variant, kind, product, version and size', async () => {
    const { http, settle, el } = await render('/releases/downloads');
    const seen = await answer(http, handlers(), settle);
    const list = seen.find((r) => r.url === '/api/downloads');
    expect(list?.params.get('page[size]')).toBe('25');
    expect(list?.params.keys().filter((k) => k.startsWith('filter'))).toEqual(
      [],
    );
    const [sheet, pdf] = rows(el());
    expect(sheet?.[0]).toContain('Datasheet');
    expect(sheet?.[0]).toContain(
      'datasheet-with-a-very-long-name-that-has-to-wrap.zip · English',
    );
    expect(sheet?.[0]).toContain('In Technical data');
    expect(sheet?.[1]).toBe('Attachment');
    expect(sheet?.[2]).toBe('North');
    expect(sheet?.[3]).toBe('2.0');
    expect(sheet?.[4]).toBe('48.2 kB');
    expect(pdf?.[0]).toContain('Variant model=small');
    expect(pdf?.[1]).toBe('Manual (PDF)');
    // The tabs: this one marked as the page.
    const current = el().querySelector(
      '[data-slot="release-tabs"] [aria-current="page"]',
    );
    expect(text(current)).toBe('Downloads');
  });

  it('reads the list for the filters in the address, and says when nothing matches them', async () => {
    const { http, settle, el } = await render(
      '/releases/downloads?product=north&lang=de&kind=manual&q=torque&page=2',
    );
    const seen = await answer(http, handlers([]), settle);
    const list = seen.filter((r) => r.url === '/api/downloads');
    expect(list[0]?.params.get('filter[product]')).toBe('north');
    expect(list[0]?.params.get('filter[lang]')).toBe('de');
    expect(list[0]?.params.get('filter[kind]')).toBe('manual');
    expect(list[0]?.params.get('filter[q]')).toBe('torque');
    expect(list[0]?.params.get('page[number]')).toBe('2');
    expect(el().textContent).toContain('No downloads match');
    expect(
      el().querySelector<HTMLInputElement>('input[type="search"]')?.value,
    ).toBe('torque');
  });

  it('opens a download’s versions beside the list, newest first, with state, notes and checksum, and saves one', async () => {
    const { http, settle, el, url } = await render('/releases/downloads');
    await answer(http, handlers(), settle);
    el()
      .querySelector<HTMLElement>('[data-slot="download-row"] button')
      ?.click();
    await settle();
    const seen = await answer(http, handlers(), settle);
    expect(decodeURIComponent(url())).toContain(`download=${SHEET}`);
    const read = seen.find((r) => r.url.endsWith('/versions'));
    expect(read?.url).toBe(
      `/api/downloads/${encodeURIComponent(SHEET)}/versions`,
    );
    const panel = el().querySelector('[data-slot="download-panel"]');
    const shown = [
      ...(panel?.querySelectorAll('[data-slot="download-version"]') ?? []),
    ];
    expect(shown.map((v) => v.getAttribute('data-state'))).toEqual([
      'current',
      'superseded',
    ]);
    expect(text(shown[0])).toContain('Product version 2.0');
    expect(text(shown[0])).toContain('Current');
    expect(text(shown[0])).toContain('New torque values.');
    // Its description is the download's own: said once, above.
    expect(shown[0]?.querySelector('[data-slot="description"]')).toBeNull();
    expect(text(shown[1])).toContain('Superseded');
    expect(text(shown[1]?.querySelector('[data-slot="description"]'))).toBe(
      'The first sheet',
    );
    expect(
      shown[1]?.querySelector('[data-slot="checksum"]')?.getAttribute('title'),
    ).toBe('c'.repeat(64));
    expect(text(shown[1]?.querySelector('[data-slot="checksum"]'))).toBe(
      `SHA-256 ${'c'.repeat(12)}…`,
    );

    const save = vi
      .spyOn(TestBed.inject(ReleaseFiles), 'saveDownload')
      .mockResolvedValue();
    shown[1]
      ?.querySelector<HTMLElement>('[data-slot="download-version-file"]')
      ?.click();
    expect(save).toHaveBeenCalledWith(SHEET, OTHER_ID);
    // The row's button saves the current file.
    el()
      .querySelectorAll<HTMLElement>('[data-slot="download-file"]')[1]
      ?.click();
    expect(save).toHaveBeenLastCalledWith(PDF, RELEASE_ID);

    // Closing the panel forgets the choice in the address.
    panel
      ?.querySelector<HTMLElement>('[aria-label="Close the versions"]')
      ?.click();
    await settle();
    expect(url()).not.toContain('download=');
  });

  it('says why the list could not be read, and reads it again on request', async () => {
    const { http, settle, el } = await render('/releases/downloads');
    await answer(
      http,
      [
        handlers()[0],
        [
          (r: Req) => r.url === '/api/downloads',
          () => [
            503,
            { errors: [{ status: '503', code: 'unavailable', title: '' }] },
          ],
        ],
      ],
      settle,
    );
    expect(el().querySelector('[data-slot="download-row"]')).toBeNull();
    const retry = [...el().querySelectorAll('button')].find((b) =>
      /try again/i.test(b.textContent ?? ''),
    );
    expect(retry).toBeDefined();
    retry?.click();
    await settle();
    const seen = await answer(http, handlers(), settle);
    expect(seen.some((r) => r.url === '/api/downloads')).toBe(true);
    expect(rows(el())).toHaveLength(2);
  });
});
