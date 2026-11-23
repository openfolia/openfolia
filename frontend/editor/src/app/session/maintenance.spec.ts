import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { provideZard } from '@openfolia/ui/core';

import { apiErrorInterceptor } from '../api/api-interceptors';
import { MeService } from '../permissions/me';
import {
  answer,
  config,
  maintenanceLine,
  paged,
} from '../releases/testing/releases';
import { CarryForward } from './carry-forward';
import { CarryForwardConflictsComponent } from './carry-forward-conflicts.component';
import { ChangeSetControlComponent } from './change-set-control.component';
import { ChangeSetSession } from './change-set-session';
import { LineBadgeComponent } from './line-badge.component';
import { MaintenanceLines } from './maintenance-lines';

const LINE_BRANCH = 'maintenance/north/2.1';
const text = () => document.body.textContent?.replace(/\s+/g, ' ') ?? '';

const changeSet = (
  id: string,
  over: { baseRef?: string; state?: string; title?: string } = {},
) => ({
  type: 'ChangeSet',
  id,
  attributes: {
    title: over.title ?? 'Torque fix',
    description: null,
    state: over.state ?? 'draft',
    author: { kind: 'user', id: 'a' },
    baseRef: over.baseRef ?? 'main',
    baseCommit: 'c',
    branch: `change-sets/${id}`,
    reviewHead: null,
    mergeCommit: null,
    createdAt: '2026-11-20T10:00:00Z',
    updatedAt: '2026-11-20T10:00:00Z',
  },
  meta: { branchMissing: false },
});

/** The answers every test here gets: the lines, the configuration (product labels), the list. */
const handlers = (changeSets: readonly unknown[] = []) =>
  [
    [
      (r: { url: string }) => r.url === '/api/maintenance-lines',
      () => paged([maintenanceLine()]),
    ],
    [
      (r: { url: string }) => r.url === '/api/config',
      () => ({
        data: { type: 'ProjectConfig', id: 'main', attributes: config() },
      }),
    ],
    [
      (r: { url: string; method: string }) =>
        r.url === '/api/change-sets' && r.method === 'GET',
      () => paged(changeSets),
    ],
  ] as const;

function setup(permissions = ['content.edit', 'content.read.draft']) {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(withInterceptors([apiErrorInterceptor])),
      provideHttpClientTesting(),
      provideRouter([]),
      provideZard(),
    ],
  });
  TestBed.inject(MeService).set({
    id: 'a',
    kind: 'user',
    name: 'A',
    role: '',
    permissions: new Set(permissions),
  });
  return TestBed.inject(HttpTestingController);
}

@Component({
  imports: [LineBadgeComponent],
  template: `<of-line-badge [baseRef]="ref()" />`,
})
class BadgeHost {
  readonly ref = signal<string | null>(LINE_BRANCH);
}

describe('the product version a revision fixes (#250)', () => {
  afterEach(() => document.body.replaceChildren());

  it('the badge names a line by its product and version in words, never its branch; nothing for main', async () => {
    const http = setup();
    const fixture = TestBed.createComponent(BadgeHost);
    document.body.appendChild(fixture.nativeElement);
    const settle = async () => {
      for (let i = 0; i < 3; i++) {
        await new Promise((r) => setTimeout(r, 0));
        await fixture.whenStable();
      }
    };
    await settle();
    await answer(http, handlers(), settle);
    const badge = document.querySelector('[data-slot="line-badge"]');
    // In words and with an icon (hidden from screen readers), not by its colour alone.
    expect(
      badge?.querySelector('[aria-hidden="true"]:not(ng-icon)')?.textContent,
    ).toBe('North 2.1');
    expect(badge?.querySelector('.sr-only')?.textContent).toBe(
      'Product version North 2.1',
    );
    expect(badge?.getAttribute('title')).toBe(
      'Fixes product version North 2.1',
    );
    expect(text()).not.toContain(LINE_BRANCH);

    fixture.componentInstance.ref.set('main');
    await settle();
    expect(document.querySelector('[data-slot="line-badge"]')).toBeNull();
  });

  it('a badge shown before the person is known reads the lines once they are', async () => {
    const http = setup();
    const me = TestBed.inject(MeService);
    const person = me.me();
    me.set({ ...person, permissions: new Set() });
    const fixture = TestBed.createComponent(BadgeHost);
    document.body.appendChild(fixture.nativeElement);
    const settle = async () => {
      for (let i = 0; i < 3; i++) {
        await new Promise((r) => setTimeout(r, 0));
        await fixture.whenStable();
      }
    };
    await settle();
    http.expectNone('/api/maintenance-lines');
    me.set(person);
    await settle();
    await answer(http, handlers(), settle);
    expect(
      document.querySelector('[data-slot="line-badge"]')?.textContent,
    ).toContain('North 2.1');
  });

  it('a base is named by its product version, an unknown branch never by its name before the lines are read', async () => {
    const http = setup();
    const lines = TestBed.inject(MaintenanceLines);
    expect(lines.label('main')).toBe('main');
    // Not read yet: a branch could be a line's, so its name is not shown.
    expect(lines.label(LINE_BRANCH)).toBe('an older product version');
    const settle = () => new Promise<void>((r) => setTimeout(r, 0));
    await settle();
    await answer(http, handlers(), settle);
    expect(lines.label(LINE_BRANCH)).toBe('North 2.1');
  });

  it('a line started since the lines were read is never named by its branch, and is read once more', async () => {
    const http = setup();
    const lines = TestBed.inject(MaintenanceLines);
    lines.label(LINE_BRANCH);
    const settle = () => new Promise<void>((r) => setTimeout(r, 0));
    await settle();
    await answer(http, handlers(), settle);
    const LATER = 'maintenance/north/2.2';
    expect(lines.label(LATER)).toBe('an older product version');
    await settle();
    const later = maintenanceLine({
      id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a61',
      revision: '2.2',
      branch: LATER,
    });
    const again = http.match((r) => r.url === '/api/maintenance-lines');
    expect(again).toHaveLength(1);
    again[0]?.flush(paged([later, maintenanceLine()]));
    await settle();
    expect(lines.label(LATER)).toBe('North 2.2');
    // Not found again: asked once, not on every read of the label.
    expect(lines.label('elsewhere')).toBe('an older product version');
    lines.label('elsewhere');
    await settle();
    expect(http.match((r) => r.url === '/api/maintenance-lines')).toHaveLength(
      1,
    );
  });

  it('the picker’s New revision offers Current (main) or an open line, and starts on the line chosen', async () => {
    const http = setup();
    const fixture = TestBed.createComponent(ChangeSetControlComponent);
    document.body.appendChild(fixture.nativeElement);
    const settle = async () => {
      for (let i = 0; i < 3; i++) {
        await new Promise((r) => setTimeout(r, 0));
        await fixture.whenStable();
      }
    };
    void TestBed.inject(ChangeSetSession).refresh();
    await settle();
    await answer(
      http,
      handlers([
        changeSet('cs-line', { baseRef: LINE_BRANCH, title: 'Older fix' }),
      ]),
      settle,
    );
    const trigger = document.querySelector<HTMLElement>(
      '[data-testid=change-set-trigger]',
    );
    trigger?.click();
    await settle();
    await answer(http, handlers(), settle);
    // A revision on a line is listed with its product version.
    const listed = [...document.querySelectorAll('[role=option]')].find((o) =>
      o.textContent?.includes('Older fix'),
    );
    expect(listed?.textContent?.replace(/\s+/g, ' ')).toContain('North 2.1');
    expect(text()).not.toContain(LINE_BRANCH);

    document
      .querySelector('[data-testid=change-set-start] [role=option]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    const choice = document.querySelector(
      '[data-testid=change-set-start-line]',
    );
    expect(choice?.textContent?.replace(/\s+/g, ' ')).toContain(
      'Product version',
    );
    const radios = [
      ...(choice?.querySelectorAll('[role=radio], input[type=radio]') ?? []),
    ];
    expect(radios.length).toBeGreaterThanOrEqual(2);
    expect(choice?.textContent).toContain('Current (main)');
    expect(choice?.textContent).toContain('North 2.1');
    // Current (main) is chosen by default.
    const main = document.querySelector<HTMLElement>('#change-set-line-main');
    expect(
      main?.getAttribute('aria-checked') ??
        String((main as HTMLInputElement | null)?.checked),
    ).toBe('true');

    const line = document.querySelector<HTMLElement>(
      `#change-set-line-${maintenanceLine().id}`,
    );
    line?.click();
    await settle();
    const title = document.querySelector<HTMLInputElement>(
      '[data-testid=change-set-start-form] input[z-input]',
    );
    if (!title) throw new Error('no title field');
    title.value = 'Fix the 2.1 torque table';
    title.dispatchEvent(new Event('input'));
    await settle();
    document
      .querySelector<HTMLFormElement>('[data-testid=change-set-start-form]')
      ?.requestSubmit();
    await settle();
    const post = http.expectOne(
      (r) => r.url === '/api/change-sets' && r.method === 'POST',
    );
    expect(post.request.body).toEqual({
      data: {
        type: 'ChangeSet',
        attributes: {
          title: 'Fix the 2.1 torque table',
          maintenanceLine: maintenanceLine().id,
        },
      },
    });
    post.flush(
      {
        data: changeSet('cs-new', {
          baseRef: LINE_BRANCH,
          title: 'Fix the 2.1 torque table',
        }),
      },
      { status: 201, statusText: 'Created' },
    );
    await settle();
    expect(TestBed.inject(ChangeSetSession).selectedOption()?.baseRef).toBe(
      LINE_BRANCH,
    );
  });

  it('without open lines the form has no Product version choice and starts on main', async () => {
    const http = setup();
    const fixture = TestBed.createComponent(ChangeSetControlComponent);
    document.body.appendChild(fixture.nativeElement);
    const settle = async () => {
      for (let i = 0; i < 3; i++) {
        await new Promise((r) => setTimeout(r, 0));
        await fixture.whenStable();
      }
    };
    await settle();
    document
      .querySelector<HTMLElement>('[data-testid=change-set-trigger]')
      ?.click();
    await settle();
    await answer(
      http,
      [
        [
          (r: { url: string }) => r.url === '/api/maintenance-lines',
          () => paged([maintenanceLine({ state: 'closed' })]),
        ],
        ...handlers(),
      ],
      settle,
    );
    document
      .querySelector('[data-testid=change-set-start] [role=option]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    expect(
      document.querySelector('[data-testid=change-set-start-form]'),
    ).toBeTruthy();
    expect(
      document.querySelector('[data-testid=change-set-start-line]'),
    ).toBeNull();
  });
});

@Component({
  imports: [CarryForwardConflictsComponent],
  template: `<of-carry-forward-conflicts />`,
})
class ConflictsHost {}

describe('carrying a fix forward to main (#250)', () => {
  afterEach(() => document.body.replaceChildren());

  it('opens the new draft; what main changed differently is listed by module and block, each opening the editor at it', async () => {
    const http = setup();
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    const fixture = TestBed.createComponent(ConflictsHost);
    document.body.appendChild(fixture.nativeElement);
    const settle = async () => {
      for (let i = 0; i < 3; i++) {
        await new Promise((r) => setTimeout(r, 0));
        await fixture.whenStable();
      }
    };
    const lines = TestBed.inject(MaintenanceLines);
    void lines.refresh();
    await settle();
    await answer(http, handlers(), settle);

    const carrying = TestBed.inject(CarryForward).carry({
      id: 'cs-fix',
      title: 'Torque fix',
      baseRef: LINE_BRANCH,
    });
    await settle();
    http.expectOne('/api/change-sets/cs-fix/carry-forward').flush({
      data: changeSet('cs-carried', { title: 'Carry forward: Torque fix' }),
      meta: {
        carryForward: {
          from: 'cs-fix',
          commit: 'abc',
          applied: [],
          conflicts: [
            {
              path: 'modules/en/torque.adoc',
              subject: { type: 'module', lang: 'en', moduleId: 'torque' },
              kinds: ['contents'],
              blockIds: ['p1', 'table-2'],
            },
          ],
          total: 1,
        },
      },
    });
    await settle();
    await answer(http, handlers([changeSet('cs-carried')]), settle);
    expect(await carrying).toBe('cs-carried');
    // The new draft is chosen and opens in the review.
    expect(TestBed.inject(ChangeSetSession).selected()?.id).toBe('cs-carried');
    expect(navigate).toHaveBeenCalledWith(['/review'], {
      queryParams: { state: 'draft', cs: 'cs-carried' },
    });

    const list = document.querySelector(
      '[data-testid=carry-forward-conflicts]',
    );
    expect(list?.textContent?.replace(/\s+/g, ' ')).toContain('torque (en)');
    expect(list?.textContent).toContain('changed on main too');
    const blocks = [
      ...document.querySelectorAll<HTMLButtonElement>(
        '[data-slot=carried-block]',
      ),
    ];
    expect(blocks.map((b) => b.textContent?.trim())).toEqual(['p1', 'table-2']);
    expect(blocks[1]?.getAttribute('aria-label')).toBe(
      'Open block table-2 of torque (en) in the editor',
    );
    expect(text()).not.toContain(LINE_BRANCH);

    blocks[1]?.click();
    await settle();
    expect(navigate).toHaveBeenLastCalledWith(['/content', 'en', 'torque'], {
      queryParams: { cs: 'cs-carried', block: 'table-2' },
    });
  });

  it('carried already: says so and offers the way to that draft', async () => {
    const http = setup();
    const settle = () => new Promise<void>((r) => setTimeout(r, 0));
    const carrying = TestBed.inject(CarryForward).carry({
      id: 'cs-fix',
      title: 'Torque fix',
      baseRef: LINE_BRANCH,
    });
    await settle();
    http.expectOne('/api/change-sets/cs-fix/carry-forward').flush(
      {
        errors: [
          {
            status: '409',
            code: 'already-carried-forward',
            title: 'Conflict',
            meta: { changeSetId: 'cs-earlier' },
          },
        ],
      },
      { status: 409, statusText: 'Conflict' },
    );
    expect(await carrying).toBeNull();
    await answer(http, handlers(), settle);
  });
});
