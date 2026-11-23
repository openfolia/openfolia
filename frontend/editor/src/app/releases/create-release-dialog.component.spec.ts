import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  type TestRequest,
} from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { provideZard } from '@openfolia/ui/core';

import { apiErrorInterceptor } from '../api/api-interceptors';
import { MeService } from '../permissions/me';
import { CreateReleaseDialogComponent } from './create-release-dialog.component';
import { ReleaseSource } from './release-source';
import type { ReleaseItem } from './releases-model';
import {
  answer,
  config,
  maintenanceLine,
  manual,
  paged,
  release,
} from './testing/releases';

type Req = TestRequest['request'];

@Component({
  imports: [CreateReleaseDialogComponent],
  providers: [ReleaseSource],
  template: `<of-create-release-dialog
    [(open)]="open"
    (created)="created.set($event)"
  />`,
})
class Host {
  readonly open = signal(true);
  readonly created = signal<ReleaseItem | null>(null);
}

const check = (id: string, severity: 'blocking' | 'warning') => ({
  type: 'Check',
  id,
  attributes: {
    code: 'missing-image',
    severity,
    category: 'image',
    subject: { type: 'module', lang: 'en', moduleId: 'intro' },
    blockId: 'img-1',
    message: '',
    params: {},
  },
  meta: { variants: [], languages: [], title: 'Intro' },
});

const handlers = (
  counts = { blocking: 0, warning: 0 },
  lines: readonly unknown[] = [],
) =>
  [
    [
      (r: Req) => r.url === '/api/config',
      () => ({
        data: { type: 'ProjectConfig', id: 'main', attributes: config() },
      }),
    ],
    [(r: Req) => r.url === '/api/maintenance-lines', () => paged(lines)],
    [
      (r: Req) => r.url === '/api/refs',
      () =>
        paged([
          {
            type: 'Ref',
            id: 'main',
            attributes: {
              kind: 'branch',
              name: 'main',
              commit: 'abcdef0123456789',
            },
          },
        ]),
    ],
    [
      (r: Req) => r.url === '/api/manuals',
      () =>
        paged([manual('operating', 'Operating'), manual('service', 'Service')]),
    ],
    [
      (r: Req) => r.url === '/api/manuals/operating/checks',
      () =>
        paged(
          [
            ...(counts.blocking ? [check('b1', 'blocking')] : []),
            ...(counts.warning ? [check('w1', 'warning')] : []),
          ],
          counts.blocking + counts.warning,
          { counts, commit: 'abcdef0123456789' },
        ),
    ],
    [
      (r: Req) => r.url === '/api/manuals/service/checks',
      () =>
        paged([], 0, {
          counts: { blocking: 0, warning: 0 },
          commit: 'abcdef0',
        }),
    ],
    [
      (r: Req) => r.url === '/api/translations/status',
      (r: Req) =>
        paged([], r.params.get('filter[state]') === 'missing' ? 1 : 0),
    ],
  ] as const;

async function render(
  counts?: { blocking: number; warning: number },
  permissions = ['content.read', 'release.publish'],
  lines: readonly unknown[] = [],
) {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      provideHttpClient(withInterceptors([apiErrorInterceptor])),
      provideHttpClientTesting(),
      provideZard(),
    ],
  });
  TestBed.inject(MeService).set({
    id: 'publisher',
    kind: 'user',
    name: 'Publisher',
    role: '',
    permissions: new Set(permissions),
  });
  const fixture = TestBed.createComponent(Host);
  const http = TestBed.inject(HttpTestingController);
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 0));
      await fixture.whenStable();
    }
  };
  await settle();
  const seen = await answer(http, handlers(counts, lines), settle);
  const dialog = () =>
    fixture.debugElement.query(
      (d) => d.componentInstance instanceof CreateReleaseDialogComponent,
    ).componentInstance as { setProduct(v: string): void };
  return { fixture, http, settle, seen, dialog };
}

const body = () => document.body.textContent?.replace(/\s+/g, ' ') ?? '';
const slot = (name: string) =>
  document.querySelector<HTMLButtonElement>(`[data-slot="${name}"]`);
const field = (name: string) =>
  document.querySelector<HTMLElement>(`[data-field="${name}"]`);
const step = (name: string) =>
  document.querySelector<HTMLButtonElement>(`[data-step="${name}"]`);
const type = (selector: string, value: string) => {
  const field = document.querySelector<HTMLInputElement>(selector);
  if (!field) throw new Error(`no ${selector}`);
  field.value = value;
  field.dispatchEvent(new Event('input'));
};

describe('CreateReleaseDialogComponent', () => {
  it('step 1: the product, the product version, and the commit main is at', async () => {
    const { settle, seen } = await render();
    expect(body()).toContain('Create release');
    expect(seen.find((r) => r.url === '/api/config')?.params.get('ref')).toBe(
      'main',
    );
    expect(slot('commit')?.textContent).toContain(
      'Tags commit abcdef0, where main is now.',
    );
    expect(step('product')?.getAttribute('aria-current')).toBe('step');
    // Without a product and version, Next stays on the step and says why.
    slot('next')?.click();
    await settle();
    expect(step('product')?.getAttribute('aria-current')).toBe('step');
    expect(body()).toContain('Choose the product.');
    expect(body()).toContain('Enter the product version.');
    type('#release-version', '2..1');
    await settle();
    expect(body()).toContain('Use letters, digits, dots');
  });

  it('step 1 on a maintenance line: names the line by product and version, never its branch (#250)', async () => {
    const { settle, dialog, http } = await render(
      undefined,
      ['content.read', 'content.read.draft', 'release.publish'],
      [maintenanceLine()],
    );
    (dialog() as unknown as { setFrom(v: string): void }).setFrom(
      maintenanceLine().id,
    );
    await settle();
    await answer(http, handlers(), settle);
    expect(slot('commit')?.textContent).toContain(
      'Tags commit feed123, the newest state of North 2.1.',
    );
    expect(body()).not.toContain('maintenance/north');
  });

  it('step 2: every manual’s checks at main, blocking first with links to fix them; blocking checks block', async () => {
    const { settle, seen } = await render({ blocking: 1, warning: 1 });
    const checks = seen.filter((r) => r.url.endsWith('/checks'));
    expect(checks.map((r) => r.params.get('ref'))).toEqual(['main', 'main']);
    // The banner shows on every step.
    expect(body()).toContain('1 blocking issue: fix them before releasing');
    step('checks')?.click();
    await settle();
    const manuals = [
      ...document.querySelectorAll('[data-slot="manual-checks"]'),
    ].map((m) => m.textContent?.replace(/\s+/g, ' ').trim());
    expect(manuals[0]).toMatch(/^Operating 1 blocking 1 warning/);
    expect(manuals[1]).toContain('Service Passed');
    const fix = document.querySelector<HTMLAnchorElement>(
      '[data-slot="manual-checks"] a',
    );
    expect(fix?.getAttribute('href')).toContain('/content/en/intro');
    // No confirmation offered while anything blocks; Create says why.
    expect(field('confirm-warnings')).toBeNull();
    step('notes')?.click();
    await settle();
    expect(slot('create')?.getAttribute('aria-disabled')).toBe('true');
    expect(slot('create')?.getAttribute('aria-description')).toBe(
      'Fix the blocking issues first.',
    );
  });

  it('step 2: warnings need a confirmation that names their count', async () => {
    const { settle } = await render({ blocking: 0, warning: 1 });
    step('checks')?.click();
    await settle();
    expect(field('confirm-warnings')?.textContent).toContain(
      'Release despite 1 warning',
    );
    step('notes')?.click();
    await settle();
    expect(slot('create')?.getAttribute('aria-description')).toBe(
      'Confirm the warnings on the Checks step first.',
    );
  });

  it('step 3: every language with how its translations stand, every manual with its variants', async () => {
    const { settle } = await render();
    step('outputs')?.click();
    await settle();
    const languages = [
      ...document.querySelectorAll('[data-slot="language"]'),
    ].map((l) => l.textContent?.replace(/\s+/g, ' ').trim());
    expect(languages).toEqual([
      'EnglishSource',
      'German1 module falls back to English',
    ]);
    expect(body()).toContain('Operating');
    expect(body()).toContain('1 variant · 2 files');
  });

  it('step 4: the notes, per language, and "Major change"; then the release is created and opens', async () => {
    const { fixture, http, settle, dialog } = await render();
    dialog().setProduct('north');
    type('#release-version', '2.2');
    await settle();
    for (const s of ['checks', 'outputs', 'notes']) {
      slot('next')?.click();
      await settle();
      expect(step(s)?.getAttribute('aria-current')).toBe('step');
    }
    expect(body()).toContain('Readers of the manuals it changes are notified.');
    type('#release-notes', 'a\n---\nb');
    await settle();
    expect(slot('create')?.getAttribute('aria-description')).toBe(
      'Correct the notes first.',
    );
    type('#release-notes', ' Torque values corrected. ');
    document
      .querySelector<HTMLButtonElement>(
        '[aria-controls="release-language-notes"]',
      )
      ?.click();
    await settle();
    type('#release-notes-de', 'Drehmomente korrigiert.');
    document.querySelector<HTMLElement>('[data-field="major"] input')?.click();
    await settle();
    expect(slot('create')?.getAttribute('aria-disabled')).not.toBe('true');
    slot('create')?.click();
    await settle();
    const req = http.expectOne('/api/releases');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({
      data: {
        type: 'Release',
        attributes: {
          product: 'north',
          revision: '2.2',
          notes: 'Torque values corrected.',
          notesByLanguage: { de: 'Drehmomente korrigiert.' },
          major: true,
        },
      },
    });
    const created = release({ revision: '2.2' });
    req.flush({ data: created }, { status: 201, statusText: 'Created' });
    await settle();
    expect(fixture.componentInstance.created()?.id).toBe(created.id);
    expect(fixture.componentInstance.open()).toBe(false);
  });

  it('still reads the checks when the configuration cannot be read', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(withInterceptors([apiErrorInterceptor])),
        provideHttpClientTesting(),
        provideZard(),
      ],
    });
    TestBed.inject(MeService).set({
      id: 'publisher',
      kind: 'user',
      name: 'Publisher',
      role: '',
      permissions: new Set(['content.read', 'release.publish']),
    });
    const fixture = TestBed.createComponent(Host);
    const http = TestBed.inject(HttpTestingController);
    const settle = async () => {
      for (let i = 0; i < 4; i++) {
        await new Promise((r) => setTimeout(r, 0));
        await fixture.whenStable();
      }
    };
    await settle();
    await answer(
      http,
      [
        [
          (r: Req) => r.url === '/api/config',
          () => [
            500,
            { errors: [{ status: '500', code: 'internal', title: 'Error' }] },
          ],
        ],
        ...handlers(),
      ],
      settle,
    );
    expect(body()).toContain('All checks passed');
  });

  it('shows why the API refused, keeping what was entered', async () => {
    const { fixture, http, settle, dialog } = await render();
    dialog().setProduct('north');
    type('#release-version', '2.1');
    await settle();
    step('notes')?.click();
    await settle();
    slot('create')?.click();
    await settle();
    http.expectOne('/api/releases').flush(
      {
        errors: [{ status: '409', code: 'release-exists', title: 'Conflict' }],
      },
      { status: 409, statusText: 'Conflict' },
    );
    await settle();
    expect(body()).toContain('This product version is released already.');
    expect(fixture.componentInstance.open()).toBe(true);
  });
});
