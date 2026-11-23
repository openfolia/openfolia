import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { provideZard } from '@openfolia/ui/core';
import { ToastService } from '@openfolia/ui/toast';

import { apiErrorInterceptor } from '../../api/api-interceptors';
import { type BrandingResource, RESET } from '../../branding/branding-model';
import { BrandingService } from '../../branding/branding.service';
import { MeService } from '../../permissions/me';
import { fieldErrors } from './branding-errors';
import { BrandingPage } from './branding.page';

const A = 'a'.repeat(64);

const doc = (
  over: Partial<BrandingResource['attributes']> = {},
  meta: Partial<BrandingResource['meta']> = {},
): { data: BrandingResource } => ({
  data: {
    type: 'Branding',
    id: 'branding',
    attributes: { ...RESET, updatedAt: null, ...over },
    meta: { tokens: null, contrast: [], ...meta },
  },
});

async function render(initial = doc()) {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: 'branding', component: BrandingPage }]),
      provideHttpClient(withInterceptors([apiErrorInterceptor])),
      provideHttpClientTesting(),
      provideZard(),
    ],
  });
  TestBed.inject(MeService).set({
    id: 'jane',
    kind: 'user',
    name: 'Jane Doe',
    role: '',
    permissions: new Set(['admin.branding']),
  });
  const { RouterTestingHarness } = await import('@angular/router/testing');
  const harness = await RouterTestingHarness.create();
  const http = TestBed.inject(HttpTestingController);
  void harness.navigateByUrl('/branding');
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 0));
      await harness.fixture.whenStable();
    }
  };
  await settle();
  http.expectOne('/api/branding').flush(initial);
  await settle();
  return {
    http,
    settle,
    root: harness.routeNativeElement as HTMLElement,
    service: TestBed.inject(BrandingService),
    toasts: TestBed.inject(ToastService),
  };
}

function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('change'));
}

describe('BrandingPage', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('shows the defaults, the image slots and the preview in light and dark', async () => {
    const { root } = await render();
    const name = root.querySelector<HTMLInputElement>('#branding-product-name');
    expect(name?.value).toBe('');
    expect(name?.placeholder).toBe('OpenFolia');
    expect(
      [...root.querySelectorAll('li[data-field]')].map((li) =>
        li.getAttribute('data-field'),
      ),
    ).toEqual(['logoLight', 'logoDark', 'mark', 'favicon', 'appIcon']);
    expect(root.textContent).toContain('Default');
    const panes = root.querySelectorAll(
      '[data-slot="branding-preview"] [data-theme]',
    );
    expect(
      [...panes].map((p) => [
        p.classList.contains('light'),
        p.classList.contains('dark'),
      ]),
    ).toEqual([
      [true, false],
      [false, true],
    ]);
    // Nothing to reset.
    const reset = [...root.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Reset to default'),
    );
    expect(reset?.disabled).toBe(true);
  });

  it('sends a new name at once, shows it everywhere, and keeps it once saved', async () => {
    const { root, http, settle, service } = await render();
    type(
      root.querySelector('#branding-product-name') as HTMLInputElement,
      '  Example Docs ',
    );
    await settle();
    // Shown before the API answers.
    expect(service.productName()).toBe('Example Docs');
    const req = http.expectOne('/api/branding');
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({
      data: {
        type: 'Branding',
        id: 'branding',
        attributes: { productName: 'Example Docs' },
      },
    });
    req.flush(
      doc({
        productName: 'Example Docs',
        updatedAt: '2026-11-20T08:00:00.000Z',
      }),
    );
    await settle();
    expect(service.productName()).toBe('Example Docs');
  });

  it('puts the saved colour back when the API refuses it, saying why under the field', async () => {
    const { root, http, settle, service, toasts } = await render(
      doc(
        { primary: '#1d4ed8' },
        {
          tokens: {
            light: { primary: '#1d4ed8' },
            dark: { primary: '#93b4ff' },
          },
          contrast: [
            {
              theme: 'light',
              pair: 'primary/background',
              colour: 'primary',
              ratio: 6.7,
              required: 4.5,
            },
          ],
        },
      ),
    );
    expect(root.querySelector('[data-field="primary"]')?.textContent).toContain(
      '6.7:1 (needs 4.5:1)',
    );
    const hex = root.querySelector('#branding-primary') as HTMLInputElement;
    type(hex, '#8FC07F');
    await settle();
    const req = http.expectOne('/api/branding');
    expect(req.request.body.data.attributes).toEqual({ primary: '#8fc07f' });
    req.flush(
      {
        errors: [
          {
            status: '422',
            title: 'Unprocessable Entity',
            code: 'insufficient-contrast',
            detail:
              'In light mode, primary/background has a contrast of 2.1:1.',
            source: { pointer: '/data/attributes/primary' },
            meta: {
              theme: 'light',
              pair: 'primary/background',
              ratio: 2.1,
              required: 4.5,
            },
          },
        ],
      },
      { status: 422, statusText: 'Unprocessable Entity' },
    );
    await settle();
    expect(hex.value).toBe('#1d4ed8');
    expect(service.resource()?.attributes.primary).toBe('#1d4ed8');
    const alert = root.querySelector('[data-field="primary"] [role="alert"]');
    expect(alert?.textContent).toContain(
      'Too little contrast on light pages: Primary colour on the page is 2.1:1, it needs 4.5:1.',
    );
    expect(toasts.toasts().at(-1)?.kind).toBe('error');
  });

  it('refuses something that is no colour without asking the API', async () => {
    const { root, settle } = await render();
    type(root.querySelector('#branding-primary') as HTMLInputElement, 'blue');
    await settle();
    expect(
      root.querySelector('[data-field="primary"] [role="alert"]')?.textContent,
    ).toContain('Enter a colour as # and six hex digits.');
  });

  it('uploads a chosen image, then names it, and refuses an SVG at once', async () => {
    const { root, http, settle } = await render();
    const input = root.querySelector(
      'input[data-upload="logoLight"]',
    ) as HTMLInputElement;
    const png = new File(
      [new Uint8Array([0x89, 0x50, 0x4e, 0x47])],
      'logo.png',
      {
        type: 'image/png',
      },
    );
    Object.defineProperty(input, 'files', { value: [png], configurable: true });
    input.dispatchEvent(new Event('change'));
    await settle();
    const upload = http.expectOne('/api/branding/images');
    expect(upload.request.method).toBe('POST');
    expect(upload.request.body instanceof FormData).toBe(true);
    upload.flush({
      data: {
        type: 'BrandingImage',
        id: A,
        attributes: {
          reference: `sha256:${A}`,
          contentType: 'image/png',
          size: 4,
          width: 240,
          height: 48,
          uploadedAt: '2026-11-20T08:00:00.000Z',
        },
      },
    });
    await settle();
    const named = http.expectOne('/api/branding');
    expect(named.request.body.data.attributes).toEqual({
      logoLight: `sha256:${A}`,
    });
    named.flush(doc({ logoLight: `sha256:${A}` }));
    await settle();
    expect(
      root.querySelector('[data-field="logoLight"] img')?.getAttribute('src'),
    ).toBe(`/api/branding/images/${A}`);

    const svg = new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' });
    const mark = root.querySelector(
      'input[data-upload="mark"]',
    ) as HTMLInputElement;
    Object.defineProperty(mark, 'files', { value: [svg], configurable: true });
    mark.dispatchEvent(new Event('change'));
    await settle();
    expect(
      root.querySelector('[data-field="mark"] [role="alert"]')?.textContent,
    ).toContain('Upload a PNG or WebP image');
  });

  it('says an upload the API refuses under the image it was for', async () => {
    const { root, http, settle } = await render();
    const input = root.querySelector(
      'input[data-upload="appIcon"]',
    ) as HTMLInputElement;
    const png = new File([new Uint8Array([0x89, 0x50])], 'icon.png', {
      type: 'image/png',
    });
    Object.defineProperty(input, 'files', { value: [png], configurable: true });
    input.dispatchEvent(new Event('change'));
    await settle();
    http.expectOne('/api/branding/images').flush(
      {
        errors: [
          {
            status: '422',
            title: 'Unprocessable Entity',
            code: 'image-too-large',
            detail: 'Larger than 4096 pixels on a side.',
            meta: { maxSide: 4096 },
          },
        ],
      },
      { status: 422, statusText: 'Unprocessable Entity' },
    );
    await settle();
    expect(
      root.querySelector('[data-field="appIcon"] [role="alert"]')?.textContent,
    ).toContain('larger than 4096 pixels on a side');
  });
});

describe('fieldErrors', () => {
  it('reads the refusals by field', () => {
    expect(
      fieldErrors({
        errors: [
          {
            code: 'unknown-image',
            detail: '',
            source: { pointer: '/data/attributes/mark' },
          },
          {
            code: 'image-not-square',
            detail: '',
            source: { pointer: '/data/attributes/favicon' },
            meta: { width: 64, height: 32 },
          },
        ],
      } as never),
    ).toEqual({
      mark: { key: 'editor.admin.branding.errors.unknownImage', params: {} },
      favicon: {
        key: 'editor.admin.branding.errors.notSquare',
        params: { width: 64, height: 32 },
      },
    });
  });
});
