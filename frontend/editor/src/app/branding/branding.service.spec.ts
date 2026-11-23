import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { apiErrorInterceptor } from '../api/api-interceptors';
import { docsConfig } from '../../docs.config';
import { RESET, type BrandingResource } from './branding-model';
import { BRAND_STYLE_ID, BrandingService } from './branding.service';

const A = 'a'.repeat(64);

const brandingDoc = (
  over: Partial<BrandingResource['attributes']> = {},
  tokens: BrandingResource['meta']['tokens'] = null,
): { data: BrandingResource } => ({
  data: {
    type: 'Branding',
    id: 'branding',
    attributes: { ...RESET, updatedAt: null, ...over },
    meta: { tokens, contrast: [] },
  },
});

function setup() {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(withInterceptors([apiErrorInterceptor])),
      provideHttpClientTesting(),
    ],
  });
  return {
    service: TestBed.inject(BrandingService),
    http: TestBed.inject(HttpTestingController),
  };
}

const icons = () =>
  Array.from(document.head.querySelectorAll('link[data-of-brand]')).map((l) => [
    l.getAttribute('rel'),
    l.getAttribute('href'),
  ]);

describe('BrandingService', () => {
  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
    document.getElementById(BRAND_STYLE_ID)?.remove();
  });

  it('shows the defaults, with their icons, until the API answers', () => {
    const { service } = setup();
    TestBed.tick();
    expect(service.branding()).toBe(docsConfig.branding);
    expect(icons()).toContainEqual(['icon', 'assets/brand/favicon.svg']);
    expect(document.getElementById(BRAND_STYLE_ID)).toBeNull();
  });

  it('applies the API’s name, icons and colour tokens over the theme', async () => {
    const { service, http } = setup();
    const loading = service.load();
    http.expectOne('/api/branding').flush(
      brandingDoc(
        { productName: 'Example Docs', favicon: `sha256:${A}` },
        {
          light: { primary: '#1d4ed8' },
          dark: { primary: '#93b4ff' },
        },
      ),
    );
    await loading;
    TestBed.tick();
    expect(service.productName()).toBe('Example Docs');
    expect(icons()).toContainEqual(['icon', `/api/branding/images/${A}`]);
    expect(icons()).not.toContainEqual(['icon', 'assets/brand/favicon.svg']);
    const style = document.getElementById(BRAND_STYLE_ID);
    expect(style?.textContent).toContain('--primary: #1d4ed8;');
    expect(style?.textContent).toContain('.dark { --primary: #93b4ff; }');

    service.show(brandingDoc().data);
    TestBed.tick();
    expect(document.getElementById(BRAND_STYLE_ID)).toBeNull();
    expect(service.productName()).toBe(docsConfig.branding.productName);
  });

  it('keeps the defaults when the API cannot be read', async () => {
    const { service, http } = setup();
    const loading = service.load();
    http
      .expectOne('/api/branding')
      .flush(null, { status: 503, statusText: 'Unavailable' });
    await loading;
    expect(service.resource()).toBeNull();
    expect(service.branding()).toBe(docsConfig.branding);
  });
});
