import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';

import { provideZard } from '@openfolia/ui/core';

import { routes } from '../app.routes';
import { ALL_PERMISSIONS, MeService } from '../permissions/me';
import { DemoSession } from '../session/demo-session';

const tick = () => new Promise((resolve) => setTimeout(resolve));

function person(permissions: readonly string[]) {
  return {
    id: 'a',
    kind: 'user' as const,
    name: 'A',
    role: 'Author',
    permissions: new Set(permissions),
  };
}

async function open(url: string, permissions: readonly string[]) {
  TestBed.configureTestingModule({
    providers: [
      provideRouter(routes),
      provideZard(),
      provideHttpClient(),
      provideHttpClientTesting(),
    ],
  });
  TestBed.inject(MeService).set(person(permissions));
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(url);
  await harness.fixture.whenStable();
  const main = () =>
    (harness.fixture.nativeElement as HTMLElement).querySelector(
      'main',
    ) as HTMLElement;
  return { harness, main };
}

const AUTHOR = ['content.read', 'content.read.draft', 'content.edit'];
/** A role that opens no admin tab (reading drafts opens Page design, #392). */
const EDITOR_ONLY = ['content.read', 'content.edit'];

describe('the no-access page', () => {
  it('shows on a deep link into an admin tab, keeping the address and naming the permission', async () => {
    const { main } = await open('/admin/settings', EDITOR_ONLY);
    expect(TestBed.inject(Router).url).toBe('/admin/settings');
    const page = main().querySelector('[data-testid="no-access-page"]');
    expect(page).toBeTruthy();
    expect(page?.querySelector('h1')?.textContent?.trim()).toBe('Admin');
    const state = page?.querySelector('[role="alert"]');
    expect(state?.querySelector('h3')?.textContent?.trim()).toBe('No access');
    expect(state?.textContent).toContain(
      'The section “Admin” needs the permission “Create roles, assign people”.',
    );
    // Nothing of the section itself: no rail, no settings form.
    expect(main().querySelector('nav[data-slot="admin-rail"]')).toBeNull();
    expect(main().textContent).not.toContain('Project settings');
    const home = page?.querySelector('a[z-button]');
    expect(home?.getAttribute('href')).toBe('/');
  });

  it('shows for every guarded section, the sidebar still hiding them', async () => {
    const { harness, main } = await open('/review', ['content.read']);
    expect(main().textContent).toContain(
      'The section “Review” needs the permission “See drafts and review state”.',
    );
    for (const [url, text] of [
      ['/admin', '“Admin” needs'],
      ['/media', '“Media” needs'],
    ] as const) {
      await harness.navigateByUrl(url);
      await harness.fixture.whenStable();
      expect(TestBed.inject(Router).url).toBe(url);
      expect(main().textContent).toContain(text);
    }
    const nav = (harness.fixture.nativeElement as HTMLElement).querySelectorAll(
      'a[z-sidebar-menu-button]',
    );
    expect([...nav].map((a) => a.textContent?.trim())).toEqual([
      'Content',
      'Manuals',
      'Releases',
      'Terminology',
    ]);
  });

  it('shows for content, its module editor and the checks without content.read', async () => {
    const { harness, main } = await open('/content/en/some-module', []);
    expect(main().textContent).toContain('“Content” needs the permission');
    // The start page is Content itself: no link that leads back here.
    expect(main().querySelector('a[z-button]')).toBeNull();
    await harness.navigateByUrl('/checks?manual=m');
    await harness.fixture.whenStable();
    expect(main().textContent).toContain('“Checks” needs the permission');
    // Releases are released content: reading them needs `content.read` too.
    await harness.navigateByUrl('/releases');
    await harness.fixture.whenStable();
    expect(main().textContent).toContain('“Releases” needs the permission');
  });

  it('is not "Page not found": an unknown address under a section the role may use is', async () => {
    const { main } = await open('/admin/nothing-here', ALL_PERMISSIONS);
    expect(TestBed.inject(Router).url).toBe('/admin/nothing-here');
    expect(main().querySelector('[data-testid="not-found-page"]')).toBeTruthy();
    expect(main().querySelector('[data-testid="no-access-page"]')).toBeNull();
  });

  it('opens the section once the person holds the permission (another demo user)', async () => {
    const { harness, main } = await open('/admin/settings', AUTHOR);
    TestBed.inject(MeService).set(person(ALL_PERMISSIONS));
    await tick();
    await harness.fixture.whenStable();
    // Project settings opens its first topic (#318).
    expect(TestBed.inject(Router).url).toBe('/admin/settings/languages');
    expect(main().querySelector('[data-testid="no-access-page"]')).toBeNull();
    expect(main().querySelector('nav[data-slot="admin-rail"]')).toBeTruthy();
  });

  it('hints at the user switch only in demo mode', async () => {
    const { harness, main } = await open('/admin', EDITOR_ONLY);
    const hint = () =>
      main().querySelector('[data-testid="no-access-demo-hint"]');
    expect(hint()).toBeNull();
    const probed = TestBed.inject(DemoSession).probe();
    TestBed.inject(HttpTestingController)
      .expectOne('/api/demo/users?page%5Bnumber%5D=1&page%5Bsize%5D=200')
      .flush({
        data: [],
        meta: {
          page: { currentPage: 1, lastPage: 1, perPage: 200, total: 0 },
        },
        links: {},
      });
    await probed;
    await harness.fixture.whenStable();
    expect(hint()?.textContent).toContain('switch to a user');
  });
});
