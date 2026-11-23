import { ScrollDispatcher } from '@angular/cdk/scrolling';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';

import { provideZard } from '@openfolia/ui/core';

import { routes } from '../app.routes';
import { ALL_PERMISSIONS, MeService } from '../permissions/me';
import { ReadRef } from '../api';
import { loadLazyRoutes } from '../testing/lazy-routes';
import { ShellState } from './shell-state';

async function open(url: string, permissions?: string[]) {
  TestBed.configureTestingModule({
    providers: [
      provideRouter(routes),
      provideZard(),
      provideHttpClient(),
      provideHttpClientTesting(),
    ],
  });
  TestBed.inject(MeService).set({
    id: 'a',
    kind: 'user',
    name: 'A',
    role: 'Viewer',
    permissions: new Set(permissions ?? ALL_PERMISSIONS),
  });
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(url);
  await harness.fixture.whenStable();
  return harness;
}

function items(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('a[z-sidebar-menu-button]')];
}

// Every test here navigates the app's routes, whose screens are lazy chunks. Imported once up
// front, with a timeout of its own, instead of by the first test that opens each: that cold start
// ran the first test past its 5 s timeout on a loaded machine (#499).
beforeAll(() => loadLazyRoutes(routes), 60_000);

describe('ShellLayout', () => {
  it('lists the sections in order, with a landmark and the current page marked', async () => {
    const harness = await open('/manuals');
    const root = harness.fixture.nativeElement as HTMLElement;
    expect(items(root).map((a) => a.textContent?.trim())).toEqual([
      'Content',
      'Manuals',
      'Review',
      'Translations',
      'Releases',
      'Reports',
      'Media',
      'Terminology',
      'Admin',
    ]);
    expect(root.querySelector('nav[aria-label="Main"]')).toBeTruthy();
    expect(
      root
        .querySelector('a[aria-current="page"][z-sidebar-menu-button]')
        ?.textContent?.trim(),
    ).toBe('Manuals');
  });

  it('starts expanded on the content browser and collapsed on a work screen', async () => {
    const harness = await open('/content');
    const state = TestBed.inject(ShellState);
    expect(state.collapsed()).toBe(false);
    await harness.navigateByUrl('/review');
    expect(state.collapsed()).toBe(true);
    state.toggle();
    expect(state.collapsed()).toBe(false);
  });

  it('keeps icon-only items named for screen readers when collapsed', async () => {
    const harness = await open('/review');
    const root = harness.fixture.nativeElement as HTMLElement;
    expect(
      root.querySelector('z-sidebar')?.getAttribute('data-collapsible'),
    ).toBe('icon');
    const first = items(root)[0] as HTMLElement;
    expect(first.querySelector('span')?.textContent).toBe('Content');
    expect(
      root.querySelector('button[aria-label="Expand sidebar"]'),
    ).toBeTruthy();
  });

  it('names the way back with a Zard tooltip and the shortcut, and leaves no native title', async () => {
    const harness = await open('/review');
    const root = harness.fixture.nativeElement as HTMLElement;
    expect(root.querySelector('z-sidebar [title]')).toBeNull();
    const mark = root.querySelector(
      'button[aria-label="Expand sidebar"]',
    ) as HTMLElement;
    // The tooltip shows on a timer and renders on the change detection that starts: on fake
    // time they run in order, however late a loaded machine runs real ones (#355).
    vi.useFakeTimers();
    mark.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(250);
    const tip = document.querySelector('[role="tooltip"]');
    expect(tip?.textContent).toContain('Expand sidebar');
    expect(tip?.querySelector('kbd')?.textContent).toMatch(
      /^(\u2318B|Ctrl\+B)$/,
    );
  });

  it('names the collapse control with the shortcut too', async () => {
    const harness = await open('/content');
    const root = harness.fixture.nativeElement as HTMLElement;
    const trigger = root.querySelector(
      'button[z-sidebar-trigger]',
    ) as HTMLElement;
    // The tooltip shows on a timer and renders on the change detection that starts: on fake
    // time they run in order, however late a loaded machine runs real ones (#355).
    vi.useFakeTimers();
    trigger.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(250);
    const tip = document.querySelector('[role="tooltip"]');
    expect(tip?.textContent).toContain('Collapse sidebar');
    expect(tip?.querySelector('kbd')).toBeTruthy();
  });

  it('keeps both header states rendered, the hidden one inert, so they crossfade (#484)', async () => {
    const harness = await open('/review');
    const root = harness.fixture.nativeElement as HTMLElement;
    const full = root.querySelector('[data-header="full"]') as HTMLElement;
    const mark = root.querySelector('[data-header="mark"]') as HTMLElement;
    expect(full.hasAttribute('inert')).toBe(true);
    expect(full.classList).toContain('opacity-0');
    expect(mark.hasAttribute('inert')).toBe(false);
    // The logo and the expand icon share the mark's one cell; neither is ever display: none.
    const layers = [...mark.querySelectorAll<HTMLElement>('[data-mark]')];
    expect(layers.map((l) => l.dataset['mark'])).toEqual(['logo', 'icon']);
    for (const el of [full, mark, ...layers]) {
      expect(el.className).not.toMatch(/(^|\s|:)hidden\b/);
      expect(el.classList).toContain('motion-reduce:transition-none');
    }

    TestBed.inject(ShellState).toggle();
    await harness.fixture.whenStable();
    expect(full.hasAttribute('inert')).toBe(false);
    expect(mark.hasAttribute('inert')).toBe(true);
    expect(mark.classList).toContain('opacity-0');
  });

  it('hides a section the role can never open', async () => {
    const harness = await open('/content', ['content.read']);
    expect(
      items(harness.fixture.nativeElement).map((a) => a.textContent?.trim()),
    ).toEqual(['Content', 'Manuals', 'Releases', 'Terminology']);
  });

  it('shows the way to a section from home, the section as the current page', async () => {
    const harness = await open('/content');
    const crumbs = (harness.fixture.nativeElement as HTMLElement).querySelector(
      'z-breadcrumb',
    ) as HTMLElement;
    expect(
      [...crumbs.querySelectorAll('z-breadcrumb-item')].map((li) =>
        li.textContent?.replace('/', '').trim(),
      ),
    ).toEqual(['OpenFolia', 'Content']);
    expect(
      crumbs.querySelector('[aria-current="page"]')?.textContent,
    ).toContain('Content');
  });

  it('heads an admin page with its title, under the Admin breadcrumb, with its action', async () => {
    const harness = await open('/admin/webhooks');
    const root = harness.fixture.nativeElement as HTMLElement;
    const crumbs = root.querySelector('z-breadcrumb') as HTMLElement;
    expect(
      [...crumbs.querySelectorAll('z-breadcrumb-item')].map((li) =>
        li.textContent?.trim(),
      ),
    ).toEqual(['Admin']);
    expect(crumbs.querySelector('a')?.getAttribute('href')).toBe('/admin');
    expect(root.querySelector('h1')?.textContent?.trim()).toBe(
      'Webhooks and API access',
    );
    const current = root.querySelector(
      'nav[data-slot="admin-rail"] a[aria-current="page"]',
    );
    expect(current?.textContent?.trim()).toBe('Webhooks');
    const action = root.querySelector('of-page-header button') as HTMLElement;
    expect(action.textContent?.trim()).toBe('Add subscriber');
    // Built now (#254): the action opens the form.
    expect(action.getAttribute('aria-disabled')).toBeNull();
  });

  it('opens Admin to webhook managers on the Webhooks page alone (#254)', async () => {
    const harness = await open('/admin', ['content.read', 'webhook.manage']);
    const root = harness.fixture.nativeElement as HTMLElement;
    expect(items(root).map((a) => a.textContent?.trim())).toContain('Admin');
    expect(TestBed.inject(Router).url).toBe('/admin/webhooks');
    const rail = root.querySelector('nav[data-slot="admin-rail"]');
    expect(
      [...(rail?.querySelectorAll('a') ?? [])].map((a) =>
        a.textContent?.trim(),
      ),
    ).toEqual(['Webhooks']);
    // Only the group that holds it (#591).
    expect(
      [...(rail?.querySelectorAll('[role="group"] > p') ?? [])].map((p) =>
        p.textContent?.trim(),
      ),
    ).toEqual(['Integrations']);
    // The other pages stay closed to them.
    await harness.navigateByUrl('/admin/roles');
    await harness.fixture.whenStable();
    expect(root.querySelector('main')?.textContent).toContain('No access');
  });

  it('lists the admin pages in a rail under five group headings, Project settings current on its topics (#591)', async () => {
    const harness = await open('/admin/settings/languages');
    const root = harness.fixture.nativeElement as HTMLElement;
    const rail = root.querySelector('nav[data-slot="admin-rail"]');
    expect(rail?.getAttribute('aria-label')).toBe('Admin sections');
    const groups = [...(rail?.querySelectorAll('[role="group"]') ?? [])];
    expect(
      groups.map((g) => [
        g.querySelector('p')?.textContent?.trim(),
        [...g.querySelectorAll('a')].map((a) => a.textContent?.trim()),
      ]),
    ).toEqual([
      [
        'People and access',
        ['Users', 'Roles', 'Group mappings', 'Service accounts'],
      ],
      ['Content', ['Project settings', 'Variants', 'Page design', 'Import']],
      ['Look', ['Branding']],
      ['Integrations', ['Webhooks']],
      ['Operations', ['System', 'Backups', 'Audit log']],
    ]);
    // Each group is named by its heading.
    expect(groups[0]?.getAttribute('aria-labelledby')).toBe(
      groups[0]?.querySelector('p')?.id,
    );
    expect(
      rail?.querySelector('a[aria-current="page"]')?.textContent?.trim(),
    ).toBe('Project settings');
    // The phone-width select (its options shown only while it is open): the e2e flow's.
    expect(root.querySelector('[data-slot="admin-rail-select"]')).toBeTruthy();
  });

  it('shows "Page not found" for unknown paths, keeping the address', async () => {
    const harness = await open('/nothing-here');
    expect(TestBed.inject(Router).url).toBe('/nothing-here');
    const main = (harness.fixture.nativeElement as HTMLElement).querySelector(
      'main',
    );
    expect(main?.querySelector('[data-testid="not-found-page"]')).toBeTruthy();
    expect(main?.textContent).not.toContain('No access');
  });
});

describe('route access', () => {
  it('does not open a section the role can never use, by address either', async () => {
    const harness = await open('/admin/roles', ['content.read']);
    const root = harness.fixture.nativeElement as HTMLElement;
    expect(root.querySelector('main')?.textContent).toContain('No access');
    expect(root.querySelector('main')?.textContent).not.toContain('Roles');
  });

  it('never shows the audit log to a role without admin.roles (#269)', async () => {
    const harness = await open('/admin/audit', [
      'content.read',
      'content.read.draft',
      'content.edit',
      'content.review',
      'content.approve',
      'release.publish',
    ]);
    const root = harness.fixture.nativeElement as HTMLElement;
    expect(root.querySelector('main')?.textContent).toContain('No access');
    // Reading drafts opens Admin for Page design (#392), never the audit log's page or entries.
    expect(
      root.querySelector('nav[data-slot="admin-rail"]')?.textContent ?? '',
    ).not.toContain('Audit log');
    expect(root.querySelector('table')).toBeNull();
  });

  it('keeps the sidebar toggle while moving inside a section', async () => {
    const harness = await open('/admin/roles');
    const state = TestBed.inject(ShellState);
    expect(state.collapsed()).toBe(true);
    state.toggle();
    await harness.navigateByUrl('/admin/variants');
    expect(state.collapsed()).toBe(false);
  });
});

describe('scroll containers', () => {
  it('registers the main area with the scroll dispatcher, so open overlays follow its scroll', async () => {
    const harness = await open('/content');
    const main = (harness.fixture.nativeElement as HTMLElement).querySelector(
      'main',
    );
    const registered = [
      ...TestBed.inject(ScrollDispatcher).scrollContainers.keys(),
    ].map((c) => c.getElementRef().nativeElement);
    expect(registered).toContain(main);
  });
});

describe('sidebar choice', () => {
  it("keeps the person's choice across routes, including the content browser", async () => {
    const harness = await open('/content');
    const state = TestBed.inject(ShellState);
    state.setOpen(false);
    await harness.navigateByUrl('/review');
    expect(state.collapsed()).toBe(true);
    await harness.navigateByUrl('/content');
    expect(state.collapsed()).toBe(true);
    state.toggle();
    await harness.navigateByUrl('/media');
    expect(state.collapsed()).toBe(false);
  });

  it('keeps the choice after a reload', async () => {
    const harness = await open('/review');
    TestBed.inject(ShellState).toggle();
    await harness.fixture.whenStable();
    TestBed.resetTestingModule();
    const reloaded = await open('/review');
    expect(TestBed.inject(ShellState).collapsed()).toBe(false);
    await reloaded.navigateByUrl('/media');
    expect(TestBed.inject(ShellState).collapsed()).toBe(false);
  });

  it('applies the route default when nothing was ever chosen', async () => {
    const harness = await open('/content');
    const state = TestBed.inject(ShellState);
    expect(state.collapsed()).toBe(false);
    await harness.navigateByUrl('/media');
    expect(state.collapsed()).toBe(true);
    expect(localStorage.getItem('openfolia.sidebar')).toBeNull();
  });
});

describe('a chosen change set whose branch is gone (#317)', () => {
  const ID = '00000000-0000-7000-8000-000000000001';
  const BRANCH = `change-sets/${ID}`;
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem(
      'openfolia.change-set',
      JSON.stringify({ id: ID, title: 'Lost branch', branch: BRANCH }),
    );
  });

  const message = (root: HTMLElement) =>
    root.querySelector('[data-testid=change-set-branch-missing]');

  it('shows one message in place of a screen that reads at it, and the screen again once left', async () => {
    const harness = await open('/content');
    const root = harness.fixture.nativeElement as HTMLElement;
    expect(message(root)).toBeNull();
    TestBed.inject(ReadRef).missing.set(BRANCH);
    await harness.fixture.whenStable();
    expect(message(root)?.textContent).toContain(
      'This revision’s branch is missing from the content repository.',
    );
    expect(root.querySelector('main router-outlet')).toBeNull();
    // The rest of the page stands: the sidebar, the breadcrumb.
    expect(items(root)).toHaveLength(9);
    expect(root.querySelector('z-breadcrumb')).toBeTruthy();
    root
      .querySelector<HTMLButtonElement>('[data-testid=change-set-leave]')
      ?.click();
    await harness.fixture.whenStable();
    expect(message(root)).toBeNull();
    expect(root.querySelector('main router-outlet')).toBeTruthy();
  });

  it('leaves screens that read nothing at it as they are', async () => {
    const harness = await open('/admin/users');
    const root = harness.fixture.nativeElement as HTMLElement;
    TestBed.inject(ReadRef).missing.set(BRANCH);
    await harness.fixture.whenStable();
    expect(message(root)).toBeNull();
    await harness.navigateByUrl('/admin/settings');
    await harness.fixture.whenStable();
    expect(message(root)).toBeTruthy();
  });
});
