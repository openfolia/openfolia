import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { By } from '@angular/platform-browser';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { toEditor } from '@openfolia/content-editor-model';

import { provideZard } from '@openfolia/ui/core';
import { translated } from '@openfolia/ui/i18n';
import { ToastService } from '@openfolia/ui/toast';

import { ReadRef } from '../api';
import { apiErrorInterceptor } from '../api/api-interceptors';
import { BlockEditorComponent } from '../doc-editor/block-editor.component';
import { MeService } from '../permissions/me';
import { ChangeSetSession } from '../session/change-set-session';
import { provideChangeSetUrl } from '../session/change-set-url';
import { ModuleDraft } from './module-draft';
import { ModuleEditorPage } from './module-editor.page';

const CS = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const BRANCH = `change-sets/${CS}`;
const WC = `/api/change-sets/${CS}/modules/en/charging/working-copy`;

const config = {
  languages: { source: 'en', targets: ['de'] },
  moduleTypes: [
    { id: 'procedure', label: 'Procedure', restricted: false, snippet: false },
  ],
  audiences: [{ id: 'public', label: 'Public' }],
  facets: [],
  variantAttributes: [],
  textAttributes: [],
  safetySymbols: [],
  outputLabels: {},
};

const content = {
  schemaVersion: 1,
  id: 'charging',
  meta: { title: 'Charging', type: 'procedure', lang: 'en', facets: {} },
  blocks: [
    {
      type: 'paragraph',
      id: 'intro',
      content: [{ type: 'text', text: 'It charges.' }],
    },
  ],
};

const moduleDoc = {
  data: {
    type: 'Module',
    id: 'en/charging',
    attributes: {
      moduleId: 'charging',
      lang: 'en',
      schemaVersion: 1,
      title: 'Charging',
      moduleType: 'procedure',
      facets: {},
      blocks: content.blocks,
    },
    meta: { status: { changeSets: [] }, issues: [] },
  },
};

const copyDoc = (issues: unknown[] = []) => ({
  data: {
    type: 'WorkingCopy',
    id: `${CS}/module/en/charging`,
    attributes: {
      subject: { type: 'module', lang: 'en', moduleId: 'charging' },
      content,
      version: 0,
      baseCommit: 'c0',
    },
    relationships: { changeSet: { data: { type: 'ChangeSet', id: CS } } },
    meta: { saved: false, issues },
  },
});

const empty = {
  data: [],
  meta: { page: { currentPage: 1, lastPage: 1, perPage: 100, total: 0 } },
  links: { self: '', first: '', last: '', prev: null, next: null },
};

async function render(
  options: {
    changeSet?: boolean;
    edit?: boolean;
    url?: string;
    permissions?: readonly string[];
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
          path: 'content/:lang/:moduleId',
          component: ModuleEditorPage,
          data: { changeSetParam: 'session' },
        },
      ]),
      provideChangeSetUrl(),
      provideHttpClient(withInterceptors([apiErrorInterceptor])),
      provideHttpClientTesting(),
      provideZard(),
    ],
  });
  TestBed.inject(MeService).set({
    id: 'author',
    kind: 'user',
    name: 'Author',
    role: '',
    permissions: new Set(
      options.permissions ??
        (options.edit === false
          ? ['content.read']
          : ['content.read', 'content.read.draft', 'content.edit']),
    ),
  });
  const { RouterTestingHarness } = await import('@angular/router/testing');
  const harness = await RouterTestingHarness.create();
  const http = TestBed.inject(HttpTestingController);
  const pending = harness.navigateByUrl(options.url ?? '/content/en/charging');
  // The writing aids' reads while editing (#247): no terms, and a server with a style review.
  // Answered while the page settles: their resource keeps it unstable until they are.
  const answerAids = () => {
    for (const r of http.match((r) => r.url === '/api/terms'))
      r.flush({ ...empty, data: [] });
    for (const r of http.match((r) => r.url === '/api/style-review'))
      r.flush({
        data: {
          type: 'StyleReviewStatus',
          id: 'style-review',
          attributes: { configured: true },
        },
      });
  };
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 0));
      let stable = false;
      void harness.fixture.whenStable().then(() => (stable = true));
      while (!stable) {
        answerAids();
        await new Promise((r) => setTimeout(r, 0));
      }
    }
  };
  await settle();
  return {
    harness,
    http,
    settle,
    pending,
    el: () => harness.routeNativeElement as HTMLElement,
  };
}

/** Answers the reads every load makes. */
async function answerReads(
  http: HttpTestingController,
  settle: () => Promise<void>,
  withConfig: object = config,
) {
  http.expectOne('/api/config').flush({ data: { attributes: withConfig } });
  await settle();
  http.expectOne((r) => r.url === '/api/modules/en/charging').flush(moduleDoc);
  http
    .expectOne((r) => r.url === '/api/module-summaries')
    .flush({
      ...empty,
      data: [
        {
          type: 'ModuleSummary',
          id: 'charging',
          attributes: { languages: ['en', 'de'] },
        },
      ],
    });
  await settle();
}

describe('ModuleEditorPage', () => {
  it('has a History tab in the side panel, kept in the address, whose rows open the history page', async () => {
    const { http, settle, el, harness } = await render({ changeSet: false });
    await answerReads(http, settle);
    http.match((r) => r.url === '/api/manuals').forEach((r) => r.flush(empty));
    await settle();
    // Details first; the History tab is a choice in the address.
    const tabs = el().querySelector('[data-slot="side-tabs"]')!;
    expect(tabs.textContent).toContain('Details');
    const history = [...tabs.querySelectorAll('input')].find(
      (i) => i.value === 'history',
    )!;
    history.click();
    await settle();
    expect(TestBed.inject(Router).url).toContain('side=history');
    const commit = 'a'.repeat(40);
    http
      .expectOne((r) => r.url === '/api/modules/en/charging/history')
      .flush({
        data: [
          {
            type: 'ModuleVersion',
            id: `en/charging/${commit}`,
            attributes: {
              commit,
              committedAt: '2026-11-18T10:00:00Z',
              message: 'First',
              merge: false,
              actor: null,
              approvedBy: [],
            },
            relationships: {
              actor: { data: null },
              changeSet: { data: null },
              approvers: { data: [] },
            },
            meta: {
              revision: 1,
              change: 'added',
              releases: [],
              unreadable: false,
            },
          },
        ],
        meta: {
          ...empty.meta,
          page: { ...empty.meta.page, total: 1 },
          truncated: false,
        },
        links: empty.links,
      });
    await settle();
    const row = el().querySelector<HTMLAnchorElement>(
      '[data-slot="history-version"]',
    )!;
    expect(row.textContent).toContain('v1');
    expect(row.getAttribute('href')).toBe(
      `/content/en/charging/history?version=${commit}`,
    );
    expect(
      el().querySelector('[data-slot="history-open"]')?.getAttribute('href'),
    ).toBe('/content/en/charging/history');
    // The details make way for it.
    expect(el().querySelector('of-module-details')).toBeNull();
    harness.fixture.destroy();
  });

  it('in a draft change set, takes the lock and edits the working copy', async () => {
    const { http, settle, el } = await render();
    expect(el().querySelector('z-skeleton')).toBeTruthy();
    await answerReads(http, settle);
    http.expectOne(WC).flush(copyDoc());
    await settle();
    const lock = http.expectOne(`/api/change-sets/${CS}/locks`);
    expect(lock.request.body.data.attributes.subject).toEqual({
      type: 'module',
      lang: 'en',
      moduleId: 'charging',
    });
    lock.flush(
      { data: { type: 'Lock', id: 'l1' } },
      { status: 201, statusText: 'Created' },
    );
    await settle();
    http.expectOne((r) => r.url === '/api/manuals').flush(empty);
    await settle();
    expect(el().querySelector('h1')?.textContent).toContain('Charging');
    expect(el().textContent).toContain('Locked by you');
    expect(el().querySelector('of-save-status')).toBeTruthy();
    expect(
      el()
        .querySelector('.doc-editor-content')
        ?.getAttribute('contenteditable'),
    ).toBe('true');
    // The language switch lists the languages the module exists in.
    const languages = [...el().querySelectorAll('nav a')].map((a) =>
      a.textContent?.trim(),
    );
    expect(languages).toEqual(['EN', 'DE']);
    expect(el().querySelector('of-module-outline')?.textContent).toContain(
      'It charges.',
    );
  });

  it('shows a block not finished yet as a calm draft, not as an error (#793)', async () => {
    const { http, settle, el, harness } = await render();
    await answerReads(http, settle);
    http.expectOne(WC).flush(copyDoc());
    await settle();
    http
      .expectOne(`/api/change-sets/${CS}/locks`)
      .flush({ data: { type: 'Lock', id: 'l1' } });
    await settle();
    http.expectOne((r) => r.url === '/api/manuals').flush(empty);
    await settle();
    const draft = harness.routeDebugElement!.injector.get(ModuleDraft);
    const doc = toEditor(content as never);
    const blockEditor = harness.routeDebugElement!.query(
      By.directive(BlockEditorComponent),
    ).componentInstance as BlockEditorComponent;
    // A new variant block, typed in the editor: no condition chosen yet, so the module can't
    // be saved yet.
    blockEditor.editor!.commands.setContent({
      ...doc,
      content: [
        ...(doc.content ?? []),
        {
          type: 'variant',
          attrs: { id: 'v1', when: null },
          content: [
            {
              type: 'paragraph',
              attrs: { id: 'v1-p' },
              content: [{ type: 'text', text: 'Only some.' }],
            },
          ],
        },
      ],
    } as never);
    await settle();
    await settle();
    expect(draft.state()).toBe('incomplete');
    const status = el().querySelector<HTMLElement>('of-save-status')!;
    expect(status.dataset['status']).toBe('draft');
    expect(status.classList).not.toContain('text-destructive');
    expect(status.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'Draft · finish the block to save',
    );
    // The block and its outline row say so calmly too: no red frame, no red mark (#796).
    const block = el().querySelector<HTMLElement>('[data-issue]')!;
    expect(block.classList).toContain('doc-editor-issue-draft');
    expect(block.classList).not.toContain('doc-editor-issue-error');
    expect(block.dataset['issue']).toBe(
      'Choose the variants this block is for: it is saved once it has them.',
    );
    const outline = el().querySelector<HTMLElement>('of-module-outline')!;
    expect(outline.querySelector('.text-destructive')).toBeNull();
    const row = [...outline.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Choose the variants'),
    )!;
    expect(row.querySelector('[data-problem="draft"]')).not.toBeNull();
    harness.fixture.destroy();
  });

  it('opens read-only, saying why, when someone else holds the lock', async () => {
    const { http, settle, el } = await render();
    await answerReads(http, settle);
    http.expectOne(WC).flush(copyDoc());
    await settle();
    http.expectOne(`/api/change-sets/${CS}/locks`).flush(
      {
        errors: [
          {
            status: '409',
            code: 'locked',
            meta: { holder: { id: 'other' } },
          },
        ],
      },
      { status: 409, statusText: 'Conflict' },
    );
    await settle();
    http.expectOne((r) => r.url === '/api/manuals').flush(empty);
    await settle();
    expect(el().textContent).toContain('other is editing it');
    expect(el().querySelector('of-save-status')).toBeNull();
    expect(
      el()
        .querySelector('.doc-editor-content')
        ?.getAttribute('contenteditable'),
    ).toBe('false');
  });

  it('puts the caret in the block a link names (`?block=`), once', async () => {
    const focus = vi.spyOn(BlockEditorComponent.prototype, 'focusBlock');
    try {
      const { http, settle } = await render({
        changeSet: false,
        url: '/content/en/charging?block=intro',
      });
      await answerReads(http, settle);
      http.expectOne((r) => r.url === '/api/manuals').flush(empty);
      await settle();
      const calls = focus.mock.calls.filter(([id]) => id === 'intro');
      expect(calls.length).toBeGreaterThan(0);
      expect(focus.mock.results.some((r) => r.value === true)).toBe(true);
      const before = focus.mock.calls.length;
      await settle();
      expect(focus.mock.calls.length).toBe(before);
    } finally {
      focus.mockRestore();
    }
  });

  it('opens the image dialog on the block a link names (`?replace=image`), once, editing', async () => {
    const replace = vi
      .spyOn(BlockEditorComponent.prototype, 'replaceImage')
      .mockResolvedValue(false);
    // The editor holds an image there, editable, with the picker.
    const can = vi
      .spyOn(BlockEditorComponent.prototype, 'replaceImageState')
      .mockReturnValue('ready');
    try {
      const { http, settle } = await render({
        url: '/content/en/charging?block=intro&replace=image',
      });
      await answerReads(http, settle);
      http.expectOne(WC).flush(copyDoc());
      await settle();
      http
        .expectOne(`/api/change-sets/${CS}/locks`)
        .flush({ data: { type: 'Lock', id: 'l1' } });
      await settle();
      http.expectOne((r) => r.url === '/api/manuals').flush(empty);
      await settle();
      expect(can).toHaveBeenCalledWith('intro');
      expect(replace.mock.calls).toEqual([['intro']]);
      // The parameter goes: a reload does not open it again.
      expect(TestBed.inject(Router).url).not.toContain('replace=');
      await settle();
      expect(replace).toHaveBeenCalledTimes(1);
    } finally {
      replace.mockRestore();
      can.mockRestore();
    }
  });

  it('says why it can’t replace the image while the module is read-only', async () => {
    const replace = vi.spyOn(BlockEditorComponent.prototype, 'replaceImage');
    try {
      const { http, settle } = await render({
        changeSet: false,
        url: '/content/en/charging?block=intro&replace=image',
      });
      await answerReads(http, settle);
      http.expectOne((r) => r.url === '/api/manuals').flush(empty);
      await settle();
      expect(replace).not.toHaveBeenCalled();
      expect(TestBed.inject(Router).url).not.toContain('replace=');
      expect(
        TestBed.inject(ToastService)
          .toasts()
          .map((t) =>
            typeof t.message === 'string' ? t.message : t.message.key,
          ),
      ).toContain('editor.moduleEditor.replaceReadOnly');
    } finally {
      replace.mockRestore();
    }
  });

  it('says so when the block a replace link names holds no image', async () => {
    const replace = vi.spyOn(BlockEditorComponent.prototype, 'replaceImage');
    try {
      const { http, settle } = await render({
        url: '/content/en/charging?block=intro&replace=image',
      });
      await answerReads(http, settle);
      http.expectOne(WC).flush(copyDoc());
      await settle();
      http
        .expectOne(`/api/change-sets/${CS}/locks`)
        .flush({ data: { type: 'Lock', id: 'l1' } });
      await settle();
      http.expectOne((r) => r.url === '/api/manuals').flush(empty);
      await settle();
      await settle();
      expect(replace).not.toHaveBeenCalled();
      expect(TestBed.inject(Router).url).not.toContain('replace=');
      expect(
        TestBed.inject(ToastService)
          .toasts()
          .map((t) =>
            typeof t.message === 'string' ? t.message : t.message.key,
          ),
      ).toContain('editor.moduleEditor.replaceMissing');
    } finally {
      replace.mockRestore();
    }
  });

  it('marks an image the save refused at its block, and its toast opens the image dialog there by the address', async () => {
    const photo = `sha256:${'a'.repeat(64)}`;
    const withImage = (text: string) => ({
      ...content,
      blocks: [
        {
          type: 'paragraph',
          id: 'intro',
          content: [{ type: 'text', text }],
        },
        { type: 'image', id: 'photo', asset: photo, alt: 'Charging port' },
      ],
    });
    const replace = vi
      .spyOn(BlockEditorComponent.prototype, 'replaceImage')
      .mockResolvedValue(false);
    try {
      const { harness, http, settle: settled, el } = await render();
      // The image is read for the editor: none is stored (and nothing waits on it).
      const settle = async () => {
        for (let i = 0; i < 4; i++) {
          await new Promise((r) => setTimeout(r, 0));
          for (const read of http.match((r) => r.url.includes('/assets/')))
            read.flush(new Blob(), { status: 404, statusText: 'Not Found' });
        }
        await settled();
      };
      await answerReads(http, settle);
      const copy = copyDoc();
      http.expectOne(WC).flush({
        data: {
          ...copy.data,
          attributes: { ...copy.data.attributes, content: withImage('A') },
        },
      });
      await settle();
      http
        .expectOne(`/api/change-sets/${CS}/locks`)
        .flush({ data: { type: 'Lock', id: 'l1' } });
      await settle();
      http.expectOne((r) => r.url === '/api/manuals').flush(empty);
      await settle();
      const draft = harness.routeDebugElement!.injector.get(ModuleDraft);
      draft.edit(toEditor(withImage('B') as never) as never);
      const flushing = draft.flush();
      await new Promise((r) => setTimeout(r, 0));
      http
        .expectOne((r) => r.method === 'PUT' && r.url === WC)
        .flush(
          {
            errors: [
              {
                status: '422',
                code: 'unknown-asset',
                meta: { assets: [photo] },
              },
            ],
          },
          { status: 422, statusText: 'Unprocessable' },
        );
      await settle();
      expect(
        [...el().querySelectorAll('[data-issue]')].map((m) =>
          m.getAttribute('data-issue'),
        ),
      ).toContainEqual(expect.stringContaining('cannot be used here'));
      const shown = TestBed.inject(ToastService).toasts();
      expect(shown.map((t) => t.actionLabel)).toEqual([
        translated('editor.moduleEditor.save.refused.replace'),
      ]);
      shown[0]?.onAction?.();
      await settle();
      expect(replace.mock.calls).toEqual([['photo']]);
      draft.stop();
    } finally {
      replace.mockRestore();
    }
  });

  it('opens the published module read-only without a change set', async () => {
    const { http, settle, el } = await render({ changeSet: false });
    await answerReads(http, settle);
    http.expectNone(WC);
    http.expectOne((r) => r.url === '/api/manuals').flush(empty);
    await settle();
    expect(el().textContent).toContain('choose a draft revision');
    expect(el().querySelector('of-editor-toolbar')).toBeNull();
  });

  it('shows the working copy’s issues at their blocks', async () => {
    const { http, settle, el } = await render();
    await answerReads(http, settle);
    http
      .expectOne(WC)
      .flush(
        copyDoc([{ code: 'passthrough', severity: 'warning', at: 'intro' }]),
      );
    await settle();
    http
      .expectOne(`/api/change-sets/${CS}/locks`)
      .flush({ data: { type: 'Lock', id: 'l1' } });
    await settle();
    http.expectOne((r) => r.url === '/api/manuals').flush(empty);
    await settle();
    const marked = el().querySelector('[data-issue]');
    expect(marked?.getAttribute('data-issue')).toContain('Passthrough');
  });

  it('keeps the module on screen, dimmed and inert, while the next language loads', async () => {
    const { http, settle, el, harness } = await render({ changeSet: false });
    await answerReads(http, settle);
    http.expectOne((r) => r.url === '/api/manuals').flush(empty);
    await settle();
    void harness.navigateByUrl('/content/de/charging');
    await settle();
    const busy = el().querySelector('[aria-busy="true"][inert]');
    expect(busy).toBeTruthy();
    expect(busy?.className).toContain('opacity-60');
    expect(el().querySelector('of-block-editor')).toBeTruthy();
    // No skeleton in the editor's place.
    expect(el().querySelector('.min-h-96[role="status"]')).toBeNull();
    http
      .expectOne((r) => r.url === '/api/modules/de/charging')
      .flush(moduleDoc);
    http.expectOne((r) => r.url === '/api/module-summaries').flush(empty);
    await settle();
    http.expectOne((r) => r.url === '/api/manuals').flush(empty);
    await settle();
    expect(el().querySelector('[aria-busy="true"][inert]')).toBeNull();
  });

  it('puts the chosen change set into the URL, and drops one that is not valid', async () => {
    const { http, settle } = await render({
      url: '/content/en/charging?cs=not-an-id',
    });
    const router = TestBed.inject(Router);
    expect(router.url).toBe(`/content/en/charging?cs=${CS}`);
    await answerReads(http, settle);
    http.expectOne(WC).flush(copyDoc());
    await settle();
    http
      .expectOne(`/api/change-sets/${CS}/locks`)
      .flush({ data: { type: 'Lock', id: 'l1' } });
    await settle();
    http.expectOne((r) => r.url === '/api/manuals').flush(empty);
    await settle();
  });

  it('leaves the default (no change set) out of the URL', async () => {
    const { http, settle } = await render({ changeSet: false });
    expect(TestBed.inject(Router).url).toBe('/content/en/charging');
    await answerReads(http, settle);
    http.expectOne((r) => r.url === '/api/manuals').flush(empty);
    await settle();
  });

  it('opens the live preview beside the document, from the working copy, and keeps it in the URL', async () => {
    const { http, settle, el } = await render();
    await answerReads(http, settle);
    http.expectOne(WC).flush(copyDoc());
    await settle();
    http
      .expectOne(`/api/change-sets/${CS}/locks`)
      .flush({ data: { type: 'Lock', id: 'l1' } });
    await settle();
    http.expectOne((r) => r.url === '/api/manuals').flush(empty);
    await settle();
    expect(el().querySelector('of-live-preview')).toBeNull();
    // What the session sets once the person's list confirms the change set.
    TestBed.inject(ReadRef).ref.set(BRANCH);

    const toggle = [...el().querySelectorAll('header button')].find(
      (b) => b.textContent?.trim() === 'Preview',
    );
    expect(toggle?.getAttribute('aria-pressed')).toBe('false');
    (toggle as HTMLButtonElement).focus();
    (toggle as HTMLButtonElement).click();
    await settle();
    const router = TestBed.inject(Router);
    expect(router.url).toContain('preview=open');
    expect(toggle?.getAttribute('aria-pressed')).toBe('true');
    // Beside the document (a wide screen), growing in the details' place: the details column
    // collapses in the same frames, its content kept; focus stays on the toggle.
    expect(el().querySelector('of-live-preview')).toBeTruthy();
    // Nothing edited and no working copy saved: the heading names no unsaved changes (#694).
    expect(el().querySelector('of-live-preview h2')?.textContent).not.toContain(
      'unsaved',
    );
    const details = el().querySelector('[data-slot="module-details-column"]');
    const aside = details?.querySelector('aside');
    expect(details?.getAttribute('data-state')).toBe('collapsed');
    expect(details?.hasAttribute('inert')).toBe(true);
    expect(aside).toBeTruthy();
    expect(document.activeElement).toBe(toggle);

    // The preview reads the manuals for its variants, then the working copy's page.
    http.expectOne((r) => r.url === '/api/manuals').flush(empty);
    await settle();
    await new Promise((r) => setTimeout(r, 0));
    await settle();
    const page = http.expectOne((r) =>
      r.url.endsWith('/api/modules/en/charging/preview'),
    );
    expect(page.request.params.get('ref')).toBe(BRANCH);
    expect(page.request.params.get('workingCopy')).toBe('true');
    expect(
      http
        .expectOne((r) => r.url.endsWith('/hidden-content'))
        .request.params.get('workingCopy'),
    ).toBe('true');

    // Closed from its own header: out of the URL.
    const close = el().querySelector<HTMLButtonElement>(
      'of-live-preview button[aria-label="Close preview"]',
    );
    close?.click();
    await settle();
    expect(router.url).not.toContain('preview=');
    // The details grow back while the preview shrinks; it is gone once it has.
    expect(details?.getAttribute('data-state')).toBe('open');
    expect(details?.querySelector('aside')).toBe(aside);
    const shrunk = new Event('transitionend');
    Object.defineProperty(shrunk, 'propertyName', { value: 'width' });
    el().querySelector('of-side-panel')?.dispatchEvent(shrunk);
    await settle();
    expect(el().querySelector('of-live-preview')).toBeNull();
  });

  describe('after an update from main (#491)', () => {
    /** The module open in the draft change set, reads following its branch. */
    async function openOnBranch(withConfig: object = config) {
      const rendered = await render();
      const { http, settle } = rendered;
      await answerReads(http, settle, withConfig);
      http.expectOne(WC).flush(copyDoc());
      await settle();
      http
        .expectOne(`/api/change-sets/${CS}/locks`)
        .flush({ data: { type: 'Lock', id: 'l1' } });
      await settle();
      http.expectOne((r) => r.url === '/api/manuals').flush(empty);
      await settle();
      return rendered;
    }

    const at = (text: string) => ({
      ...content,
      blocks: [
        {
          type: 'paragraph',
          id: 'intro',
          content: [{ type: 'text', text }],
        },
      ],
    });

    const copyAt = (text: string, version = 0) => {
      const copy = copyDoc();
      return {
        data: {
          ...copy.data,
          attributes: {
            ...copy.data.attributes,
            content: at(text),
            version,
            baseCommit: 'c1',
          },
        },
      };
    };

    /** Answers the reads of the module loaded again, its working copy saying `text`. */
    async function answerReload(
      http: HttpTestingController,
      settle: () => Promise<void>,
      text: string,
    ) {
      http
        .expectOne((r) => r.url === '/api/modules/en/charging')
        .flush(moduleDoc);
      http.expectOne((r) => r.url === '/api/module-summaries').flush(empty);
      await settle();
      http.expectOne(WC).flush(copyAt(text));
      await settle();
      http
        .expectOne(`/api/change-sets/${CS}/locks`)
        .flush({ data: { type: 'Lock', id: 'l1' } });
      await settle();
      http.expectOne((r) => r.url === '/api/manuals').flush(empty);
      await settle();
    }

    const outline = (el: () => HTMLElement) =>
      el().querySelector('of-module-outline')?.textContent ?? '';

    it('reads the module again at the new head when nothing is unsaved, with no save point', async () => {
      const { http, settle, el, harness } = await openOnBranch();
      expect(outline(el)).toContain('It charges.');
      TestBed.inject(ReadRef).ref.set(BRANCH);
      await settle();
      // Another branch's move is none of its business.
      TestBed.inject(ReadRef).moved('change-sets/other');
      await settle();
      http.expectNone((r) => r.url === '/api/modules/en/charging');

      TestBed.inject(ReadRef).moved(BRANCH);
      await settle();
      await answerReload(http, settle, 'It charges at the new head.');
      expect(outline(el)).toContain('It charges at the new head.');
      expect(el().textContent).toContain('Locked by you');
      // Nothing was committed on the way: reading again is no save point.
      http.expectNone((r) => r.url.endsWith('/commits'));
      expect(TestBed.inject(ToastService).toasts()).toEqual([]);
      harness.fixture.destroy();
    });

    it('keeps unsaved changes over the new head, says so, and offers to read again once they are saved', async () => {
      const { http, settle, el, harness } = await openOnBranch();
      TestBed.inject(ReadRef).ref.set(BRANCH);
      await settle();
      const draft = harness.routeDebugElement!.injector.get(ModuleDraft);
      draft.edit(toEditor(at('Mine, unsaved.') as never) as never);
      await settle();
      expect(draft.dirty()).toBe(true);

      TestBed.inject(ReadRef).moved(BRANCH);
      await settle();
      // Never read over the unsaved text.
      http.expectNone(WC);
      http.expectNone((r) => r.url === '/api/modules/en/charging');
      expect(draft.dirty()).toBe(true);
      const toasts = TestBed.inject(ToastService);
      const said = () => toasts.toasts().map((t) => t.message);
      expect(said()).toEqual([
        translated('editor.moduleEditor.headMoved.unsaved', { ref: 'main' }),
      ]);
      expect(toasts.toasts()[0]?.kind).toBe('warning');
      expect(toasts.toasts()[0]?.actionLabel).toBeUndefined();

      // Saved as ever: then reading again is offered, in its place.
      void draft.flush();
      await new Promise((r) => setTimeout(r, 0));
      http
        .expectOne((r) => r.method === 'PUT' && r.url === WC)
        .flush(copyAt('Mine, unsaved.', 1));
      await settle();
      expect(said()).toEqual([
        translated('editor.moduleEditor.headMoved.saved', { ref: 'main' }),
      ]);
      const offer = toasts.toasts()[0]!;
      expect(offer.actionLabel).toEqual(
        translated('editor.moduleEditor.save.reload'),
      );
      toasts.runAction(offer.id);
      await settle();
      await answerReload(http, settle, 'Mine, unsaved.');
      expect(outline(el)).toContain('Mine, unsaved.');
      expect(said()).toEqual([]);
      http.expectNone((r) => r.url.endsWith('/commits'));
      harness.fixture.destroy();
    });

    it('offers no reload when the draft kept over the new head stops unsaved (the lock lost), and drops its notice', async () => {
      const { http, settle, harness } = await openOnBranch();
      TestBed.inject(ReadRef).ref.set(BRANCH);
      await settle();
      const draft = harness.routeDebugElement!.injector.get(ModuleDraft);
      draft.edit(toEditor(at('Mine, unsaved.') as never) as never);
      TestBed.inject(ReadRef).moved(BRANCH);
      await settle();
      const toasts = TestBed.inject(ToastService);
      expect(toasts.toasts()).toHaveLength(1);
      // What `lockTaken` does: the draft stops, its text kept in this browser, never saved.
      draft.stop();
      await settle();
      expect(toasts.toasts()).toEqual([]);
      http.expectNone(WC);
      harness.fixture.destroy();
    });

    it('leaves a conflict to its own toast', async () => {
      const { http, settle, harness } = await openOnBranch();
      TestBed.inject(ReadRef).ref.set(BRANCH);
      await settle();
      const draft = harness.routeDebugElement!.injector.get(ModuleDraft);
      draft.edit(toEditor(at('Mine, unsaved.') as never) as never);
      TestBed.inject(ReadRef).moved(BRANCH);
      await settle();
      void draft.flush();
      await new Promise((r) => setTimeout(r, 0));
      // The update changed the file: the save is stale.
      http
        .expectOne((r) => r.method === 'PUT' && r.url === WC)
        .flush(
          {
            errors: [
              {
                status: '409',
                code: 'stale-working-copy',
                meta: { head: 'c1' },
              },
            ],
          },
          { status: 409, statusText: 'Conflict' },
        );
      await settle();
      expect(draft.state()).toBe('conflict');
      expect(
        TestBed.inject(ToastService)
          .toasts()
          .map((t) => t.message),
      ).toEqual([translated('editor.moduleEditor.save.conflict')]);
      draft.stop();
      harness.fixture.destroy();
    });

    it('reads the snippets again at the new head', async () => {
      const withSnippets = {
        ...config,
        moduleTypes: [
          ...config.moduleTypes,
          { id: 'snippet', label: 'Snippet', restricted: false, snippet: true },
        ],
      };
      const rendered = await render();
      const { http, harness } = rendered;
      // The snippets are answered as they are read, and counted.
      const reads: string[] = [];
      const settle = async () => {
        for (let i = 0; i < 4; i++) {
          await new Promise((r) => setTimeout(r, 0));
          for (const read of http.match(
            (r) =>
              r.url === '/api/module-summaries' &&
              r.params.get('filter[snippet]') === 'true',
          )) {
            reads.push(read.request.urlWithParams);
            read.flush(empty);
          }
        }
        await rendered.settle();
      };
      await answerReads(http, settle, withSnippets);
      http.expectOne(WC).flush(copyDoc());
      await settle();
      http
        .expectOne(`/api/change-sets/${CS}/locks`)
        .flush({ data: { type: 'Lock', id: 'l1' } });
      await settle();
      http.expectOne((r) => r.url === '/api/manuals').flush(empty);
      await settle();
      TestBed.inject(ReadRef).ref.set(BRANCH);
      await settle();
      const before = reads.length;
      expect(before).toBeGreaterThan(0);
      const draft = harness.routeDebugElement!.injector.get(ModuleDraft);
      // Unsaved changes: the module stays, the snippets are read again all the same.
      draft.edit(toEditor(at('Mine, unsaved.') as never) as never);
      TestBed.inject(ReadRef).moved(BRANCH);
      await settle();
      expect(reads.length).toBe(before + 1);
      http.expectNone(WC);
      draft.stop(true);
      harness.fixture.destroy();
    });
  });

  /** Opens the module in the draft change set, with French configured too. */
  async function openEditable(
    options: { edit?: boolean; permissions?: readonly string[] } = {},
  ) {
    const rendered = await render(options);
    const { http, settle } = rendered;
    await answerReads(http, settle, {
      ...config,
      languages: { source: 'en', targets: ['de', 'fr'] },
    });
    if (options.edit !== false) {
      http.expectOne(WC).flush(copyDoc());
      await settle();
      http
        .expectOne(`/api/change-sets/${CS}/locks`)
        .flush({ data: { type: 'Lock', id: 'l1' } });
      await settle();
    }
    http.expectOne((r) => r.url === '/api/manuals').flush(empty);
    await settle();
    return rendered;
  }

  it('offers Translate for a language it is not in, and opens that version with the source beside it', async () => {
    const { http, settle, el } = await openEditable();
    const card = el().querySelector('of-module-details') as HTMLElement;
    expect(card.textContent).toContain('Not translated');
    expect(card.querySelector('[data-translate="de"]')).toBeNull();
    const translate = card.querySelector<HTMLButtonElement>(
      '[data-translate="fr"]',
    );
    expect(translate?.getAttribute('aria-label')).toBe('Translate into French');
    translate?.click();
    await settle();
    http
      .expectOne(`/api/change-sets/${CS}/modules/fr/charging/working-copy`)
      .flush(
        { errors: [{ status: '404', code: 'not-found' }] },
        { status: 404, statusText: 'Not Found' },
      );
    http.expectOne(WC).flush(copyDoc());
    http
      .expectOne(`/api/change-sets/${CS}`)
      .flush({ data: { attributes: { baseCommit: 'base1' } } });
    await settle();
    http
      .expectOne(`/api/change-sets/${CS}/locks`)
      .flush({ data: { type: 'Lock', id: 'l2' } });
    await settle();
    const put = http.expectOne(
      (r) =>
        r.method === 'PUT' &&
        r.url === `/api/change-sets/${CS}/modules/fr/charging/working-copy`,
    );
    // The same blocks, with their IDs, in the new language.
    expect(put.request.body.data.attributes.content).toEqual({
      ...content,
      meta: { ...content.meta, lang: 'fr' },
    });
    put.flush({ data: {} });
    await settle();
    const url = TestBed.inject(Router).url;
    expect(url).toContain('/content/fr/charging?');
    expect(url).toContain('preview=source');
    expect(url).toContain(`cs=${CS}`);
  });

  it('shows the source beside a translation as a panel of its own (`?preview=source`)', async () => {
    const { http, settle, el } = await render({
      changeSet: false,
      url: '/content/de/charging?preview=source',
    });
    http.expectOne('/api/config').flush({ data: { attributes: config } });
    await settle();
    http
      .expectOne((r) => r.url === '/api/modules/de/charging')
      .flush(moduleDoc);
    http
      .expectOne((r) => r.url === '/api/module-summaries')
      .flush({
        ...empty,
        data: [
          {
            type: 'ModuleSummary',
            id: 'charging',
            attributes: { languages: ['en', 'de'] },
          },
        ],
      });
    await settle();
    // The page's "Used in" and the panel's variants both read the manuals.
    for (let i = 0; i < 2; i++) {
      for (const r of http.match((r) => r.url === '/api/manuals')) {
        r.flush(empty);
      }
      await settle();
    }
    const toggle = el().querySelector('[data-slot="source-toggle"]');
    expect(toggle?.getAttribute('aria-pressed')).toBe('true');
    const panel = el().querySelector('of-live-preview');
    expect(panel?.textContent).toContain('Source · English');
    await new Promise((r) => setTimeout(r, 0));
    await settle();
    // The source language is what the panel renders, never the translation.
    expect(
      http.match((r) => r.url.endsWith('/api/modules/en/charging/preview'))
        .length,
    ).toBe(1);
    expect(
      http.match((r) => r.url.endsWith('/api/modules/de/charging/preview')),
    ).toEqual([]);
  });

  it('has Delete in the header menu, which asks first and shows where the module is used', async () => {
    const { settle, el } = await openEditable();
    el()
      .querySelector<HTMLButtonElement>('[data-slot="module-actions"]')
      ?.click();
    await settle();
    const item = document.querySelector<HTMLElement>(
      '[data-slot="module-delete"]',
    );
    expect(item?.getAttribute('aria-disabled')).not.toBe('true');
    item?.click();
    await settle();
    const dialog = document.querySelector('z-dialog-panel');
    expect(dialog?.textContent).toContain('Delete “Charging”?');
    expect(dialog?.textContent).toContain('Only the English version');
    expect(dialog?.textContent).toContain('Checking where it is used');
  });

  it('deprecates the module from the header menu, shown at once and undone by the toast (#266)', async () => {
    const { http, settle, el } = await openEditable();
    el()
      .querySelector<HTMLButtonElement>('[data-slot="module-actions"]')
      ?.click();
    await settle();
    document
      .querySelector<HTMLElement>('[data-slot="module-deprecate"]')
      ?.click();
    await settle();
    http
      .expectOne(
        (r) =>
          r.url === '/api/module-summaries' &&
          r.params.get('filter[deprecated]') === 'false',
      )
      .flush(empty);
    await settle();
    const dialog = document.querySelector('z-dialog-panel') as HTMLElement;
    expect(dialog.textContent).toContain('Deprecate “Charging”');
    const reason = dialog.querySelector<HTMLInputElement>('#deprecate-reason');
    if (reason) {
      reason.value = 'Superseded.';
      reason.dispatchEvent(new Event('input'));
    }
    await settle();
    dialog
      .querySelector<HTMLButtonElement>('[data-slot="deprecate-confirm"]')
      ?.click();
    await settle();
    expect(el().querySelector('[data-slot="module-deprecated"]')).toBeTruthy();
    expect(
      el().querySelector('[data-slot="module-deprecation"]')?.textContent,
    ).toContain('Superseded.');
    const toasts = TestBed.inject(ToastService);
    const shown = toasts.toasts().find((t) => t.actionLabel);
    expect(shown).toBeTruthy();
    toasts.runAction(shown?.id ?? 0);
    await settle();
    expect(el().querySelector('[data-slot="module-deprecated"]')).toBeNull();
  });

  it('has "Show in audit log" in the header menu for an admin, with the module preset', async () => {
    const { settle, el } = await openEditable({
      permissions: [
        'content.read',
        'content.read.draft',
        'content.edit',
        'admin.roles',
      ],
    });
    const navigate = vi
      .spyOn(TestBed.inject(Router), 'navigate')
      .mockResolvedValue(true);
    el()
      .querySelector<HTMLButtonElement>('[data-slot="module-actions"]')
      ?.click();
    await settle();
    expect(
      document.querySelector('[data-slot="module-delete"]'),
    ).not.toBeNull();
    document.querySelector<HTMLElement>('[data-slot="module-audit"]')?.click();
    expect(navigate).toHaveBeenCalledWith(['/admin', 'audit'], {
      queryParams: { type: 'module', id: 'en/charging' },
    });
  });

  it('gives an admin without content.edit the menu with the audit log only', async () => {
    const { settle, el } = await openEditable({
      edit: false,
      permissions: ['content.read', 'admin.roles'],
    });
    el()
      .querySelector<HTMLButtonElement>('[data-slot="module-actions"]')
      ?.click();
    await settle();
    expect(document.querySelector('[data-slot="module-audit"]')).not.toBeNull();
    expect(document.querySelector('[data-slot="module-delete"]')).toBeNull();
  });

  it('offers neither Delete nor Translate to a role without content.edit', async () => {
    const { el } = await openEditable({ edit: false });
    expect(el().querySelector('[data-slot="module-actions"]')).toBeNull();
    expect(el().querySelector('of-module-details')?.textContent).toContain(
      'Not translated',
    );
    // The guard hides it: no way to start a version.
    expect(
      el().querySelector('[data-translate="fr"]')?.hasAttribute('hidden'),
    ).toBe(true);
    // On the source language itself there is no "Source" to show.
    expect(el().querySelector('[data-slot="source-toggle"]')).toBeNull();
  });
});

describe('ModuleEditorPage for a contributor (#137)', () => {
  /** A change set as the API answers it, `state` in its life. */
  const changeSetDoc = (
    state = 'draft',
    description: string | null = null,
  ) => ({
    data: {
      type: 'ChangeSet',
      id: CS,
      attributes: {
        title: 'Charging',
        description,
        state,
        author: { kind: 'user', id: 'author' },
        baseRef: 'main',
        baseCommit: 'c0',
        branch: BRANCH,
        reviewHead: null,
        mergeCommit: null,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    },
  });

  /** A contributor on the published module, then "Suggest a change": the focused editor. */
  async function suggesting(lockAnswer: 'taken' | 'locked' = 'taken') {
    const page = await render({
      changeSet: false,
      permissions: ['content.read', 'content.edit'],
    });
    const { http, settle, el } = page;
    http.expectOne('/api/config').flush({ data: { attributes: config } });
    await settle();
    // Their suggestion is the change set of theirs holding the module's lock: none yet.
    const locks = http.expectOne((r) => r.url === '/api/locks');
    expect(locks.request.params.get('filter[subject]')).toBe(
      'module/en/charging',
    );
    locks.flush(empty);
    await settle();
    http
      .expectOne((r) => r.url === '/api/modules/en/charging')
      .flush(moduleDoc);
    http.expectOne((r) => r.url === '/api/module-summaries').flush(empty);
    await settle();
    http.expectOne((r) => r.url === '/api/manuals').flush(empty);
    await settle();
    expect(el().textContent).toContain('suggest a change to edit it');
    expect(el().querySelector('of-editor-toolbar')).toBeNull();
    // Their only way in: no actions menu, no Translate.
    expect(el().querySelector('[data-slot="module-actions"]')).toBeNull();
    expect(el().querySelector('[data-translate]')).toBeNull();

    el()
      .querySelector<HTMLButtonElement>('[data-slot="suggest-change"]')!
      .click();
    await settle();
    const started = http.expectOne(
      (r) => r.url === '/api/change-sets' && r.method === 'POST',
    );
    // Named after the module.
    expect(started.request.body.data.attributes.title).toBe('Charging');
    // While it is being started, the published module stays as it is (no "in review" flash).
    http.expectNone((r) => r.url === '/api/modules/en/charging');
    expect(el().textContent).toContain('suggest a change to edit it');
    started.flush(changeSetDoc(), { status: 201, statusText: 'Created' });
    await settle();
    http
      .expectOne((r) => r.url === '/api/modules/en/charging')
      .flush(moduleDoc);
    http.expectOne((r) => r.url === '/api/module-summaries').flush(empty);
    await settle();
    http.expectOne(WC).flush(copyDoc());
    await settle();
    const lock = http.expectOne(`/api/change-sets/${CS}/locks`);
    if (lockAnswer === 'locked') {
      lock.flush(
        {
          errors: [
            {
              status: '409',
              code: 'locked',
              title: 'Locked',
              detail: 'Locked.',
            },
          ],
        },
        { status: 409, statusText: 'Conflict' },
      );
      await settle();
      return page;
    }
    lock.flush(
      { data: { type: 'Lock', id: 'l1' } },
      { status: 201, statusText: 'Created' },
    );
    await settle();
    http.expectOne((r) => r.url === '/api/manuals').flush(empty);
    await settle();
    return page;
  }

  it('suggests a change in the focused editor: text, lists, links, images and attachments only', async () => {
    const { el, http } = await suggesting();
    expect(
      el()
        .querySelector('.doc-editor-content')
        ?.getAttribute('contenteditable'),
    ).toBe('true');
    const toolbar = el().querySelector('of-editor-toolbar')!;
    // No text styles (headings): text and the lists stay.
    expect(toolbar.querySelector('[aria-label="Text style"]')).toBeNull();
    expect(toolbar.querySelector('[aria-label="Bulleted list"]')).toBeTruthy();
    expect(toolbar.querySelector('[aria-label="Numbered list"]')).toBeTruthy();
    // The Insert menu: images and attachments, nothing else.
    toolbar
      .querySelector<HTMLButtonElement>('[data-testid="insert-menu"]')!
      .click();
    await new Promise((r) => setTimeout(r, 0));
    const offered = [...document.querySelectorAll('[data-insert]')].map((o) =>
      o.getAttribute('data-insert'),
    );
    expect(offered).toEqual(['image', 'attachment']);
    // The metadata is not theirs to change here, and there is the suggestion's note.
    expect(el().querySelector('[data-slot="suggestion-panel"]')).toBeTruthy();
    expect(el().textContent).toContain('What did you change?');
    http.verify();
  });

  it('never gives up a suggestion that took its lock: another module locked elsewhere leaves it alone', async () => {
    // An editor (who reads drafts): "Suggest a change" on the published module.
    const { http, settle, el, harness } = await render({ changeSet: false });
    await answerReads(http, settle);
    http.expectOne((r) => r.url === '/api/manuals').flush(empty);
    await settle();
    el()
      .querySelector<HTMLButtonElement>('[data-slot="suggest-change"]')!
      .click();
    await settle();
    http
      .expectOne((r) => r.url === '/api/change-sets' && r.method === 'POST')
      .flush(changeSetDoc(), { status: 201, statusText: 'Created' });
    await settle();
    http
      .expectOne((r) => r.url === '/api/modules/en/charging')
      .flush(moduleDoc);
    http.expectOne((r) => r.url === '/api/module-summaries').flush(empty);
    await settle();
    http.expectOne(WC).flush(copyDoc());
    await settle();
    http
      .expectOne(`/api/change-sets/${CS}/locks`)
      .flush(
        { data: { type: 'Lock', id: 'l1' } },
        { status: 201, statusText: 'Created' },
      );
    await settle();
    http.match((r) => r.url === '/api/manuals').forEach((r) => r.flush(empty));
    await settle();
    // Another version of it, which someone else is editing.
    void harness.navigateByUrl(`/content/de/charging?cs=${CS}`);
    await settle();
    http
      .match((r) => r.url === '/api/modules/de/charging')
      .forEach((r) => r.flush(moduleDoc));
    http
      .match((r) => r.url === '/api/module-summaries')
      .forEach((r) => r.flush(empty));
    await settle();
    http
      .expectOne(`/api/change-sets/${CS}/modules/de/charging/working-copy`)
      .flush(copyDoc());
    await settle();
    http.expectOne(`/api/change-sets/${CS}/locks`).flush(
      {
        errors: [
          { status: '409', code: 'locked', title: 'Locked', detail: 'Locked.' },
        ],
      },
      { status: 409, statusText: 'Conflict' },
    );
    await settle();
    http.match((r) => r.url === '/api/manuals').forEach((r) => r.flush(empty));
    await settle();
    http.expectNone(`/api/change-sets/${CS}/abandon`);
    expect(TestBed.inject(ChangeSetSession).selected()?.id).toBe(CS);
    expect(el().textContent).toContain('Read-only');
  });

  it('never gives up an editor’s suggestion left mid-load: work elsewhere in it stays when its module is locked later', async () => {
    const { http, settle, el, harness } = await render({ changeSet: false });
    await answerReads(http, settle);
    http.expectOne((r) => r.url === '/api/manuals').flush(empty);
    await settle();
    el()
      .querySelector<HTMLButtonElement>('[data-slot="suggest-change"]')!
      .click();
    await settle();
    http
      .expectOne((r) => r.url === '/api/change-sets' && r.method === 'POST')
      .flush(changeSetDoc(), { status: 201, statusText: 'Created' });
    await settle();
    // Gone to the German version before the English one took its lock.
    void harness.navigateByUrl(`/content/de/charging?cs=${CS}`);
    await settle();
    const answerModule = () => {
      http
        .match((r) => /\/api\/modules\/(en|de)\/charging$/.test(r.url))
        .forEach((r) => r.flush(moduleDoc));
      http
        .match((r) => r.url === '/api/module-summaries')
        .forEach((r) => r.flush(empty));
    };
    answerModule();
    await settle();
    http.match((r) => r.url === WC).forEach((r) => r.flush(copyDoc()));
    await settle();
    http
      .expectOne(`/api/change-sets/${CS}/modules/de/charging/working-copy`)
      .flush(copyDoc());
    await settle();
    http
      .expectOne(`/api/change-sets/${CS}/locks`)
      .flush(
        { data: { type: 'Lock', id: 'l2' } },
        { status: 201, statusText: 'Created' },
      );
    await settle();
    http.match((r) => r.url === '/api/manuals').forEach((r) => r.flush(empty));
    await settle();
    // Back to the English one, which someone else now edits.
    void harness.navigateByUrl(`/content/en/charging?cs=${CS}`);
    await settle();
    answerModule();
    await settle();
    http.expectOne(WC).flush(copyDoc());
    await settle();
    http.expectOne(`/api/change-sets/${CS}/locks`).flush(
      {
        errors: [
          { status: '409', code: 'locked', title: 'Locked', detail: 'Locked.' },
        ],
      },
      { status: 409, statusText: 'Conflict' },
    );
    await settle();
    http.match((r) => r.url === '/api/manuals').forEach((r) => r.flush(empty));
    await settle();
    http.expectNone(`/api/change-sets/${CS}/abandon`);
    expect(TestBed.inject(ChangeSetSession).selected()?.id).toBe(CS);
  });

  it('gives up a suggestion whose module someone else is editing: abandoned, back to the published module', async () => {
    const { el, http, settle } = await suggesting('locked');
    http
      .expectOne(`/api/change-sets/${CS}/abandon`)
      .flush({ data: changeSetDoc('abandoned').data });
    await settle();
    http
      .match((r) => r.url === '/api/change-sets' && r.method === 'GET')
      .forEach((r) => r.flush(empty));
    await settle();
    http
      .match((r) => r.url === '/api/modules/en/charging')
      .forEach((r) => r.flush(moduleDoc));
    http
      .match((r) => r.url === '/api/module-summaries')
      .forEach((r) => r.flush(empty));
    await settle();
    http.match((r) => r.url === '/api/locks').forEach((r) => r.flush(empty));
    await settle();
    http
      .match((r) => r.url === '/api/modules/en/charging')
      .forEach((r) => r.flush(moduleDoc));
    http
      .match((r) => r.url === '/api/module-summaries')
      .forEach((r) => r.flush(empty));
    await settle();
    http.match((r) => r.url === '/api/manuals').forEach((r) => r.flush(empty));
    await settle();
    expect(
      TestBed.inject(ToastService)
        .toasts()
        .filter((t) => t.kind === 'error')
        .map((t) => t.message),
    ).toContainEqual(
      translated('editor.suggestion.lockedElsewhere', { title: 'Charging' }),
    );
    expect(TestBed.inject(ChangeSetSession).selected()).toBeNull();
    expect(el().querySelector('[data-slot="suggest-change"]')).toBeTruthy();
  });

  it('opens a module in the suggestion of theirs holding its lock, ready to edit', async () => {
    const page = await render({
      changeSet: false,
      permissions: ['content.read', 'content.edit'],
    });
    const { http, settle, el } = page;
    http.expectOne('/api/config').flush({ data: { attributes: config } });
    await settle();
    const held = {
      ...empty,
      data: [
        {
          type: 'Lock',
          id: 'l1',
          attributes: {
            subject: { type: 'module', lang: 'en', moduleId: 'charging' },
            holder: { kind: 'user', id: 'author' },
            since: '2026-01-01T00:00:00Z',
          },
          relationships: {
            changeSet: { data: { type: 'ChangeSet', id: CS } },
          },
        },
      ],
      meta: { page: { currentPage: 1, lastPage: 1, perPage: 1, total: 1 } },
    };
    http.expectOne((r) => r.url === '/api/locks').flush(held);
    await settle();
    // Not listed yet: the list is read, then it is chosen.
    http
      .match((r) => r.url === '/api/change-sets' && r.method === 'GET')
      .forEach((r) =>
        r.flush({
          ...empty,
          data: [changeSetDoc('draft', 'Shorter steps.').data],
        }),
      );
    await settle();
    expect(TestBed.inject(ChangeSetSession).selected()?.id).toBe(CS);
    http
      .match((r) => r.url === '/api/modules/en/charging')
      .forEach((r) => r.flush(moduleDoc));
    http
      .match((r) => r.url === '/api/module-summaries')
      .forEach((r) => r.flush(empty));
    await settle();
    // Loaded again in it: the lock is looked up again, and it is this one.
    http.expectOne((r) => r.url === '/api/locks').flush(held);
    await settle();
    http
      .match((r) => r.url === '/api/modules/en/charging')
      .forEach((r) => r.flush(moduleDoc));
    http
      .match((r) => r.url === '/api/module-summaries')
      .forEach((r) => r.flush(empty));
    await settle();
    http.expectOne(WC).flush(copyDoc());
    await settle();
    http
      .expectOne(`/api/change-sets/${CS}/locks`)
      .flush({ data: { type: 'Lock', id: 'l1' } });
    await settle();
    http.match((r) => r.url === '/api/manuals').forEach((r) => r.flush(empty));
    await settle();
    expect(
      el()
        .querySelector('.doc-editor-content')
        ?.getAttribute('contenteditable'),
    ).toBe('true');
    // The note, as kept, and no way to change the metadata.
    expect(
      el().querySelector<HTMLTextAreaElement>(
        'textarea[name="suggestion-note"]',
      )?.value,
    ).toBe('Shorter steps.');
    expect(el().querySelector('[data-slot="module-actions"]')).toBeNull();
    expect(el().querySelector('[data-translate]')).toBeNull();
  });

  it('needs a note, then makes a save point and submits it as the comment, in one step', async () => {
    const { el, http, settle } = await suggesting();
    const submit = () =>
      el()
        .querySelector<HTMLButtonElement>('[data-slot="suggestion-submit"]')!
        .click();
    submit();
    await settle();
    expect(el().querySelector('[role="alert"]')?.textContent).toContain(
      'Say what you changed',
    );
    const note = el().querySelector<HTMLTextAreaElement>(
      'textarea[name="suggestion-note"]',
    )!;
    expect(note.getAttribute('aria-invalid')).toBe('true');
    http.expectNone((r) => r.url.endsWith('/submit'));

    note.value = 'Corrected the charging time.';
    note.dispatchEvent(new Event('input'));
    await settle();
    expect(el().querySelector('[role="alert"]')).toBeNull();
    submit();
    await settle();
    // Kept as the change set's description, and sent as the submit's comment.
    const kept = http.expectOne(
      (r) => r.url === `/api/change-sets/${CS}` && r.method === 'PATCH',
    );
    expect(kept.request.body.data.attributes.description).toBe(
      'Corrected the charging time.',
    );
    kept.flush(changeSetDoc('draft', 'Corrected the charging time.'));
    const submitted = http.expectOne(`/api/change-sets/${CS}/submit`);
    expect(submitted.request.body).toEqual({
      meta: { comment: 'Corrected the charging time.' },
    });
    submitted.flush(changeSetDoc('in-review', 'Corrected the charging time.'));
    await settle();
    // Read again: in review, so the module opens read-only, saying so.
    http
      .expectOne((r) => r.url === '/api/change-sets' && r.method === 'GET')
      .flush({
        ...empty,
        data: [changeSetDoc('in-review', 'Corrected the charging time.').data],
      });
    await settle();
    // Its lock stays until it is merged: still their suggestion of this module.
    http
      .expectOne((r) => r.url === '/api/locks')
      .flush({
        ...empty,
        data: [
          {
            type: 'Lock',
            id: 'l1',
            attributes: {
              subject: { type: 'module', lang: 'en', moduleId: 'charging' },
              holder: { kind: 'user', id: 'author' },
              since: '2026-01-01T00:00:00Z',
            },
            relationships: {
              changeSet: { data: { type: 'ChangeSet', id: CS } },
            },
          },
        ],
      });
    await settle();
    http
      .expectOne((r) => r.url === '/api/modules/en/charging')
      .flush(moduleDoc);
    http.expectOne((r) => r.url === '/api/module-summaries').flush(empty);
    await settle();
    http.expectOne((r) => r.url === '/api/manuals').flush(empty);
    await settle();
    expect(el().textContent).toContain('your suggestion is in review');
    expect(
      TestBed.inject(ToastService)
        .toasts()
        .filter((t) => t.kind === 'success')
        .map((t) => t.message),
    ).toContainEqual(
      translated('editor.suggestion.submitted', { title: 'Charging' }),
    );
  });
  describe('locked by someone else (screen 12)', () => {
    const LOCK = '0190a1b2-c3d4-7e5f-8a9b-000000000001';
    const OTHER_CS = '0190a1b2-c3d4-7e5f-8a9b-000000000002';
    const lockedAnswer = [
      {
        errors: [
          {
            status: '409',
            code: 'locked',
            title: 'Locked',
            detail: 'Locked.',
            meta: {
              lockId: LOCK,
              holder: { kind: 'user', id: 'other' },
              changeSetId: OTHER_CS,
              since: '2026-11-19T09:12:00Z',
            },
          },
        ],
      },
      { status: 409, statusText: 'Conflict' },
    ] as const;
    const dialog = () =>
      document.querySelector<HTMLElement>('z-dialog-panel, [role="dialog"]');
    const slot = (name: string) =>
      document.querySelector<HTMLElement>(`[data-slot="${name}"]`);

    /** The refusal of a lock with `meta` and `extra` merged into it. */
    const lockedWith = (extra: Record<string, unknown>) =>
      [
        {
          errors: [
            {
              ...lockedAnswer[0].errors[0],
              meta: { ...lockedAnswer[0].errors[0].meta, ...extra },
            },
          ],
        },
        lockedAnswer[1],
      ] as const;
    /** The reader's own lock, in their change set "Elsewhere" (#472). */
    const ownAnswer = (hasChanges: boolean) =>
      lockedWith({
        holder: { kind: 'user', id: 'author' },
        changeSetTitle: 'Elsewhere',
        changeSetState: 'draft',
        hasChanges,
      });

    async function openLocked(
      permissions?: readonly string[],
      answer: readonly [object, object] = lockedAnswer,
    ) {
      const rendered = await render(permissions ? { permissions } : {});
      const { http, settle } = rendered;
      await answerReads(http, settle);
      http.expectOne(WC).flush(copyDoc());
      await settle();
      http
        .expectOne(`/api/change-sets/${CS}/locks`)
        .flush(...(answer as typeof lockedAnswer));
      await settle();
      http.expectOne((r) => r.url === '/api/manuals').flush(empty);
      await settle();
      return rendered;
    }

    it('says who holds it and since when, read-only; "Open read-only" is kept in the address', async () => {
      const { el, settle, harness } = await openLocked();
      expect(dialog()?.textContent).toContain(
        'Someone else is editing this module',
      );
      expect(slot('lock-holder')?.textContent).toContain('other');
      expect(slot('lock-holder')?.textContent).toContain('Editing since');
      // Taking over is for `admin.roles` only: hidden for everyone else.
      expect(slot('lock-take-over')?.hidden).toBe(true);
      expect(slot('lock-take-over-header')?.hidden).toBe(true);
      expect(
        el()
          .querySelector('.doc-editor-content')
          ?.getAttribute('contenteditable'),
      ).toBe('false');
      slot('lock-read-only')!.click();
      await settle();
      expect(TestBed.inject(Router).url).toContain('lock=read');
      expect(el().textContent).toContain('other is editing it');
      harness.fixture.destroy();
    });

    it('lets an admin take over with a comment: the lock is broken, then taken for this change set', async () => {
      const { http, settle, el, harness } = await openLocked([
        'content.read',
        'content.read.draft',
        'content.edit',
        'admin.roles',
      ]);
      expect(slot('lock-take-over')?.hidden).toBe(false);
      slot('lock-take-over')!.click();
      await settle();
      expect(TestBed.inject(Router).url).toContain('lock=takeOver');
      // Why is required.
      slot('lock-take-over-confirm')!.click();
      await settle();
      expect(dialog()?.textContent).toContain('Say why you are taking over.');
      http.expectNone((r) => r.url.endsWith('/break'));
      const comment = document.querySelector<HTMLTextAreaElement>(
        '#lock-take-over-comment',
      )!;
      comment.value = '  On leave until Monday.  ';
      comment.dispatchEvent(new Event('input'));
      await settle();
      slot('lock-take-over-confirm')!.click();
      await settle();
      const broken = http.expectOne(`/api/locks/${LOCK}/break`);
      expect(broken.request.method).toBe('POST');
      expect(broken.request.body).toEqual({
        meta: { comment: 'On leave until Monday.' },
      });
      broken.flush(null, { status: 204, statusText: 'No Content' });
      await settle();
      // Taken at once, before the holder's editor could take it back.
      http
        .expectOne(`/api/change-sets/${CS}/locks`)
        .flush(
          { data: { type: 'Lock', id: 'l2' } },
          { status: 201, statusText: 'Created' },
        );
      await settle();
      // Opened again, finding the lock held by this change set.
      http
        .expectOne((r) => r.url === '/api/modules/en/charging')
        .flush(moduleDoc);
      http.expectOne((r) => r.url === '/api/module-summaries').flush(empty);
      await settle();
      http.expectOne(WC).flush(copyDoc());
      await settle();
      http
        .expectOne(`/api/change-sets/${CS}/locks`)
        .flush(
          { data: { type: 'Lock', id: 'l2' } },
          { status: 201, statusText: 'Created' },
        );
      await settle();
      http
        .match((r) => r.url === '/api/manuals')
        .forEach((r) => r.flush(empty));
      await settle();
      expect(el().textContent).toContain('Locked by you');
      expect(
        el()
          .querySelector('.doc-editor-content')
          ?.getAttribute('contenteditable'),
      ).toBe('true');
      expect(TestBed.inject(Router).url).not.toContain('lock=');
      expect(
        TestBed.inject(ToastService)
          .toasts()
          .map((t) => t.message),
      ).toContainEqual(
        translated('editor.moduleLock.takeOver.done', { holder: 'other' }),
      );
      harness.fixture.destroy();
    });

    it('says why a take-over failed, in the dialog', async () => {
      const { http, settle, harness } = await openLocked([
        'content.read',
        'content.read.draft',
        'content.edit',
        'admin.roles',
      ]);
      slot('lock-take-over')!.click();
      await settle();
      const comment = document.querySelector<HTMLTextAreaElement>(
        '#lock-take-over-comment',
      )!;
      comment.value = 'Urgent fix.';
      comment.dispatchEvent(new Event('input'));
      slot('lock-take-over-confirm')!.click();
      await settle();
      http.expectOne(`/api/locks/${LOCK}/break`).flush(
        {
          errors: [
            { status: '403', code: 'forbidden', title: 'No', detail: 'No.' },
          ],
        },
        { status: 403, statusText: 'Forbidden' },
      );
      await settle();
      expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain(
        'could not be taken over',
      );
      expect(TestBed.inject(Router).url).toContain('lock=takeOver');
      harness.fixture.destroy();
    });

    it('names the revision holding it, and says since when once it has been held over a day (#472)', async () => {
      const { harness } = await openLocked(
        undefined,
        lockedWith({
          changeSetTitle: 'Shorter steps',
          since: '2026-01-02T09:12:00Z',
        }),
      );
      expect(dialog()?.textContent).toContain(
        'Someone else is editing this module',
      );
      expect(slot('lock-holder-change-set')?.textContent).toContain(
        'In the revision “Shorter steps”',
      );
      expect(dialog()?.textContent).toContain(
        'They have been editing it since',
      );
      expect(dialog()?.textContent).not.toContain('once they');
      harness.fixture.destroy();
    });

    it('says when the lock is the reader’s own, in another revision, and keeps their changes there (#472)', async () => {
      const { el, harness } = await openLocked(undefined, ownAnswer(true));
      expect(dialog()?.textContent).toContain(
        "You're editing this module in another revision",
      );
      expect(slot('lock-change-set')?.textContent).toContain('Elsewhere');
      expect(slot('lock-change-set')?.textContent).toContain('Draft');
      expect(dialog()?.textContent).toContain(
        'Your changes to it are kept there.',
      );
      expect(slot('lock-open-there')).not.toBeNull();
      // Changes there: it is not released from here.
      expect(slot('lock-release-there')).toBeNull();
      expect(el().textContent).toContain(
        'you are editing it in another revision',
      );
      harness.fixture.destroy();
    });

    it('releases the reader’s own lock there when nothing changed there, takes it here, and Undo gives it back (#472)', async () => {
      const { http, settle, el, harness } = await openLocked(
        undefined,
        ownAnswer(false),
      );
      expect(dialog()?.textContent).toContain(
        'Nothing of it has changed there yet.',
      );
      slot('lock-release-there')!.click();
      await settle();
      const released = http.expectOne(
        (r) => r.url === `/api/locks/${LOCK}` && r.method === 'DELETE',
      );
      expect(released.request.params.get('ifUnchanged')).toBe('true');
      released.flush(null, { status: 204, statusText: 'No Content' });
      await settle();
      // Taken here at once, then opened again, editable.
      http
        .expectOne(`/api/change-sets/${CS}/locks`)
        .flush(
          { data: { type: 'Lock', id: 'l2' } },
          { status: 201, statusText: 'Created' },
        );
      await settle();
      http
        .expectOne((r) => r.url === '/api/modules/en/charging')
        .flush(moduleDoc);
      http.expectOne((r) => r.url === '/api/module-summaries').flush(empty);
      await settle();
      http.expectOne(WC).flush(copyDoc());
      await settle();
      http
        .expectOne(`/api/change-sets/${CS}/locks`)
        .flush({ data: { type: 'Lock', id: 'l2' } });
      await settle();
      http
        .match((r) => r.url === '/api/manuals')
        .forEach((r) => r.flush(empty));
      await settle();
      expect(el().textContent).toContain('Locked by you');
      const toasts = TestBed.inject(ToastService);
      const toast = toasts
        .toasts()
        .find((t) => JSON.stringify(t.message).includes('own.released'));
      expect(JSON.stringify(toast?.message)).toContain('Elsewhere');
      expect(toast).toBeDefined();

      // Undo: released here (only if unchanged here), taken there again, read-only here.
      toasts.runAction(toast!.id);
      await settle();
      http
        .expectOne(
          (r) =>
            r.url === '/api/locks' &&
            r.params.get('filter[changeSet]') === CS &&
            r.params.get('filter[subject]') === 'module/en/charging',
        )
        .flush({
          ...empty,
          data: [
            {
              type: 'Lock',
              id: 'l2',
              attributes: {
                subject: { type: 'module', lang: 'en', moduleId: 'charging' },
                holder: { kind: 'user', id: 'author' },
                since: '2026-11-19T10:00:00Z',
              },
              relationships: {
                changeSet: { data: { type: 'ChangeSet', id: CS } },
              },
            },
          ],
        });
      await settle();
      const mine = http.expectOne(
        (r) => r.url === '/api/locks/l2' && r.method === 'DELETE',
      );
      expect(mine.request.params.get('ifUnchanged')).toBe('true');
      mine.flush(null, { status: 204, statusText: 'No Content' });
      await settle();
      http
        .expectOne(`/api/change-sets/${OTHER_CS}/locks`)
        .flush(
          { data: { type: 'Lock', id: 'l3' } },
          { status: 201, statusText: 'Created' },
        );
      await settle();
      http
        .expectOne((r) => r.url === '/api/modules/en/charging')
        .flush(moduleDoc);
      http.expectOne((r) => r.url === '/api/module-summaries').flush(empty);
      await settle();
      http.expectOne(WC).flush(copyDoc());
      await settle();
      http.expectOne(`/api/change-sets/${CS}/locks`).flush(...ownAnswer(false));
      await settle();
      http
        .match((r) => r.url === '/api/manuals')
        .forEach((r) => r.flush(empty));
      await settle();
      expect(dialog()?.textContent).toContain(
        "You're editing this module in another revision",
      );
      harness.fixture.destroy();
    });

    it('keeps the lock there when it changed there meanwhile, and says so (#472)', async () => {
      const { http, settle, harness } = await openLocked(
        undefined,
        ownAnswer(false),
      );
      slot('lock-release-there')!.click();
      await settle();
      http
        .expectOne((r) => r.url === `/api/locks/${LOCK}`)
        .flush(
          {
            errors: [
              {
                status: '409',
                code: 'has-changes',
                title: 'Changed',
                detail: 'Changed.',
              },
            ],
          },
          { status: 409, statusText: 'Conflict' },
        );
      await settle();
      http.expectNone(`/api/change-sets/${CS}/locks`);
      expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain(
        'It was changed there meanwhile',
      );
      harness.fixture.destroy();
    });

    it('turns the editor read-only on its next save once someone took it over', async () => {
      const { harness, http, settle, el } = await render();
      await answerReads(http, settle);
      http.expectOne(WC).flush(copyDoc());
      await settle();
      http
        .expectOne(`/api/change-sets/${CS}/locks`)
        .flush({ data: { type: 'Lock', id: 'l1' } });
      await settle();
      http.expectOne((r) => r.url === '/api/manuals').flush(empty);
      await settle();
      const draft = harness.routeDebugElement!.injector.get(ModuleDraft);
      draft.edit(
        toEditor({
          ...content,
          blocks: [
            {
              type: 'paragraph',
              id: 'intro',
              content: [{ type: 'text', text: 'Mine, unsaved.' }],
            },
          ],
        } as never) as never,
      );
      void draft.flush();
      await new Promise((r) => setTimeout(r, 0));
      http
        .expectOne((r) => r.method === 'PUT' && r.url === WC)
        .flush(
          {
            errors: [
              {
                status: '409',
                code: 'lock-required',
                title: 'Lock required',
                detail: 'No lock.',
              },
            ],
          },
          { status: 409, statusText: 'Conflict' },
        );
      await settle();
      // Taken again once: someone else holds it now.
      http.expectOne(`/api/change-sets/${CS}/locks`).flush(...lockedAnswer);
      await settle();
      expect(
        el()
          .querySelector('.doc-editor-content')
          ?.getAttribute('contenteditable'),
      ).toBe('false');
      expect(el().textContent).toContain('other is editing it');
      expect(el().querySelector('of-save-status')).toBeNull();
      // No dialog by itself: a toast says who took it over, and that the text is kept.
      expect(dialog()).toBeNull();
      expect(
        TestBed.inject(ToastService)
          .toasts()
          .map((t) => t.message),
      ).toContainEqual(
        translated('editor.moduleLock.lost', { holder: 'other' }),
      );
      expect(
        localStorage.getItem(
          Object.keys(localStorage).find((k) => k.includes('charging')) ?? '',
        ),
      ).toContain('Mine, unsaved.');
      harness.fixture.destroy();
    });
  });
});
