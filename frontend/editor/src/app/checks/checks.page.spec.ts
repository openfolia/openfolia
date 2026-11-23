import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  type TestRequest,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';

import { provideZard } from '@openfolia/ui/core';

import { ReadRef } from '../api';
import { apiErrorInterceptor } from '../api/api-interceptors';
import { MeService } from '../permissions/me';
import { ChangeSetSession } from '../session/change-set-session';
import { provideChangeSetUrl } from '../session/change-set-url';
import { ChecksPage } from './checks.page';

const CS = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const BRANCH = `change-sets/${CS}`;

const item = (
  id: string,
  over: Record<string, unknown>,
  title: string | null = 'Intro',
) => ({
  type: 'Check',
  id,
  attributes: {
    code: 'missing-image',
    severity: 'blocking',
    category: 'image',
    subject: { type: 'module', lang: 'en', moduleId: 'intro' },
    blockId: null,
    message: '',
    params: {},
    ...over,
  },
  meta: { variants: [], languages: [], title },
});

const doc = (
  data: unknown[],
  counts = { blocking: 2, warning: 1 },
  page = { currentPage: 1, lastPage: 1, perPage: 50, total: data.length },
) => ({
  data,
  meta: {
    page,
    counts,
    modules: { checked: 5, withoutIssues: 3 },
    commit: 'c1',
  },
  links: { self: '', first: '', last: '', prev: null, next: null },
});

const checks = doc([
  item('a', { code: 'missing-image', blockId: 'img-1' }),
  item('b', { code: 'missing-module', params: { module: 'gone' } }),
  item(
    'c',
    {
      code: 'missing-translation',
      severity: 'warning',
      category: 'translation',
      subject: { type: 'module', lang: 'en', moduleId: 'safety' },
      params: { lang: 'de' },
    },
    'Safety',
  ),
]);

async function render(
  options: {
    url?: string;
    changeSet?: boolean;
    permissions?: string[];
  } = {},
) {
  if (options.changeSet !== false) {
    localStorage.setItem(
      'openfolia.change-set',
      JSON.stringify({ id: CS, title: 'Trial', branch: BRANCH }),
    );
  }
  TestBed.configureTestingModule({
    providers: [
      provideRouter([
        {
          path: 'checks',
          component: ChecksPage,
          data: { changeSetParam: 'session' },
        },
        { path: 'releases', children: [] },
      ]),
      provideChangeSetUrl(),
      provideHttpClient(withInterceptors([apiErrorInterceptor])),
      provideHttpClientTesting(),
      provideZard(),
    ],
  });
  if (options.changeSet !== false) {
    // The list has confirmed the choice: reads follow its branch.
    TestBed.inject(ReadRef).ref.set(BRANCH);
  }
  TestBed.inject(MeService).set({
    id: 'author',
    kind: 'user',
    name: 'Author',
    role: '',
    permissions: new Set(options.permissions ?? ['content.read']),
  });
  const { RouterTestingHarness } = await import('@angular/router/testing');
  const harness = await RouterTestingHarness.create();
  const http = TestBed.inject(HttpTestingController);
  void harness.navigateByUrl(options.url ?? '/checks');
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 0));
      await harness.fixture.whenStable();
    }
  };
  await settle();
  return {
    harness,
    http,
    settle,
    el: () => harness.routeNativeElement as HTMLElement,
  };
}

const changeSetChecks = (http: HttpTestingController): TestRequest =>
  http.expectOne((r) => r.url === `/api/change-sets/${CS}/checks`);

describe('ChecksPage', () => {
  it('shows the chosen change set’s checks by module, with counts and links to fix them', async () => {
    const { http, settle, el } = await render();
    const req = changeSetChecks(http);
    expect(req.request.params.get('page[size]')).toBe('50');
    expect(req.request.params.has('filter[severity]')).toBe(false);
    req.flush(checks);
    await settle();

    const text = el().textContent ?? '';
    expect(text).toContain('What the revision “Trial” changes');
    expect(text).toContain('Blocking issues');
    expect(text).toContain('Modules without issues, of 5');
    // One header per module, then its checks.
    const headers = [...el().querySelectorAll('th[scope="rowgroup"]')].map(
      (th) =>
        [...th.querySelectorAll('span span')].map((s) => s.textContent?.trim()),
    );
    expect(headers).toEqual([
      ['Intro', 'intro · English', '2 blocking'],
      ['Safety', 'safety · English', '1 warning'],
    ]);
    expect(text).toContain('Missing image');
    expect(text).toContain('Refers to “gone”, which does not exist.');
    expect(text).toContain('No German translation');
    // Severity is a word and an icon, never colour alone.
    const badges = [...el().querySelectorAll('z-badge')].map((b) =>
      b.textContent?.trim(),
    );
    expect(badges).toEqual(['Blocking', 'Blocking', 'Warning']);

    const links = [...el().querySelectorAll<HTMLAnchorElement>('td a')];
    expect(links.map((a) => a.textContent?.trim())).toEqual([
      'Go to block',
      'Open',
      'Open',
    ]);
    expect(links[0]?.getAttribute('href')).toBe(
      `/content/en/intro?cs=${CS}&block=img-1`,
    );
    expect(links[0]?.getAttribute('aria-label')).toBe(
      'Go to block in Intro: Missing image',
    );
    expect(links[2]?.getAttribute('href')).toBe(`/content/en/safety?cs=${CS}`);
    // No release for a change set: that is a manual's.
    expect(text).not.toContain('Create release');
  });

  it('filters by severity in the address, and runs again keeping the rows', async () => {
    const { http, settle, el } = await render();
    changeSetChecks(http).flush(checks);
    await settle();

    const blocking = [
      ...el().querySelectorAll<HTMLInputElement>('input[type="radio"]'),
    ].find((r) => r.value === 'blocking');
    blocking?.click();
    await settle();
    expect(TestBed.inject(Router).url).toBe(
      `/checks?cs=${CS}&severity=blocking`,
    );
    const filtered = changeSetChecks(http);
    expect(filtered.request.params.get('filter[severity]')).toBe('blocking');
    filtered.flush(doc([item('a', {})]));
    await settle();

    const again = [...el().querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Run again'),
    );
    again?.click();
    await settle();
    // The last answer stays, dimmed and inert, while it runs.
    expect(el().querySelector('[aria-busy="true"][inert]')).toBeTruthy();
    expect(el().textContent).toContain('Missing image');
    changeSetChecks(http).flush(doc([]));
    await settle();
    expect(el().textContent).toContain('None of this kind');
  });

  it('checks a manual at the chosen change set, and blocks the release with the reason', async () => {
    const { http, settle, el } = await render({
      url: '/checks?manual=op',
      permissions: ['content.read', 'release.publish'],
    });
    http
      .expectOne((r) => r.url === '/api/manuals/op')
      .flush({
        data: { type: 'Manual', id: 'op', attributes: { title: 'Operating' } },
      });
    const req = http.expectOne((r) => r.url === '/api/manuals/op/checks');
    expect(req.request.params.get('ref')).toBe(BRANCH);
    req.flush(checks);
    await settle();
    expect(el().textContent).toContain(
      'Manual “Operating” in the revision “Trial”',
    );
    const release = [...el().querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Create release'),
    );
    expect(release?.getAttribute('aria-disabled')).toBe('true');
    expect(release?.getAttribute('aria-description')).toBe(
      'Fix the blocking issues first.',
    );
  });

  it('opens "New release" when nothing blocks', async () => {
    const { http, settle, el } = await render({
      url: '/checks?manual=op',
      permissions: ['content.read', 'release.publish'],
    });
    http
      .expectOne((r) => r.url === '/api/manuals/op')
      .flush({
        data: { type: 'Manual', id: 'op', attributes: { title: 'Operating' } },
      });
    http
      .expectOne((r) => r.url === '/api/manuals/op/checks')
      .flush(doc([], { blocking: 0, warning: 0 }));
    await settle();
    const release = [...el().querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Create release'),
    );
    expect(release?.getAttribute('aria-disabled')).toBeNull();
    release?.click();
    await settle();
    expect(TestBed.inject(Router).url).toBe('/releases?create=open');
  });

  it('hides the release from a role that can never publish', async () => {
    const { http, settle, el } = await render({ url: '/checks?manual=op' });
    http
      .expectOne((r) => r.url === '/api/manuals/op')
      .flush({
        data: { type: 'Manual', id: 'op', attributes: { title: 'Operating' } },
      });
    http.expectOne((r) => r.url === '/api/manuals/op/checks').flush(checks);
    await settle();
    const release = [...el().querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Create release'),
    );
    expect(release?.hidden).toBe(true);
  });

  it('checks the change set a link names, without choosing it for the person', async () => {
    const other = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c';
    const { http, settle, el } = await render({
      url: `/checks?changeSet=${other}`,
    });
    http
      .expectOne((r) => r.url === `/api/change-sets/${other}`)
      .flush({
        data: {
          type: 'ChangeSet',
          id: other,
          attributes: { title: 'Merged work', state: 'merged' },
        },
      });
    http
      .expectOne((r) => r.url === `/api/change-sets/${other}/checks`)
      .flush(checks);
    await settle();
    expect(el().textContent).toContain(
      'What the revision “Merged work” changes',
    );
    // The person's own change set stays theirs; a merged one is not theirs to choose, so a fix
    // opens where they are.
    expect(TestBed.inject(Router).url).toContain(`cs=${CS}`);
    const link = el().querySelector<HTMLAnchorElement>('td a');
    expect(link?.getAttribute('href')).toBe(
      `/content/en/intro?cs=${CS}&block=img-1`,
    );
  });

  it('opens a fix in the change set the link names when the person may choose it', async () => {
    const open = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5d';
    const { http, settle, el } = await render({
      url: `/checks?changeSet=${open}`,
    });
    // The person's list: their own change set and the one checked, both open.
    void TestBed.inject(ChangeSetSession).refresh();
    const changeSet = (id: string, title: string) => ({
      type: 'ChangeSet',
      id,
      attributes: {
        title,
        state: 'in-review',
        branch: `change-sets/${id}`,
        author: { kind: 'user', id: 'someone' },
        createdAt: '2026-01-01T00:00:00Z',
      },
    });
    http
      .expectOne((r) => r.url === '/api/change-sets')
      .flush({
        data: [changeSet(CS, 'Trial'), changeSet(open, 'Under review')],
        meta: { page: { currentPage: 1, lastPage: 1, perPage: 100, total: 2 } },
        links: { self: '', first: '', last: '', prev: null, next: null },
      });
    http
      .expectOne((r) => r.url === `/api/change-sets/${open}`)
      .flush({ data: changeSet(open, 'Under review') });
    http
      .expectOne((r) => r.url === `/api/change-sets/${open}/checks`)
      .flush(checks);
    await settle();
    expect(TestBed.inject(Router).url).toContain(`cs=${CS}`);
    const link = el().querySelector<HTMLAnchorElement>('td a');
    expect(link?.getAttribute('href')).toBe(
      `/content/en/intro?cs=${open}&block=img-1`,
    );
  });

  it('shows the last page in place of one past the end', async () => {
    const { http, settle } = await render({ url: '/checks?page=4' });
    changeSetChecks(http).flush(
      doc([], undefined, {
        currentPage: 4,
        lastPage: 2,
        perPage: 50,
        total: 60,
      }),
    );
    await settle();
    expect(TestBed.inject(Router).url).toContain('page=2');
    const again = changeSetChecks(http);
    expect(again.request.params.get('page[number]')).toBe('2');
    again.flush(checks);
    await settle();
  });

  it('says what to choose when there is nothing to check', async () => {
    const { http, el } = await render({ changeSet: false });
    http.expectNone((r) => r.url.includes('/checks'));
    expect(el().textContent).toContain('Nothing to check');
    expect(el().querySelector('of-list-frame')).toBeNull();
  });

  it('shows no issues as an empty state', async () => {
    const { http, settle, el } = await render();
    changeSetChecks(http).flush(doc([], { blocking: 0, warning: 0 }));
    await settle();
    expect(el().textContent).toContain('No issues found');
  });

  it('shows a refusal as no access, and a failure with a retry', async () => {
    const { http, settle, el } = await render();
    changeSetChecks(http).flush(
      { errors: [{ status: '403', code: 'forbidden', title: 'Forbidden' }] },
      { status: 403, statusText: 'Forbidden' },
    );
    await settle();
    expect(el().querySelector('of-no-access')).toBeTruthy();
  });

  it('retries a failed read', async () => {
    const { http, settle, el } = await render();
    changeSetChecks(http).flush(
      { errors: [{ status: '503', code: 'unavailable', title: 'Busy' }] },
      { status: 503, statusText: 'Service Unavailable' },
    );
    await settle();
    const retry = el().querySelector<HTMLButtonElement>(
      'of-error-state button',
    );
    expect(retry).toBeTruthy();
    retry?.click();
    await settle();
    changeSetChecks(http).flush(checks);
    await settle();
    expect(el().textContent).toContain('Missing image');
  });
});
