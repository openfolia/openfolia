import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import type { Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { provideZard } from '@openfolia/ui/core';

import { provideApi } from '../api';
import { AboutLinksComponent } from './about-links.component';
import { AboutMenuItemsComponent } from './about-menu-items.component';
import { AboutService } from './about.service';

const LICENSE_URL = 'https://www.gnu.org/licenses/agpl-3.0.html';
const SOURCE_URL = 'https://code.example.org/docs-platform';

/** Lets the service's promise chain finish. */
const settled = () => new Promise((resolve) => setTimeout(resolve));

const about = (sourceUrl: string | null) => ({
  data: {
    type: 'About',
    id: 'about',
    attributes: {
      license: 'AGPL-3.0-only',
      licenseUrl: LICENSE_URL,
      sourceUrl,
    },
  },
});

describe('the source code and licence links', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideZard(), provideApi(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    vi.restoreAllMocks();
  });

  const render = <T>(component: Type<T>) => {
    const fixture = TestBed.createComponent(component);
    fixture.detectChanges();
    return fixture;
  };
  const answer = async (
    fixture: { detectChanges(): void; whenStable(): Promise<unknown> },
    body: object,
  ) => {
    http.expectOne('/api/about').flush(body);
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const el = (fixture: { nativeElement: HTMLElement }, id: string) =>
    fixture.nativeElement.querySelector<HTMLElement>(`[data-testid="${id}"]`);

  it('opens the source and the licence from the account menu, in a new tab', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const fixture = render(AboutMenuItemsComponent);
    expect(el(fixture, 'about-licence')).toBeNull();

    await answer(fixture, about(SOURCE_URL));
    expect(el(fixture, 'about-source')?.textContent?.trim()).toBe(
      'Source code',
    );
    expect(el(fixture, 'about-licence')?.textContent?.trim()).toBe(
      'Licence: AGPL-3.0-only',
    );

    el(fixture, 'about-source')?.click();
    expect(open).toHaveBeenCalledWith(
      SOURCE_URL,
      '_blank',
      'noopener,noreferrer',
    );
    el(fixture, 'about-licence')?.click();
    expect(open).toHaveBeenLastCalledWith(
      LICENSE_URL,
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('opens nothing but an http(s) address', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const fixture = render(AboutMenuItemsComponent);
    await answer(fixture, about('javascript:alert(1)'));
    el(fixture, 'about-source')?.click();
    expect(open).not.toHaveBeenCalled();
  });

  it('shows only the licence in the account menu without a source address', async () => {
    const fixture = render(AboutMenuItemsComponent);
    await answer(fixture, about(null));
    expect(el(fixture, 'about-source')).toBeNull();
    expect(el(fixture, 'about-licence')).not.toBeNull();
    expect(fixture.nativeElement.textContent).not.toContain('Source');
  });

  it('links to both from pages outside the shell', async () => {
    const fixture = render(AboutLinksComponent);
    await answer(fixture, about(SOURCE_URL));
    const source = el(fixture, 'about-source') as HTMLAnchorElement;
    const licence = el(fixture, 'about-licence') as HTMLAnchorElement;
    expect(source.href).toBe(SOURCE_URL);
    expect(licence.href).toBe(LICENSE_URL);
    for (const link of [source, licence]) {
      expect(link.target).toBe('_blank');
      expect(link.rel).toBe('noopener noreferrer');
    }
  });

  it('shows only the licence outside the shell without a source address', async () => {
    const fixture = render(AboutLinksComponent);
    await answer(fixture, about(null));
    expect(el(fixture, 'about-source')).toBeNull();
    expect(fixture.nativeElement.textContent.trim()).toBe(
      'Licence: AGPL-3.0-only',
    );
  });

  it('reads GET /about once, and again after a failure', async () => {
    const service = TestBed.inject(AboutService);
    service.load();
    service.load();
    http
      .expectOne('/api/about')
      .error(new ProgressEvent('error'), { status: 0 });
    await settled();
    expect(service.about()).toBeNull();

    service.load();
    http.expectOne('/api/about').flush(about(SOURCE_URL));
    await settled();
    expect(service.about()?.sourceUrl).toBe(SOURCE_URL);
    service.load();
    http.expectNone('/api/about');
  });
});
