import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  type TestRequest,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import type { Editor } from '@tiptap/core';
import { undo } from '@tiptap/pm/history';
import { TextSelection } from '@tiptap/pm/state';

import { provideZard } from '@openfolia/ui/core';
import { translated } from '@openfolia/ui/i18n';
import { ToastService } from '@openfolia/ui/toast';

import { apiErrorInterceptor } from '../api/api-interceptors';
import { BlockEditorComponent } from '../doc-editor/block-editor.component';
import { saveAsSnippet } from '../doc-editor/snippets/save-snippet';
import { MeService } from '../permissions/me';
import { provideChangeSetUrl } from '../session/change-set-url';
import { ModuleEditorPage } from './module-editor.page';
import { advance } from '../testing/fake-time';

// "Save as snippet" (#309) in the module editor, the API faked: the snippet module is created in
// the revision with the selected blocks, and one reference takes their place.

const CS = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const BRANCH = `change-sets/${CS}`;
const WC = `/api/change-sets/${CS}/modules/en/charging/working-copy`;
const SNIPPET_WC = `/api/change-sets/${CS}/modules/en/hot-surface/working-copy`;

const config = {
  languages: { source: 'en', targets: ['de'] },
  moduleTypes: [
    { id: 'procedure', label: 'Procedure', restricted: false, snippet: false },
    { id: 'phrase', label: 'Phrase', restricted: false, snippet: true },
  ],
  audiences: [{ id: 'public', label: 'Public' }],
  facets: [{ id: 'line', label: 'Line', values: [{ id: 'a', label: 'A' }] }],
  variantAttributes: [],
  textAttributes: [],
  safetySymbols: [],
  outputLabels: {},
};

const paragraph = (id: string, text: string) => ({
  type: 'paragraph',
  id,
  content: [{ type: 'text', text }],
});

const content = {
  schemaVersion: 1,
  id: 'charging',
  meta: {
    title: 'Charging',
    type: 'procedure',
    lang: 'en',
    audience: 'public',
    facets: { line: ['a'] },
  },
  blocks: [
    paragraph('intro', 'Plug it in.'),
    paragraph('hot1', 'The surface gets hot.'),
    paragraph('hot2', 'Let it cool down first.'),
    paragraph('outro', 'Then unplug it.'),
  ],
};

const empty = {
  data: [],
  meta: { page: { currentPage: 1, lastPage: 1, perPage: 100, total: 0 } },
  links: { self: '', first: '', last: '', prev: null, next: null },
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
      audience: 'public',
      facets: { line: ['a'] },
      blocks: content.blocks,
    },
    meta: { status: { changeSets: [] }, issues: [] },
  },
};

const copyDoc = {
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
    meta: { saved: false, issues: [] },
  },
};

const notFound = [
  { errors: [{ status: '404', code: 'not-found' }] },
  { status: 404, statusText: 'Not Found' },
] as const;

async function open() {
  localStorage.setItem(
    'openfolia.change-set',
    JSON.stringify({ id: CS, title: 'Trial', branch: BRANCH }),
  );
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
    permissions: new Set([
      'content.read',
      'content.read.draft',
      'content.edit',
    ]),
  });
  const { RouterTestingHarness } = await import('@angular/router/testing');
  const harness = await RouterTestingHarness.create();
  // Fake time from here: the dialog's leave transition is waited out on the fake clock, which
  // runs every timer due in the step, in order, however slow the machine is (#562).
  vi.useFakeTimers();
  const http = TestBed.inject(HttpTestingController);
  void harness.navigateByUrl('/content/en/charging');
  // Not stability: a request left open (the snippet list, where the module is used) keeps the
  // app from being stable. Renders, and runs what is due, a few times.
  const settle = async () => {
    for (let i = 0; i < 4; i++) await advance();
  };
  await settle();
  http.expectOne('/api/config').flush({ data: { attributes: config } });
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
          attributes: { languages: ['en'] },
        },
      ],
    });
  await settle();
  http.expectOne(WC).flush(copyDoc);
  await settle();
  http
    .expectOne(`/api/change-sets/${CS}/locks`)
    .flush(
      { data: { type: 'Lock', id: 'l1' } },
      { status: 201, statusText: 'Created' },
    );
  await settle();
  /** Answers what the page reads besides the module (where it is used, the snippets). */
  const answerSide = () => {
    http.match((r) => r.url === '/api/manuals').forEach((r) => r.flush(empty));
    http
      .match(
        (r) =>
          r.url === '/api/module-summaries' &&
          r.params.get('filter[snippet]') === 'true',
      )
      .forEach((r) => r.flush(empty));
  };
  answerSide();
  await settle();
  const editor = harness.fixture.debugElement.query(
    By.directive(BlockEditorComponent),
  ).componentInstance.editor as Editor;
  const panel = () => document.querySelector<HTMLElement>('z-dialog-panel');
  const paragraphs = () => {
    const out: string[] = [];
    editor.state.doc.forEach((node) =>
      out.push(
        node.type.name === 'moduleRef'
          ? `ref:${node.attrs['module']}`
          : node.textContent,
      ),
    );
    return out.filter((t) => t !== '');
  };
  /** Selects the two paragraphs about the hot surface and saves them as "Hot surface". */
  const saveHot = async () => {
    let start = -1;
    let end = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.textContent === 'The surface gets hot.') start = pos + 1;
      if (node.textContent === 'Let it cool down first.')
        end = pos + 1 + node.textContent.length;
      return !node.isTextblock;
    });
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, start, end),
      ),
    );
    expect(saveAsSnippet(editor)).toBe(true);
    await settle();
    const title = panel()!.querySelector<HTMLInputElement>(
      '#save-snippet-title',
    )!;
    title.value = 'Hot surface';
    title.dispatchEvent(new Event('input'));
    await settle();
    panel()!
      .querySelector<HTMLButtonElement>('[data-slot="save-snippet-submit"]')!
      .click();
    // The change detection first: it starts the dialog's leave transition, which the fake clock
    // then runs past.
    await settle();
    await vi.advanceTimersByTimeAsync(150);
    await settle();
  };
  /** Answers the creation's reads, its ID search and its lock; returns its save. */
  const createdUpToSave = async (): Promise<TestRequest> => {
    http
      .expectOne(`/api/change-sets/${CS}`)
      .flush({ data: { attributes: { baseCommit: 'base1' } } });
    await settle();
    http.expectOne(SNIPPET_WC).flush(...notFound);
    await settle();
    http
      .expectOne(
        (r) =>
          r.url === '/api/module-summaries' &&
          r.params.get('filter[q]') === 'hot-surface',
      )
      .flush(empty);
    await settle();
    http
      .expectOne(`/api/change-sets/${CS}/locks`)
      .flush(
        { data: { type: 'Lock', id: 'l2' } },
        { status: 201, statusText: 'Created' },
      );
    await settle();
    return http.expectOne((r) => r.url === SNIPPET_WC && r.method === 'PUT');
  };
  return {
    harness,
    http,
    settle,
    editor,
    paragraphs,
    saveHot,
    createdUpToSave,
    answerSide,
  };
}

describe('Save as snippet in the module editor', { timeout: 20_000 }, () => {
  afterEach(() => document.querySelector('.cdk-overlay-container')?.remove());

  it('creates the snippet in the revision with the two paragraphs and puts one reference in their place; Undo brings them back', async () => {
    const t = await open();
    await t.saveHot();
    const save = await t.createdUpToSave();
    const snippet = save.request.body.data.attributes.content;
    expect(snippet.id).toBe('hot-surface');
    // The module's language, facets and audience; the snippet type preselected.
    expect(snippet.meta).toEqual({
      title: 'Hot surface',
      type: 'phrase',
      lang: 'en',
      audience: 'public',
      facets: { line: ['a'] },
    });
    expect(
      snippet.blocks.map(
        (b: { content: { text: string }[] }) => b.content[0]!.text,
      ),
    ).toEqual(['The surface gets hot.', 'Let it cool down first.']);
    // New block IDs: nothing links back to the module's own.
    const ids = snippet.blocks.map((b: { id: string }) => b.id);
    expect(ids).not.toContain('hot1');
    expect(ids).not.toContain('hot2');
    // Nothing changes in the document until the snippet is there.
    expect(t.paragraphs()).toEqual([
      'Plug it in.',
      'The surface gets hot.',
      'Let it cool down first.',
      'Then unplug it.',
    ]);
    save.flush({ data: {} });
    await t.settle();
    t.http
      .expectOne(`/api/change-sets/${CS}/commits`)
      .flush({ data: {} }, { status: 201, statusText: 'Created' });
    await t.settle();
    t.answerSide();
    expect(t.paragraphs()).toEqual([
      'Plug it in.',
      'ref:hot-surface',
      'Then unplug it.',
    ]);
    // One toast, once the reference is in.
    expect(
      TestBed.inject(ToastService)
        .toasts()
        .filter((toast) => toast.kind === 'success')
        .map((toast) => toast.message),
    ).toEqual([
      translated('editor.moduleEditor.saveSnippet.done', {
        title: 'Hot surface',
      }),
    ]);
    undo(t.editor.state, t.editor.view.dispatch);
    expect(t.paragraphs()).toEqual([
      'Plug it in.',
      'The surface gets hot.',
      'Let it cool down first.',
      'Then unplug it.',
    ]);
    t.harness.fixture.destroy();
  });

  it('leaves the selection as it was when the creation fails, with a toast offering Retry', async () => {
    const t = await open();
    await t.saveHot();
    const save = await t.createdUpToSave();
    save.flush({ data: {} });
    await t.settle();
    t.http
      .expectOne(`/api/change-sets/${CS}/commits`)
      .flush(
        { errors: [{ status: '409', code: 'branch-moved' }] },
        { status: 409, statusText: 'Conflict' },
      );
    await t.settle();
    // What it took is given back: the working copy and the lock.
    t.http
      .expectOne((r) => r.url === SNIPPET_WC && r.method === 'DELETE')
      .flush(null, { status: 204, statusText: 'No Content' });
    await t.settle();
    t.http
      .expectOne((r) => r.url === '/api/locks/l2' && r.method === 'DELETE')
      .flush(null, { status: 204, statusText: 'No Content' });
    await t.settle();
    expect(t.paragraphs()).toEqual([
      'Plug it in.',
      'The surface gets hot.',
      'Let it cool down first.',
      'Then unplug it.',
    ]);
    const failure = TestBed.inject(ToastService)
      .toasts()
      .find((toast) => toast.kind === 'error');
    expect(failure?.onAction).toBeDefined();
    // Retry goes again and, once the snippet is there, puts the reference in.
    failure!.onAction!();
    await t.settle();
    const again = await t.createdUpToSave();
    again.flush({ data: {} });
    await t.settle();
    t.http
      .expectOne(`/api/change-sets/${CS}/commits`)
      .flush({ data: {} }, { status: 201, statusText: 'Created' });
    await t.settle();
    t.answerSide();
    expect(t.paragraphs()).toEqual([
      'Plug it in.',
      'ref:hot-surface',
      'Then unplug it.',
    ]);
    t.harness.fixture.destroy();
  });
});
