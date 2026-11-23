import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { provideZard } from '@openfolia/ui/core';
import { ToastService } from '@openfolia/ui/toast';

import { apiErrorInterceptor } from '../api/api-interceptors';
import { StableAddressDialogComponent } from './stable-address-dialog.component';
import { StableAddressesCardComponent } from './stable-addresses-card.component';
import {
  qrFileName,
  StableAddresses,
  type ShownAddress,
  type StableAddressItem,
} from './stable-addresses';

const RELEASE_ID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const URL_BASE = 'https://docs.example.com/';

const item = (
  over: Partial<StableAddressItem['attributes']> = {},
): StableAddressItem => {
  const a = {
    product: 'north',
    manual: 'operating',
    slug: 'operating',
    variant: 'model=large',
    lang: 'en',
    revision: '2.0',
    ...over,
  };
  const path = `/d/${a.product}/${a.slug}/${a.variant}/${a.lang}`;
  const link = (p: string, url: string | null) => ({
    path: p,
    url: url === null ? null : `${url}${p.slice(1)}`,
  });
  return {
    type: 'StableAddress',
    id: `${RELEASE_ID}/${a.manual}/${a.variant}/${a.lang}`,
    attributes: {
      ...a,
      latest: {
        html: link(path, URL_BASE),
        pdf: link(`${path}/pdf`, URL_BASE),
      },
      pinned: {
        html: link(`${path}@${a.revision}`, URL_BASE),
        pdf: link(`${path}@${a.revision}/pdf`, URL_BASE),
      },
    },
    relationships: { release: { data: { type: 'Release', id: RELEASE_ID } } },
    meta: { latestRelease: true, withdrawn: false, pdfReady: true },
  };
};

const doc = (
  items: StableAddressItem[],
  meta: { access?: string; publicUrl?: string | null } = {},
) => ({
  data: items,
  meta: {
    page: {
      currentPage: 1,
      lastPage: 1,
      perPage: 5,
      total: items.length,
    },
    access: meta.access ?? 'public',
    publicUrl: meta.publicUrl === undefined ? URL_BASE : meta.publicUrl,
  },
  links: {
    self: '/stable-addresses',
    first: '/stable-addresses',
    last: '/stable-addresses',
  },
});

@Component({
  imports: [StableAddressDialogComponent],
  template: `<of-stable-address-dialog
    [(open)]="open"
    name="Operating, Large · English"
    [address]="address()"
  />`,
})
class DialogHost {
  readonly open = signal(true);
  readonly address = signal<ShownAddress | null>(null);
}

@Component({
  imports: [StableAddressesCardComponent],
  template: `<of-stable-addresses-card
    manualId="operating"
    [lang]="lang()"
    title="Operating"
    [productLabel]="product"
  />`,
})
class CardHost {
  readonly lang = signal('en');
  readonly product = (id: string) => (id === 'north' ? 'North' : id);
}

function setup() {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(withInterceptors([apiErrorInterceptor])),
      provideHttpClientTesting(),
      provideZard(),
    ],
  });
  const http = TestBed.inject(HttpTestingController);
  const settle = async (fixture: { whenStable(): Promise<unknown> }) => {
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 0));
      await fixture.whenStable();
    }
  };
  return { http, settle };
}

const body = () => document.body;

beforeAll(() => {
  // The QR preview's object URL; jsdom has none.
  URL.createObjectURL ??= () => 'blob:qr';
  URL.revokeObjectURL ??= () => undefined;
});

afterEach(() => {
  TestBed.inject(HttpTestingController).verify();
  vi.restoreAllMocks();
});

describe('StableAddressDialogComponent', () => {
  it('shows the latest and the pinned address, copies one, and offers the QR code as SVG and PNG', async () => {
    const t = setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    const fixture = TestBed.createComponent(DialogHost);
    fixture.componentInstance.address.set({
      item: item(),
      settings: { access: 'public', publicUrl: URL_BASE },
    });
    await t.settle(fixture);
    t.http
      .expectOne('/api/d/north/operating/model=large/en/qr.svg')
      .flush(new Blob(['<svg/>'], { type: 'image/svg+xml' }));
    await t.settle(fixture);
    const latest = body().querySelector<HTMLInputElement>(
      '[data-address=latest]',
    );
    const pinned = body().querySelector<HTMLInputElement>(
      '[data-address=pinned]',
    );
    expect(latest?.value).toBe(`${URL_BASE}d/north/operating/model=large/en`);
    expect(pinned?.value).toBe(
      `${URL_BASE}d/north/operating/model=large/en@2.0`,
    );
    expect(
      body().querySelector('[data-slot=address-access]')?.textContent,
    ).toContain('without signing in');
    expect(body().querySelector('[data-slot=address-qr]')).not.toBeNull();

    const copy = [...body().querySelectorAll('button')].find(
      (b) =>
        b.getAttribute('aria-label') === 'Copy the address: Latest release',
    );
    const success = vi.spyOn(TestBed.inject(ToastService), 'success');
    copy?.click();
    await t.settle(fixture);
    expect(writeText).toHaveBeenCalledWith(latest?.value);
    expect(success).toHaveBeenCalled();

    body().querySelector<HTMLButtonElement>('[data-download=png]')?.click();
    await t.settle(fixture);
    t.http
      .expectOne('/api/d/north/operating/model=large/en/qr.png')
      .flush(new Blob(['png'], { type: 'image/png' }));
    await t.settle(fixture);
  });

  it('says so when the QR code cannot be made, instead of waiting for it', async () => {
    const t = setup();
    const fixture = TestBed.createComponent(DialogHost);
    fixture.componentInstance.address.set({
      item: item(),
      settings: { access: 'off', publicUrl: URL_BASE },
    });
    await t.settle(fixture);
    t.http
      .expectOne('/api/d/north/operating/model=large/en/qr.svg')
      .flush(null, { status: 404, statusText: 'Not Found' });
    await t.settle(fixture);
    expect(
      body().querySelector('[data-slot=address-qr-failed]'),
    ).not.toBeNull();
    expect(body().querySelector('[data-slot=address-qr]')).toBeNull();
  });

  it('says why there is no QR code without a public address, and shows paths', async () => {
    const t = setup();
    const fixture = TestBed.createComponent(DialogHost);
    const listed = item();
    fixture.componentInstance.address.set({
      item: {
        ...listed,
        attributes: {
          ...listed.attributes,
          latest: {
            html: { path: listed.attributes.latest.html.path, url: null },
            pdf: { path: listed.attributes.latest.pdf.path, url: null },
          },
        },
      },
      settings: { access: 'signed-in', publicUrl: null },
    });
    await t.settle(fixture);
    expect(
      body().querySelector<HTMLInputElement>('[data-address=latest]')?.value,
    ).toBe('/d/north/operating/model=large/en');
    expect(body().querySelector('[data-slot=address-no-url]')).not.toBeNull();
    expect(body().querySelector('[data-slot=address-qr]')).toBeNull();
    expect(
      body().querySelector('[data-slot=address-access]')?.textContent,
    ).toContain('Only clients that send an API token');
  });
});

describe('StableAddressesCardComponent', () => {
  it('lists the manual’s addresses in the chosen language, paged, and opens one', async () => {
    const t = setup();
    const fixture = TestBed.createComponent(CardHost);
    await t.settle(fixture);
    const first = t.http.expectOne((r) => r.url === '/api/stable-addresses');
    expect(first.request.params.get('filter[manual]')).toBe('operating');
    expect(first.request.params.get('filter[lang]')).toBe('en');
    expect(first.request.params.get('page[size]')).toBe('5');
    first.flush(doc([item(), item({ variant: 'model=small' })]));
    await t.settle(fixture);
    const rows = fixture.nativeElement.querySelectorAll('[data-address-row]');
    expect(rows.length).toBe(2);
    expect(rows[0]?.textContent).toContain('North · model=large · English');

    rows[0]?.querySelector('button')?.click();
    await t.settle(fixture);
    t.http
      .expectOne('/api/d/north/operating/model=large/en/qr.svg')
      .flush(new Blob(['<svg/>']));
    await t.settle(fixture);
    expect(body().querySelector('[data-address=latest]')).not.toBeNull();

    // Another language: read again.
    fixture.componentInstance.lang.set('de');
    await t.settle(fixture);
    t.http
      .expectOne(
        (r) =>
          r.url === '/api/stable-addresses' &&
          r.params.get('filter[lang]') === 'de',
      )
      .flush(doc([]));
    await t.settle(fixture);
    expect(fixture.nativeElement.textContent).toContain('No addresses yet');
  });
});

describe('StableAddresses', () => {
  it('finds a release file’s address by its variant, and names its QR code', async () => {
    const t = setup();
    const addresses = TestBed.inject(StableAddresses);
    const found = addresses.find({
      releaseId: RELEASE_ID,
      manual: 'operating',
      variant: 'model=small',
      lang: 'en',
    });
    const req = t.http.expectOne((r) => r.url === '/api/stable-addresses');
    expect(req.request.params.get('filter[release]')).toBe(RELEASE_ID);
    req.flush(doc([item(), item({ variant: 'model=small' })]));
    expect((await found)?.item.attributes.variant).toBe('model=small');
    expect(qrFileName(item(), true)).toBe(
      'qr_north_operating_model-large_en_2.0',
    );
  });
});
