import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { provideZard } from '@openfolia/ui/core';

import { ImageSources } from '../images/image-sources';
import { MediaDetailComponent } from './media-detail.component';
import type { MediaItem } from './media-model';
import { UnusedLocator } from './media-unused';
import { MediaUsageReader } from './media-usage';

const HASH = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

const file = (change: Partial<MediaItem['meta']> = {}): MediaItem => ({
  type: 'Asset',
  id: HASH,
  attributes: {
    reference: `sha256:${HASH}`,
    fileName: null,
    contentType: 'image/png',
    size: 4096,
    width: 1600,
    height: 900,
    font: null,
  },
  meta: {
    usedIn: [{ moduleId: 'pump', lang: 'en', title: 'Pump' }],
    usedInCount: 1,
    usedInManuals: [],
    languages: ['en'],
    usedAs: ['image'],
    uploaded: false,
    missing: false,
    ...change,
  },
});

const module = (lang: string, title: string, hash: string, alt: string) => ({
  data: {
    type: 'Module',
    id: 'pump',
    attributes: {
      moduleId: 'pump',
      lang,
      schemaVersion: 1,
      title,
      moduleType: 'concept',
      facets: {},
      blocks: [{ type: 'image', id: 'img1', asset: `sha256:${hash}`, alt }],
    },
    meta: {},
  },
});

@Component({
  imports: [MediaDetailComponent],
  providers: [ImageSources, MediaUsageReader, UnusedLocator],
  template: `<of-media-detail
    [item]="item()"
    [unusedList]="unused()"
    [languages]="['en', 'de']"
    [canDelete]="canDelete()"
    [pageSize]="48"
    [revision]="revision()"
    [changeSetId]="changeSetId()"
    [changeSetTitle]="changeSetTitle()"
    (deleted)="deleted = deleted + 1"
  />`,
})
class Host {
  readonly item = signal(file());
  readonly unused = signal(false);
  readonly canDelete = signal(true);
  readonly revision = signal(0);
  readonly changeSetId = signal<string | null>(null);
  readonly changeSetTitle = signal<string | null>(null);
  deleted = 0;
}

const unusedPage = (ids: string[], lastPage = 1) => ({
  data: ids.map((id) => ({ ...file(), id })),
  meta: {
    page: { currentPage: 1, lastPage, perPage: 200, total: ids.length },
  },
  links: { self: '', first: '', last: '', prev: null, next: null },
});

const unusedRequest = (http: HttpTestingController) =>
  http.expectOne(
    (r) => r.url === '/api/assets' && r.params.get('filter[unused]') === 'true',
  );

const notUsed = { usedIn: [], usedInCount: 0, languages: [] };

const flush = () => new Promise((resolve) => setTimeout(resolve));

async function setup(change: (host: Host) => void = () => undefined) {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideZard(),
    ],
  });
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:local');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  const fixture = TestBed.createComponent(Host);
  change(fixture.componentInstance);
  const http = TestBed.inject(HttpTestingController);
  const stable = async () => {
    await flush();
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();
  };
  await stable();
  const el = fixture.nativeElement as HTMLElement;
  return { fixture, http, el, stable };
}

describe('the media detail', () => {
  it('shows the 1280 rendition, the facts, and the usage per language with alt text, Replace and another image', async () => {
    const { http, el, stable } = await setup();
    const preview = http.expectOne((r) => r.url === `/api/assets/${HASH}`);
    expect(preview.request.params.get('width')).toBe('1280');
    http
      .expectOne('/api/modules/en/pump')
      .flush(module('en', 'Pump', HASH, 'A pump'));
    http
      .expectOne('/api/modules/de/pump')
      .flush(module('de', 'Pumpe', OTHER, 'Eine Pumpe'));
    await stable();
    expect(el.textContent).toContain('PNG');
    expect(el.textContent).toContain('1,600 × 900 px');
    expect(el.querySelector('[data-slot="media-hash"]')?.textContent).toBe(
      HASH,
    );
    const links = [...el.querySelectorAll('a')];
    const link = links.find((a) => a.textContent?.trim() === 'Pump')!;
    expect(link.getAttribute('href')).toBe('/content/en/pump?block=img1');
    expect(el.textContent).toContain('“A pump”');
    const replace = el.querySelector('[data-slot="replace-link"]')!;
    expect(replace.textContent?.trim()).toBe('Replace in English');
    expect(replace.getAttribute('href')).toBe(
      '/content/en/pump?block=img1&replace=image',
    );
    const other = el.querySelector('[data-slot="other-link"]')!;
    expect(other.textContent?.trim()).toBe('Other image in German');
    expect(other.getAttribute('href')).toBe('/content/de/pump?block=img1');
    // A used file has no Delete, and says why.
    expect(
      el.querySelector('[data-slot="delete-reason"]')?.textContent,
    ).toContain('only possible when the file isn’t used');
  });

  it('offers Delete on an unused file, naming it, for a role that may delete', async () => {
    const { el, fixture } = await setup((host) => {
      host.unused.set(true);
      host.item.set(file({ usedIn: [], usedInCount: 0, languages: [] }));
    });
    expect(el.textContent).toContain('Nobody uses this file.');
    const del = [...el.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === `Delete ${HASH.slice(0, 12)}`,
    )!;
    del.click();
    expect(fixture.componentInstance.deleted).toBe(1);
  });

  it('has no Delete for a role whose scope is restricted', async () => {
    const { el } = await setup((host) => {
      host.unused.set(true);
      host.canDelete.set(false);
      host.item.set(file({ usedIn: [], usedInCount: 0, languages: [] }));
    });
    expect(
      [...el.querySelectorAll('button')].some((b) =>
        b.textContent?.includes('Delete'),
      ),
    ).toBe(false);
    expect(
      el.querySelector('[data-slot="delete-reason"]')?.textContent,
    ).toContain('editing rights over all content');
  });

  it('says, for a file no module here uses, that only what the reader sees counts, and links to it on the Unused list', async () => {
    const { el, http, stable } = await setup((host) =>
      host.item.set(file(notUsed)),
    );
    expect(el.textContent).toContain('No module uses it yet.');
    expect(
      el.querySelector('[data-slot="usage-scope"]')?.textContent,
    ).toContain('Only the modules you can read here count');
    // Checking: a placeholder, no sentence about deleting yet.
    expect(
      el.querySelector('[data-slot="unused-check"]')?.textContent,
    ).toContain('Checking the Unused list');
    expect(el.querySelector('[data-slot="delete-reason"]')).toBeNull();
    const req = unusedRequest(http);
    expect(req.request.params.get('page[number]')).toBe('1');
    expect(req.request.params.get('page[size]')).toBe('200');
    expect(req.request.params.has('filter[type]')).toBe(false);
    // 60th on the list: the second page of 48.
    const before = Array.from({ length: 59 }, (_, i) =>
      i.toString(16).padStart(64, '0'),
    );
    req.flush(unusedPage([...before, HASH]));
    await stable();
    const check = el.querySelector('[data-slot="unused-check"]')!;
    expect(check.textContent).toContain(
      'It is on the Unused list, where it can be deleted.',
    );
    const link = el.querySelector('[data-slot="unused-link"]')!;
    expect(link.textContent?.trim()).toBe('Show on the Unused list');
    expect(link.getAttribute('href')).toBe(
      `/?usage=unused&file=${HASH}&page=2`,
    );
  });

  it('names the manuals that have it as their cover image, reading no module, and offers no Delete (#394)', async () => {
    const { el, http } = await setup((host) =>
      host.item.set(
        file({
          ...notUsed,
          usedInManuals: [{ manualId: 'operating', title: 'Operating manual' }],
        }),
      ),
    );
    const manuals = el.querySelector('[data-slot="usage-manuals"]');
    expect(manuals?.textContent).toContain('Cover image of');
    const link = manuals?.querySelector('a');
    expect(link?.textContent?.trim()).toBe('Operating manual');
    expect(link?.getAttribute('href')).toBe('/manuals?manual=operating');
    expect(el.textContent).not.toContain('No module uses it yet.');
    expect(el.querySelector('[data-slot="unused-check"]')).toBeNull();
    http.expectNone((r) => r.url.includes('/modules/'));
  });

  it('keeps its answer while the list is read again', async () => {
    const { el, http, fixture, stable } = await setup((host) =>
      host.item.set(file(notUsed)),
    );
    unusedRequest(http).flush(unusedPage([HASH]));
    await stable();
    fixture.componentInstance.revision.set(1);
    await stable();
    const req = unusedRequest(http);
    // Checking again: the answer stays, no placeholder.
    expect(
      el.querySelector('[data-slot="unused-check"] z-skeleton'),
    ).toBeNull();
    expect(
      el.querySelector('[data-slot="unused-link"]')?.getAttribute('href'),
    ).toBe(`/?usage=unused&file=${HASH}`);
    req.flush(unusedPage([]));
    await stable();
    expect(el.querySelector('[data-slot="unused-link"]')).toBeNull();
  });

  it('says why a file without uses here is not on the Unused list', async () => {
    const { el, http, stable } = await setup((host) =>
      host.item.set(file(notUsed)),
    );
    unusedRequest(http).flush(unusedPage([OTHER]));
    await stable();
    expect(
      el.querySelector('[data-slot="unused-check"]')?.textContent,
    ).toContain(
      'It isn’t on the Unused list, so it can’t be deleted: it is still used elsewhere, or it was uploaded less than 24 hours ago.',
    );
    expect(el.querySelector('[data-slot="unused-link"]')).toBeNull();
  });

  it('names the own change set an upload went into, linking to its review page', async () => {
    const { el, http, stable } = await setup((host) => {
      host.item.set(file({ ...notUsed, uploaded: true }));
      host.changeSetId.set('cs-1');
      host.changeSetTitle.set('Pump update');
    });
    unusedRequest(http).flush(unusedPage([]));
    await stable();
    expect(
      el.querySelector('[data-slot="upload-hint"]')?.textContent?.trim(),
    ).toBe(
      'It isn’t on the Unused list, so it can’t be deleted: it was uploaded into the open revision Pump update, which counts as a use while that revision is open.',
    );
    const link = el.querySelector('[data-slot="upload-revision-link"]')!;
    expect(link.textContent?.trim()).toBe('Pump update');
    expect(link.getAttribute('href')).toBe('/review?cs=cs-1');
  });

  it('says “this revision” while the title isn’t known, and names it once it is', async () => {
    const { el, http, stable, fixture } = await setup((host) => {
      host.item.set(file({ ...notUsed, uploaded: true }));
      host.changeSetId.set('cs-1');
    });
    unusedRequest(http).flush(unusedPage([]));
    await stable();
    expect(
      el.querySelector('[data-slot="upload-hint"]')?.textContent?.trim(),
    ).toBe(
      'It isn’t on the Unused list, so it can’t be deleted: it was uploaded into this revision, which counts as a use while that revision is open.',
    );
    const link = el.querySelector('[data-slot="upload-revision-link"]')!;
    expect(link.textContent?.trim()).toBe('this revision');
    expect(link.getAttribute('href')).toBe('/review?cs=cs-1');

    fixture.componentInstance.changeSetTitle.set('Pump update');
    await stable();
    // The same paragraph and link, with the title in place: nothing is read again.
    expect(el.querySelector('[data-slot="upload-revision-link"]')).toBe(link);
    expect(link.textContent?.trim()).toBe('Pump update');
    expect(
      http.match((r) => r.params.get('filter[unused]') === 'true'),
    ).toHaveLength(0);
  });

  it('never names or links a change set that isn’t the reader’s own', async () => {
    // Not the reader's own change set: the list is read without it, so `uploaded` is false.
    const { el, http, stable } = await setup((host) => {
      host.item.set(file(notUsed));
      host.changeSetId.set(null);
      host.changeSetTitle.set(null);
    });
    unusedRequest(http).flush(unusedPage([]));
    await stable();
    expect(
      el.querySelector('[data-slot="unused-check"]')?.textContent,
    ).toContain('it is still used elsewhere');
    expect(el.querySelector('[data-slot="upload-hint"]')).toBeNull();
    expect(el.querySelector('a[href^="/review"]')).toBeNull();
  });

  it('names no change set for a file that wasn’t uploaded into the own one', async () => {
    const { el, http, stable } = await setup((host) => {
      host.item.set(file(notUsed));
      host.changeSetId.set('cs-1');
      host.changeSetTitle.set('Pump update');
    });
    unusedRequest(http).flush(unusedPage([]));
    await stable();
    expect(
      el.querySelector('[data-slot="unused-check"]')?.textContent,
    ).toContain('it is still used elsewhere');
    expect(el.querySelector('[data-slot="upload-hint"]')).toBeNull();
    expect(el.textContent).not.toContain('Pump update');
  });

  it('keeps the plain reason for an upload when no own change set is chosen', async () => {
    const { el, http, stable } = await setup((host) =>
      host.item.set(file({ ...notUsed, uploaded: true })),
    );
    unusedRequest(http).flush(unusedPage([]));
    await stable();
    expect(
      el.querySelector('[data-slot="unused-check"]')?.textContent,
    ).toContain('it is still used elsewhere');
    expect(el.querySelector('a[href^="/review"]')).toBeNull();
  });

  it('links to the Unused list’s first page when the check fails', async () => {
    const { el, http, stable } = await setup((host) =>
      host.item.set(file(notUsed)),
    );
    unusedRequest(http).flush(null, {
      status: 503,
      statusText: 'Service Unavailable',
    });
    await stable();
    expect(
      el.querySelector('[data-slot="unused-check"]')?.textContent,
    ).toContain('The Unused list shows whether it can be deleted.');
    // Its page is not known: the list's first page, without the file (it would close there).
    const link = el.querySelector('[data-slot="unused-link"]')!;
    expect(link.textContent?.trim()).toBe('Look for it on the Unused list');
    expect(link.getAttribute('href')).toBe('/?usage=unused');
  });

  it('says deleting needs unrestricted rights, for a role without them, on either list', async () => {
    const { el, http, fixture, stable } = await setup((host) => {
      host.canDelete.set(false);
      host.item.set(file(notUsed));
    });
    http.expectNone((r) => r.params.get('filter[unused]') === 'true');
    expect(el.querySelector('[data-slot="unused-check"]')).toBeNull();
    expect(
      el.querySelector('[data-slot="delete-reason"]')?.textContent,
    ).toContain('editing rights over all content');
    // A used file too: not the "only when used nowhere" sentence.
    fixture.componentInstance.item.set(file());
    await stable();
    expect(
      el.querySelector('[data-slot="delete-reason"]')?.textContent,
    ).toContain('editing rights over all content');
  });

  it('shows an attached file as its icon, name and size with Download', async () => {
    const { el } = await setup((host) =>
      host.item.set({
        ...file({ usedAs: ['attachment'] }),
        attributes: {
          ...file().attributes,
          fileName: 'datasheet.pdf',
          contentType: 'application/pdf',
          width: null,
          height: null,
        },
      }),
    );
    expect(el.querySelector('of-image-thumb')).toBeNull();
    expect(el.textContent).toContain('datasheet.pdf');
    expect(el.textContent).toContain('4.1 kB');
    expect(el.textContent).toContain('Download');
    expect(el.textContent).not.toContain('Replace in');
  });
});
