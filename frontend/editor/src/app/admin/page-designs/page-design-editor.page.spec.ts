import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  type TestRequest,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';

import { provideZard } from '@openfolia/ui/core';

import { ReadRef } from '../../api';
import { apiErrorInterceptor } from '../../api/api-interceptors';
import { MeService } from '../../permissions/me';
import { BlockEditorComponent } from '../../doc-editor/block-editor.component';
import { ChangeSetSession } from '../../session/change-set-session';
import { provideChangeSetUrl } from '../../session/change-set-url';
import { DesignDraft } from './design-draft';
import { newDesign, type PageDesign } from './design-model';
import { PageDesignEditorPage } from './page-design-editor.page';
import { REGION_EDIT_DELAY_MS } from './region-texts.component';
import { advance } from '../../testing/fake-time';

const CS = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const BRANCH = `change-sets/${CS}`;
const WC = `/api/change-sets/${CS}/page-designs/ours/working-copy`;
const DESIGN = newDesign('ours', 'Ours', 'classic');
const links = { self: '', first: '', last: '', prev: null, next: null };
const page = (data: unknown[]) => ({
  data,
  meta: {
    page: { currentPage: 1, lastPage: 1, perPage: 100, total: data.length },
  },
  links,
});
const copyDoc = (
  content: PageDesign,
  version: number,
  issues: unknown[] = [],
) => ({
  data: {
    type: 'WorkingCopy',
    id: `${CS}/design/ours`,
    attributes: {
      subject: { type: 'design', designId: 'ours' },
      content,
      version,
      baseCommit: 'c0',
    },
    relationships: { changeSet: { data: { type: 'ChangeSet', id: CS } } },
    meta: { saved: version > 0, issues },
  },
});

async function render(permissions: string[], author = 'author') {
  localStorage.setItem(
    'openfolia.change-set',
    JSON.stringify({ id: CS, title: 'Design', branch: BRANCH }),
  );
  TestBed.configureTestingModule({
    providers: [
      provideRouter([
        {
          path: 'admin/page-designs/:designId',
          component: PageDesignEditorPage,
          data: { changeSetParam: 'session' },
        },
        { path: '**', children: [] },
      ]),
      provideChangeSetUrl(),
      provideHttpClient(withInterceptors([apiErrorInterceptor])),
      provideHttpClientTesting(),
      provideZard(),
    ],
  });
  TestBed.inject(ReadRef).ref.set(BRANCH);
  TestBed.inject(MeService).set({
    id: 'author',
    kind: 'user',
    name: 'Author',
    role: '',
    permissions: new Set(permissions),
  });
  const { RouterTestingHarness } = await import('@angular/router/testing');
  const harness = await RouterTestingHarness.create();
  // On fake time: the region texts' debounce, the change detection it starts and the save
  // after it run in order, however loaded the machine is (#585, the rule in the README).
  vi.useFakeTimers();
  const http = TestBed.inject(HttpTestingController);
  // Up to five steps, and none once no timer is due: each step renders this whole page, and
  // a test that settled twenty times rendered it a hundred times, past its 5 s on a loaded
  // machine (#615). With no timer left a step has nothing to run.
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await advance();
      if (vi.getTimerCount() === 0) break;
    }
  };
  void TestBed.inject(ChangeSetSession).refresh();
  http
    .expectOne((r) => r.url === '/api/change-sets')
    .flush(
      page([
        {
          type: 'ChangeSet',
          id: CS,
          attributes: {
            title: 'Design',
            state: 'draft',
            branch: BRANCH,
            author: { kind: 'user', id: author },
            createdAt: '2026-01-01T00:00:00Z',
          },
        },
      ]),
    );
  void harness.navigateByUrl('/admin/page-designs/ours');
  await settle();
  // The own templates to choose from (#396), at the change set's branch.
  const templates = http.expectOne(
    (r) => r.url === '/api/page-design-templates',
  );
  expect(templates.request.params.get('ref')).toBe(BRANCH);
  templates.flush(
    page([
      {
        type: 'PageDesignTemplate',
        id: 'house',
        attributes: { path: 'templates/house/manual.typ' },
      },
    ]),
  );
  // The preview's choices: no manual, so nothing renders.
  http.expectOne((r) => r.url === '/api/manuals').flush(page([]));
  http
    .expectOne((r) => r.url === '/api/config')
    .flush({
      data: {
        type: 'ProjectConfig',
        id: 'project',
        attributes: { languages: { source: 'en', targets: ['de'] } },
      },
    });
  const el = () => harness.routeNativeElement as HTMLElement;
  return { http, settle, el, harness };
}

describe('PageDesignEditorPage', () => {
  afterEach(() => {
    const http = TestBed.inject(HttpTestingController);
    // The fonts to pick from, where a test is not about them: none.
    for (const r of http.match((r) => r.url === '/api/assets')) {
      if (!r.cancelled) r.flush(page([]));
    }
    http.verify();
    localStorage.clear();
  });

  it('edits the design in the author’s draft: a colour saved into the working copy, the contrast shown', async () => {
    const t = await render([
      'content.read',
      'content.read.draft',
      'content.edit',
    ]);
    t.http.expectOne(WC).flush(copyDoc(DESIGN, 0));
    t.http.expectOne((r) => r.url === '/api/locks').flush(page([]));
    await t.settle();

    const settings = t
      .el()
      .querySelector<HTMLFieldSetElement>('[data-slot="design-settings"]');
    expect(settings?.disabled).toBe(false);
    expect(t.el().querySelector('[data-slot="no-manuals"]')).not.toBeNull();
    // The template: none of its own, the layout's (#396).
    expect(
      t.el().querySelector('[data-slot="template-select"]')?.textContent,
    ).toContain("The layout's template");
    // One query for all the sections: on a loaded machine each query of this page's DOM is
    // slow, and twelve of them pushed the test past its timeout (#585).
    const sections = [
      ...t.el().querySelectorAll<HTMLElement>('[data-section]'),
    ].map((s) => s.dataset['section']);
    expect(sections).toEqual(
      expect.arrayContaining([
        'layout',
        'page',
        'logo',
        'colours',
        'fonts',
        'fields',
        'running',
        'headings',
        'body',
        'tables',
        'steps',
        'safety',
      ]),
    );
    // The fonts to pick from (#555): those at the branch and the change set's uploads.
    const fonts = t.http.expectOne((r) => r.url === '/api/assets');
    expect(fonts.request.params.get('filter[type]')).toBe('font');
    expect(fonts.request.params.get('filter[changeSet]')).toBe(CS);
    fonts.flush(page([]));
    await t.settle();
    expect(
      t.el().querySelector('[data-slot="font-upload"]')?.textContent,
    ).toContain('Upload fonts');

    const input = t.el().querySelector<HTMLInputElement>('#pd-colour-primary');
    if (!input) throw new Error('no primary colour');
    input.value = 'ffee00';
    input.dispatchEvent(new Event('change'));
    await t.settle();
    expect(
      t.el().querySelector('[data-contrast="primary"]')?.textContent,
    ).toContain('too low for text');
    t.http.expectOne(`/api/change-sets/${CS}/locks`).flush({});
    await t.settle();
    const put: TestRequest = t.http.expectOne(WC);
    expect(put.request.body.data.attributes.content.colours.primary).toBe(
      '#ffee00',
    );
    put.flush(copyDoc(put.request.body.data.attributes.content, 1));
    await t.settle();

    // A colour that is none: refused where it is typed, nothing sent.
    input.value = 'not a colour';
    input.dispatchEvent(new Event('change'));
    await t.settle();
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('edits the back page (#395): on, inside the cover, a copyright line per language, the missing manufacturer said', async () => {
    const t = await render([
      'content.read',
      'content.read.draft',
      'content.edit',
    ]);
    t.http.expectOne(WC).flush(copyDoc(DESIGN, 0));
    t.http.expectOne((r) => r.url === '/api/locks').flush(page([]));
    await t.settle();
    const section = () =>
      t.el().querySelector<HTMLElement>('[data-section="back-page"]');
    expect(
      section()?.querySelector('[data-slot="back-page-position"]'),
    ).toBeNull();
    let version = 0;
    const saved = async (): Promise<PageDesign> => {
      await t.settle();
      if (version === 0) {
        t.http.expectOne(`/api/change-sets/${CS}/locks`).flush({});
        await t.settle();
      }
      const put: TestRequest = t.http.expectOne(WC);
      const content = put.request.body.data.attributes.content as PageDesign;
      const issues = content.backPage
        ? [
            {
              severity: 'warning',
              code: 'missing-manufacturer',
              message: 'no manufacturer',
              at: 'backPage',
            },
          ]
        : [];
      put.flush(copyDoc(content, ++version, issues));
      await t.settle();
      return content;
    };

    section()
      ?.querySelector<HTMLElement>(
        '[data-slot="back-page"] button[role=switch]',
      )
      ?.click();
    expect((await saved()).backPage).toEqual({
      position: 'last',
      documentNumber: true,
      date: true,
    });
    // No manufacturer in the project: said, with the way to the settings.
    expect(
      section()?.querySelector('[data-slot="manufacturer-none"]'),
    ).not.toBeNull();
    expect(
      section()
        ?.querySelector('[data-slot="manufacturer-settings"]')
        ?.getAttribute('href'),
    ).toContain('/admin/settings/manufacturer');
    expect(section()?.textContent).toContain(
      'The project has no manufacturer details for the back page',
    );

    const inside = section()?.querySelector<HTMLInputElement>(
      '[data-slot="back-page-position"] input[value="inside-cover"]',
    );
    inside?.click();
    expect((await saved()).backPage?.position).toBe('inside-cover');

    const copyright =
      section()?.querySelector<HTMLInputElement>('#pd-copyright');
    if (!copyright) throw new Error('no copyright field');
    copyright.value = '© Example Works Ltd';
    copyright.dispatchEvent(new Event('change'));
    expect((await saved()).backPage?.copyright).toBe('© Example Works Ltd');
    // German gets its own line; English keeps the one written for all.
    section()
      ?.querySelector<HTMLInputElement>(
        '[data-slot="back-page-copyright-language"] input[value="de"]',
      )
      ?.click();
    await t.settle();
    expect(copyright.value).toBe('© Example Works Ltd');
    copyright.value = '© Example Works Ltd. Alle Rechte vorbehalten.';
    copyright.dispatchEvent(new Event('change'));
    expect((await saved()).backPage?.copyright).toEqual({
      en: '© Example Works Ltd',
      de: '© Example Works Ltd. Alle Rechte vorbehalten.',
    });

    section()
      ?.querySelector<HTMLElement>(
        '[data-slot="back-page-date"] button[role=switch]',
      )
      ?.click();
    expect((await saved()).backPage?.date).toBe(false);

    section()
      ?.querySelector<HTMLElement>(
        '[data-slot="back-page"] button[role=switch]',
      )
      ?.click();
    expect((await saved()).backPage).toBeUndefined();
  });

  it('shows a stalled save point before a navigation as such, with a retry that loads again (#557)', async () => {
    const t = await render([
      'content.read',
      'content.read.draft',
      'content.edit',
    ]);
    t.http.expectOne(WC).flush(copyDoc(DESIGN, 0));
    t.http.expectOne((r) => r.url === '/api/locks').flush(page([]));
    await t.settle();
    const draft = t.harness.fixture.debugElement
      .query(By.directive(PageDesignEditorPage))
      .injector.get(DesignDraft);
    const load = vi.spyOn(draft, 'load').mockResolvedValue();
    draft.status.set('stalled');
    await t.settle();
    const stalled = t.el().querySelector('[data-slot="design-stalled"]');
    expect(stalled?.textContent).toContain('still being committed');
    expect(t.el().querySelector('[data-slot="design-settings"]')).toBeNull();
    stalled?.querySelector<HTMLButtonElement>('button')?.click();
    expect(load).toHaveBeenCalledWith(
      expect.objectContaining({ id: CS }),
      'ours',
    );
  });

  it('edits the title page text per language (#393): the source text for all, a translation of its own, issues at their block', async () => {
    const t = await render([
      'content.read',
      'content.read.draft',
      'content.edit',
    ]);
    const footer = [
      {
        type: 'paragraph',
        id: 'keep',
        content: [
          { type: 'text', text: 'Keep this manual. ' },
          { type: 'placeholder', key: 'serial' },
        ],
      },
    ];
    const design = {
      ...DESIGN,
      regions: { footer },
    } as unknown as PageDesign;
    t.http.expectOne(WC).flush(
      copyDoc(design, 0, [
        {
          severity: 'error',
          code: 'unknown-placeholder',
          message: 'x',
          at: 'regions.footer#keep',
        },
      ]),
    );
    t.http.expectOne((r) => r.url === '/api/locks').flush(page([]));
    await t.settle();

    const section = t.el().querySelector('[data-section="regions"]');
    expect(section).not.toBeNull();
    const rows = () =>
      [...t.el().querySelectorAll<HTMLElement>('[data-region]')].map(
        (r) => `${r.dataset['region']}:${r.dataset['state']}`,
      );
    expect(rows()).toEqual([
      'above-title:empty',
      'below-fields:empty',
      'footer:own',
      'back:empty',
      'back-footer:empty',
    ]);
    const row = () =>
      t.el().querySelector<HTMLElement>('[data-region="footer"]')!;
    // The region with text is open, its editor there, the unknown placeholder flagged.
    expect(
      row().querySelector('[data-node="placeholder"]')?.className,
    ).toContain('doc-editor-issue');
    expect(
      row().querySelector('[data-issue="unknown-placeholder"]'),
    ).not.toBeNull();

    // German: the English text is shown, marked as not translated.
    const german = section!.querySelector<HTMLInputElement>(
      'of-segmented input[value="de"]',
    )!;
    german.click();
    await t.settle();
    expect(row().dataset['state']).toBe('source');
    expect(row().querySelector('[data-slot="region-fallback"]')).not.toBeNull();
    expect(
      t.el().querySelector('[data-slot="region-translation-summary"]')
        ?.textContent,
    ).toContain('1');

    // Typing in it makes it the German text: the English one kept.
    const editors = t.harness.fixture.debugElement.queryAll(
      By.directive(BlockEditorComponent),
    );
    const editor = (editors[0]!.componentInstance as BlockEditorComponent)
      .editor!;
    editor.commands.setTextSelection(3);
    editor.commands.insertContent('Bitte ');
    await advance(REGION_EDIT_DELAY_MS);
    await t.settle();
    t.http.expectOne(`/api/change-sets/${CS}/locks`).flush({});
    await t.settle();
    const put: TestRequest = t.http.expectOne(WC);
    const regions = put.request.body.data.attributes.content.regions;
    expect(Object.keys(regions.footer)).toEqual(['en', 'de']);
    expect(regions.footer.en).toEqual(footer);
    expect(JSON.stringify(regions.footer.de)).toContain('Bitte');
    put.flush(copyDoc(put.request.body.data.attributes.content, 1));
    await t.settle();
    expect(row().dataset['state']).toBe('own');

    // "Use the English text": the German one goes, the text is the same for all again.
    row()
      .querySelector<HTMLButtonElement>('[data-slot="region-use-source"]')!
      .click();
    await t.settle();
    const back: TestRequest = t.http.expectOne(WC);
    expect(back.request.body.data.attributes.content.regions).toEqual({
      footer,
    });
    back.flush(copyDoc(back.request.body.data.attributes.content, 2));
    await t.settle();
    expect(row().dataset['state']).toBe('source');
  });

  it('keeps each language’s editor true to the design (#393): text typed and taken back hands nothing on, an emptied translation keeps its editor, a language shown again shows what was typed', async () => {
    const t = await render([
      'content.read',
      'content.read.draft',
      'content.edit',
    ]);
    const footer = [
      { type: 'paragraph', content: [{ type: 'text', text: 'Keep this.' }] },
    ];
    t.http
      .expectOne(WC)
      .flush(
        copyDoc({ ...DESIGN, regions: { footer } } as unknown as PageDesign, 0),
      );
    t.http.expectOne((r) => r.url === '/api/locks').flush(page([]));
    await t.settle();
    const section = t.el().querySelector('[data-section="regions"]')!;
    const row = () =>
      t.el().querySelector<HTMLElement>('[data-region="footer"]')!;
    const editor = () =>
      (
        t.harness.fixture.debugElement.queryAll(
          By.directive(BlockEditorComponent),
        )[0]!.componentInstance as BlockEditorComponent
      ).editor!;
    const pickLang = async (lang: string) => {
      section
        .querySelector<HTMLInputElement>(`of-segmented input[value="${lang}"]`)!
        .click();
      await t.settle();
    };
    const pause = async () => {
      await advance(REGION_EDIT_DELAY_MS);
      await t.settle();
      for (const lock of t.http.match(`/api/change-sets/${CS}/locks`))
        lock.flush({});
      await t.settle();
    };
    let version = 0;
    const saved = async () => {
      const put: TestRequest = t.http.expectOne(WC);
      const content = put.request.body.data.attributes.content;
      put.flush(copyDoc(content, ++version));
      await t.settle();
      return content.regions;
    };

    // English typed and handed on.
    editor().commands.setTextSelection(1);
    editor().commands.insertContent('Please ');
    await pause();
    expect(JSON.stringify((await saved()).footer)).toContain('Please Keep');

    // German, typed and taken back before the pause: nothing handed on.
    await pickLang('de');
    expect(row().dataset['state']).toBe('source');
    editor().commands.setTextSelection(1);
    editor().commands.insertContent('X');
    editor().commands.deleteRange({ from: 1, to: 2 });
    await pause();
    t.http.expectNone(WC);

    // A German text of its own, then emptied: the German one goes, its editor stays (caret kept).
    editor().commands.setTextSelection(1);
    editor().commands.insertContent('Bitte ');
    await pause();
    expect(Object.keys((await saved()).footer)).toEqual(['en', 'de']);
    const german = editor();
    german.commands.selectAll();
    german.commands.deleteSelection();
    await pause();
    expect(Object.keys((await saved()).footer)).not.toContain('de');
    expect(editor()).toBe(german);
    expect(editor().getText()).toBe('');

    // Back in English: the text typed there, not the one first shown.
    await pickLang('en');
    expect(editor().getText()).toContain('Please Keep this.');
  });

  it('shows the design read-only, with the reason, to whoever cannot change it', async () => {
    const t = await render(['content.read', 'content.read.draft']);
    t.http
      .expectOne((r) => r.url === '/api/page-designs/ours')
      .flush({
        data: {
          type: 'PageDesign',
          id: 'ours',
          attributes: DESIGN,
          meta: { issues: [] },
        },
      });
    await t.settle();
    const settings = t
      .el()
      .querySelector<HTMLFieldSetElement>('[data-slot="design-settings"]');
    expect(settings?.disabled).toBe(true);
    expect(
      t.el().querySelector('[data-slot="read-reason"]')?.textContent,
    ).toContain('Your role cannot change it');
    expect(t.el().querySelector('[data-slot="design-undo"]')).toBeNull();
    // What the standard fixes is listed, with why.
    expect(t.el().querySelectorAll('[data-fixed]')).toHaveLength(3);
  });
});
