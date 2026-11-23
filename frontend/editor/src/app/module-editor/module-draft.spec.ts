import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { JSONContent } from '@tiptap/core';
import { toEditor } from '@openfolia/content-editor-model';

import { ToastService } from '@openfolia/ui/toast';

import { apiErrorInterceptor } from '../api/api-interceptors';
import { draftKey, readDraft } from './local-drafts';
import {
  AUTOSAVE_MS,
  ModuleDraft,
  RETRY_MS,
  SAVE_POINT_MS,
  type ModuleContent,
} from './module-draft';
import { refusedAssets, refusedFiles } from './refused-files';

const SUBJECT = { changeSetId: 'cs1', lang: 'en', moduleId: 'charging' };
const PERSON = 'author';
const WC = '/api/change-sets/cs1/modules/en/charging/working-copy';
const COMMITS = '/api/change-sets/cs1/commits';

const content = (text: string): ModuleContent => ({
  schemaVersion: 1,
  id: 'charging',
  meta: { title: 'Charging', type: 'procedure', lang: 'en', facets: {} },
  blocks: [
    { type: 'paragraph', id: 'intro', content: [{ type: 'text', text }] },
  ],
});

const docOf = (c: ModuleContent) =>
  toEditor(c as never) as unknown as JSONContent;

const copyDoc = (c: ModuleContent, version: number, baseCommit = 'c0') => ({
  data: {
    type: 'WorkingCopy',
    id: 'cs1/module/en/charging',
    attributes: {
      subject: { type: 'module', lang: 'en', moduleId: 'charging' },
      content: c,
      version,
      baseCommit,
    },
    relationships: { changeSet: { data: { type: 'ChangeSet', id: 'cs1' } } },
    meta: { saved: version > 0, issues: [] },
  },
});

const error = (status: number, code: string) =>
  [
    { errors: [{ status: String(status), code }] },
    { status, statusText: code },
  ] as const;

function setup() {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(withInterceptors([apiErrorInterceptor])),
      provideHttpClientTesting(),
      ModuleDraft,
    ],
  });
  const draft = TestBed.inject(ModuleDraft);
  const http = TestBed.inject(HttpTestingController);
  const toast = TestBed.inject(ToastService);
  const hooks = { reload: vi.fn(), relock: vi.fn(async () => true) };
  const base = content('Before');
  const started = draft.start(
    SUBJECT,
    PERSON,
    { content: base, version: 0, baseCommit: 'c0' },
    [],
    docOf(base),
    hooks,
  );
  return { draft, http, toast, hooks, started };
}

/** Lets pending promises (and the HTTP answers they wait for) go on. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0);
};

describe('ModuleDraft', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    TestBed.inject(ModuleDraft).stop();
    TestBed.inject(HttpTestingController).verify();
  });

  it('saves the working copy once typing pauses, then is saved', async () => {
    const { draft, http } = setup();
    draft.edit(docOf(content('After')));
    expect(draft.state()).toBe('pending');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS - 1);
    http.expectNone(WC);
    await vi.advanceTimersByTimeAsync(1);
    const put = http.expectOne((r) => r.method === 'PUT' && r.url === WC);
    expect(put.request.body.meta).toEqual({ version: 0, baseCommit: 'c0' });
    expect(put.request.body.data.attributes.content).toEqual(content('After'));
    expect(draft.state()).toBe('saving');
    put.flush(copyDoc(content('After'), 1, 'c0'));
    await settle();
    expect(draft.state()).toBe('saved');
    expect(draft.savedAt()).not.toBeNull();
    expect(readDraft(PERSON, SUBJECT)).toBeNull();
  });

  it('saves nothing, and commits nothing, when the content is unchanged', async () => {
    const { draft, http } = setup();
    draft.edit(docOf(content('Before')));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 2);
    http.expectNone(WC);
    expect(draft.state()).toBe('saved');
    expect(await draft.savePoint()).toBe('unchanged');
    http.expectNone(COMMITS);
  });

  it('commits at a save point what was saved since the last one, then starts over at version 0', async () => {
    const { draft, http } = setup();
    draft.edit(docOf(content('After')));
    const point = draft.savePoint();
    await settle();
    http
      .expectOne((r) => r.method === 'PUT')
      .flush(copyDoc(content('After'), 1));
    await settle();
    const commit = http.expectOne(COMMITS);
    expect(commit.request.body.data.attributes.subjects).toEqual([
      { type: 'module', lang: 'en', moduleId: 'charging' },
    ]);
    commit.flush({ data: { type: 'Commit', id: 'c1' } });
    expect(await point).toBe('committed');
    // A second save point has nothing new to commit.
    expect(await draft.savePoint()).toBe('unchanged');
    // The next save starts on the commit, at version 0.
    draft.edit(docOf(content('Again')));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    const put = http.expectOne((r) => r.method === 'PUT');
    expect(put.request.body.meta).toEqual({ version: 0, baseCommit: 'c1' });
    put.flush(copyDoc(content('Again'), 1, 'c1'));
    await settle();
  });

  it('keeps text that cannot be a module yet in the browser, and saves it once it can', async () => {
    const { draft, http } = setup();
    const blank = docOf(content('x'));
    // A paragraph inside a list item cannot be empty: here, the only one has no text.
    blank.content = [
      {
        type: 'list',
        attrs: { id: 'l1', ordered: false },
        content: [
          {
            type: 'listItem',
            attrs: { id: 'i1' },
            content: [{ type: 'itemText' }],
          },
        ],
      },
    ];
    draft.edit(blank);
    expect(draft.state()).toBe('incomplete');
    expect(draft.problem()?.blockId).toBe('i1');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 2);
    http.expectNone(WC);
    expect(readDraft(PERSON, SUBJECT)?.doc).toEqual(blank);
    draft.edit(docOf(content('Whole again')));
    expect(draft.problem()).toBeNull();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    http
      .expectOne((r) => r.method === 'PUT')
      .flush(copyDoc(content('Whole again'), 1));
    await settle();
    expect(draft.state()).toBe('saved');
  });

  it('keeps the text and tries again when the server does not answer', async () => {
    const { draft, http, toast } = setup();
    draft.edit(docOf(content('Offline')));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    http
      .expectOne((r) => r.method === 'PUT')
      .error(new ProgressEvent('error'), { status: 0 });
    await settle();
    expect(draft.state()).toBe('offline');
    expect(readDraft(PERSON, SUBJECT)).not.toBeNull();
    expect(toast.toasts()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    http
      .expectOne((r) => r.method === 'PUT')
      .flush(copyDoc(content('Offline'), 1));
    await settle();
    expect(draft.state()).toBe('saved');
    expect(toast.toasts()).toHaveLength(0);
  });

  it('takes the version of a save whose answer was lost, never reporting a false conflict', async () => {
    const { draft, http } = setup();
    draft.edit(docOf(content('Once')));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    // The save landed, but its answer was lost.
    http
      .expectOne((r) => r.method === 'PUT')
      .flush(null, { status: 504, statusText: 'Gateway Timeout' });
    await settle();
    draft.edit(docOf(content('Twice')));
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    http
      .expectOne((r) => r.method === 'PUT')
      .flush(...error(409, 'version-conflict'));
    await settle();
    http
      .expectOne((r) => r.method === 'GET' && r.url === WC)
      .flush(copyDoc(content('Once'), 1));
    await settle();
    const again = http.expectOne((r) => r.method === 'PUT');
    expect(again.request.body.meta.version).toBe(1);
    expect(again.request.body.data.attributes.content).toEqual(
      content('Twice'),
    );
    again.flush(copyDoc(content('Twice'), 2));
    await settle();
    expect(draft.state()).toBe('saved');
  });

  it('never overwrites a copy saved elsewhere: the text stays, the toast offers a reload', async () => {
    const { draft, http, toast, hooks } = setup();
    draft.edit(docOf(content('Mine')));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    http
      .expectOne((r) => r.method === 'PUT')
      .flush(...error(409, 'version-conflict'));
    await settle();
    http
      .expectOne((r) => r.method === 'GET' && r.url === WC)
      .flush(copyDoc(content('Theirs'), 3));
    await settle();
    expect(draft.state()).toBe('conflict');
    expect(readDraft(PERSON, SUBJECT)).not.toBeNull();
    // Further edits are kept, not sent.
    draft.edit(docOf(content('Mine, more')));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 2);
    http.expectNone(WC);
    const shown = toast.toasts()[0];
    expect(shown?.kind).toBe('error');
    shown?.onAction?.();
    expect(hooks.reload).toHaveBeenCalled();
  });

  it('takes the lock again by itself once it was lost, and saves', async () => {
    const { draft, http, hooks, toast } = setup();
    draft.edit(docOf(content('Locked out')));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    http
      .expectOne((r) => r.method === 'PUT')
      .flush(...error(409, 'lock-required'));
    await settle();
    expect(hooks.relock).toHaveBeenCalledTimes(1);
    http
      .expectOne((r) => r.method === 'PUT')
      .flush(copyDoc(content('Locked out'), 1));
    await settle();
    expect(draft.state()).toBe('saved');
    expect(toast.toasts()).toHaveLength(0);
  });

  it('lost again straight after taking it back, waits for Retry', async () => {
    const { draft, http, hooks, toast } = setup();
    draft.edit(docOf(content('Locked out')));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    http
      .expectOne((r) => r.method === 'PUT')
      .flush(...error(409, 'lock-required'));
    await settle();
    http
      .expectOne((r) => r.method === 'PUT')
      .flush(...error(409, 'lock-required'));
    await settle();
    // Not taken back and forth: once by itself, then the person's Retry.
    expect(hooks.relock).toHaveBeenCalledTimes(1);
    expect(draft.state()).toBe('failed');
    expect(toast.toasts()).toHaveLength(1);
    expect(readDraft(PERSON, SUBJECT)).not.toBeNull();
    const retry = draft.retry();
    await settle();
    expect(hooks.relock).toHaveBeenCalledTimes(2);
    http
      .expectOne((r) => r.method === 'PUT')
      .flush(copyDoc(content('Locked out'), 1));
    await retry;
    expect(draft.state()).toBe('saved');
  });

  it('a save point refused for the lost lock takes it again too', async () => {
    const { draft, http, hooks } = setup();
    draft.edit(docOf(content('After')));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    http
      .expectOne((r) => r.method === 'PUT')
      .flush(copyDoc(content('After'), 1));
    await settle();
    const point = draft.savePoint(true);
    await settle();
    http.expectOne(COMMITS).flush(...error(409, 'lock-required'));
    expect(await point).toBe('failed');
    await settle();
    expect(hooks.relock).toHaveBeenCalledTimes(1);
    expect(draft.state()).toBe('saved');
  });

  it('restores the browser’s draft of the very same copy, and leaves an older one to the person', () => {
    const { draft } = setup();
    const kept = docOf(content('Kept'));
    localStorage.setItem(
      draftKey(PERSON, SUBJECT),
      JSON.stringify({ doc: kept, version: 0, baseCommit: 'c0', at: 'now' }),
    );
    const base = content('Before');
    const hooks = { reload: vi.fn(), relock: vi.fn(async () => true) };
    const same = draft.start(
      SUBJECT,
      PERSON,
      { content: base, version: 0, baseCommit: 'c0' },
      [],
      docOf(base),
      hooks,
    );
    expect(same.restored).toBe(true);
    expect(same.doc).toEqual(kept);
    expect(draft.state()).toBe('pending');
    const newer = draft.start(
      SUBJECT,
      PERSON,
      { content: base, version: 4, baseCommit: 'c0' },
      [],
      docOf(base),
      hooks,
    );
    expect(newer.restored).toBe(false);
    expect(newer.older?.doc).toEqual(kept);
    expect(draft.state()).toBe('saved');
  });

  it('commits once when save points overlap', async () => {
    const { draft, http } = setup();
    draft.edit(docOf(content('After')));
    const first = draft.savePoint();
    const second = draft.savePoint(true);
    await settle();
    http
      .expectOne((r) => r.method === 'PUT')
      .flush(copyDoc(content('After'), 1));
    await settle();
    http.expectOne(COMMITS).flush({ data: { type: 'Commit', id: 'c1' } });
    expect(await first).toBe('committed');
    expect(await second).toBe('committed');
  });

  it('a toast from an earlier module does nothing on the next one', async () => {
    const { draft, http, toast, hooks } = setup();
    draft.edit(docOf(content('Mine')));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    http
      .expectOne((r) => r.method === 'PUT')
      .flush(...error(409, 'version-conflict'));
    await settle();
    http
      .expectOne((r) => r.method === 'GET' && r.url === WC)
      .flush(copyDoc(content('Theirs'), 3));
    await settle();
    const shown = toast.toasts()[0];
    // Another module opens: its toast goes, and an action still held does nothing.
    draft.stop();
    expect(toast.toasts()).toHaveLength(0);
    expect(draft.dirty()).toBe(false);
    shown?.onAction?.();
    expect(hooks.reload).not.toHaveBeenCalled();
    // What was typed stays in the browser.
    expect(readDraft(PERSON, SUBJECT)).not.toBeNull();
  });

  it('drops what the browser keeps only when asked, on a successful start', () => {
    const { draft } = setup();
    const kept = docOf(content('Kept'));
    localStorage.setItem(
      draftKey(PERSON, SUBJECT),
      JSON.stringify({ doc: kept, version: 0, baseCommit: 'c0', at: 'now' }),
    );
    draft.stop(true);
    expect(readDraft(PERSON, SUBJECT)).not.toBeNull();
    const base = content('Before');
    const started = draft.start(
      SUBJECT,
      PERSON,
      { content: base, version: 0, baseCommit: 'c0' },
      [],
      docOf(base),
      { reload: vi.fn(), relock: vi.fn(async () => true) },
      true,
    );
    expect(started.restored).toBe(false);
    expect(readDraft(PERSON, SUBJECT)).toBeNull();
  });

  it('says so when the lock cannot be taken again', async () => {
    const { draft, http, toast, hooks } = setup();
    hooks.relock.mockResolvedValue(false);
    draft.edit(docOf(content('Locked out')));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    http
      .expectOne((r) => r.method === 'PUT')
      .flush(...error(409, 'lock-required'));
    await settle();
    expect(hooks.relock).toHaveBeenCalledTimes(1);
    http.expectNone(WC);
    expect(draft.state()).toBe('failed');
    expect(toast.toasts()).toHaveLength(1);
    await draft.retry();
    expect(hooks.relock).toHaveBeenCalledTimes(2);
    http.expectNone(WC);
    expect(toast.toasts()).toHaveLength(1);
  });
});

describe('ModuleDraft: a file the server refuses', () => {
  const PHOTO = `sha256:${'a'.repeat(64)}`;
  const OTHER = `sha256:${'b'.repeat(64)}`;
  const withImage = (text: string, asset = PHOTO): ModuleContent => ({
    ...content(text),
    blocks: [
      ...content(text).blocks,
      { type: 'image', id: 'photo', asset, alt: 'Charging port' },
    ] as ModuleContent['blocks'],
  });
  const refusal = (status: number, code: string, assets: string[]) =>
    [
      { errors: [{ status: String(status), code, meta: { assets } }] },
      { status, statusText: code },
    ] as const;

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    TestBed.inject(ModuleDraft).stop();
    TestBed.inject(HttpTestingController).verify();
  });

  function refusedSave() {
    const all = setup();
    const replaceImage = vi.fn();
    const showBlock = vi.fn();
    const base = content('Before');
    all.draft.start(
      SUBJECT,
      PERSON,
      { content: base, version: 0, baseCommit: 'c0' },
      [],
      docOf(base),
      { ...all.hooks, replaceImage, showBlock },
    );
    return { ...all, replaceImage, showBlock };
  }

  it('names the image, offers its dialog instead of Retry, and sends nothing until it is dealt with', async () => {
    const { draft, http, toast, replaceImage } = refusedSave();
    draft.edit(docOf(withImage('After')));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    http
      .expectOne((r) => r.method === 'PUT')
      .flush(...refusal(422, 'unknown-asset', [PHOTO]));
    await settle();
    expect(draft.state()).toBe('failed');
    expect(draft.failedOnFiles()).toBe(true);
    expect(draft.refused()).toEqual([
      { blockId: 'photo', kind: 'image', label: 'Charging port' },
    ]);
    expect(readDraft(PERSON, SUBJECT)).not.toBeNull();
    const shown = toast.toasts();
    expect(shown).toHaveLength(1);
    expect(shown[0]?.message).toEqual({
      key: 'editor.moduleEditor.save.refused.image',
      params: { name: 'Charging port' },
    });
    expect(shown[0]?.actionLabel).toEqual({
      key: 'editor.moduleEditor.save.refused.replace',
    });
    shown[0]?.onAction?.();
    expect(replaceImage).toHaveBeenCalledWith('photo');
    // Retry, typing on and the timers send nothing while the block still names the file.
    await draft.retry();
    draft.edit(docOf(withImage('After, more')));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 10);
    http.expectNone(WC);
    expect(draft.state()).toBe('failed');
  });

  it('saves by itself once the block naming the file is removed', async () => {
    const { draft, http, toast } = refusedSave();
    draft.edit(docOf(withImage('After')));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    http
      .expectOne((r) => r.method === 'PUT')
      .flush(...refusal(422, 'unknown-asset', [PHOTO]));
    await settle();
    draft.edit(docOf(content('After')));
    expect(draft.refused()).toEqual([]);
    expect(draft.state()).toBe('pending');
    expect(toast.toasts()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    http
      .expectOne((r) => r.method === 'PUT')
      .flush(copyDoc(content('After'), 1));
    await settle();
    expect(draft.state()).toBe('saved');
  });

  it('saves the same text again once the file was uploaded again', async () => {
    const { draft, http } = refusedSave();
    draft.edit(docOf(withImage('After')));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    http
      .expectOne((r) => r.method === 'PUT')
      .flush(...refusal(409, 'asset-deleted', [PHOTO]));
    await settle();
    expect(draft.state()).toBe('failed');
    draft.accepted(OTHER);
    expect(draft.state()).toBe('failed');
    draft.accepted(PHOTO);
    expect(draft.refused()).toEqual([]);
    expect(draft.state()).toBe('pending');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    const put = http.expectOne((r) => r.method === 'PUT');
    expect(put.request.body.data.attributes.content).toEqual(
      withImage('After'),
    );
    put.flush(copyDoc(withImage('After'), 1));
    await settle();
    expect(draft.state()).toBe('saved');
  });

  it('counts several refused files and shows the first one', async () => {
    const { draft, http, toast, showBlock } = refusedSave();
    const two: ModuleContent = {
      ...withImage('After'),
      blocks: [
        ...withImage('After').blocks,
        {
          type: 'attachment',
          id: 'config',
          asset: OTHER,
          name: 'Configuration',
          fileName: 'config.zip',
          mediaType: 'application/zip',
          size: 10,
        },
      ] as ModuleContent['blocks'],
    };
    draft.edit(docOf(two));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    http
      .expectOne((r) => r.method === 'PUT')
      .flush(...refusal(422, 'unknown-asset', [OTHER, PHOTO]));
    await settle();
    expect(draft.refused().map((f) => f.blockId)).toEqual(['photo', 'config']);
    const shown = toast.toasts()[0];
    expect(shown?.message).toEqual({
      key: 'editor.moduleEditor.save.refused.several',
      params: { count: 2 },
    });
    shown?.onAction?.();
    expect(showBlock).toHaveBeenCalledWith('photo');
    // One dealt with: the other is still marked, and nothing is sent.
    draft.accepted(PHOTO);
    expect(draft.refused().map((f) => f.blockId)).toEqual(['config']);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 2);
    http.expectNone(WC);
  });

  it('refuses a save point the same way, without Retry, and no quiet one tries again', async () => {
    const { draft, http, toast } = refusedSave();
    draft.edit(docOf(withImage('After')));
    const point = draft.savePoint();
    await settle();
    http
      .expectOne((r) => r.method === 'PUT')
      .flush(copyDoc(withImage('After'), 1));
    await settle();
    http.expectOne(COMMITS).flush(...refusal(422, 'unknown-asset', [PHOTO]));
    expect(await point).toBe('failed');
    expect(draft.refused()).toEqual([
      { blockId: 'photo', kind: 'image', label: 'Charging port' },
    ]);
    const shown = toast.toasts()[0];
    expect(shown?.message).toEqual({
      key: 'editor.moduleEditor.save.refused.image',
      params: { name: 'Charging port' },
    });
    expect(shown?.actionLabel).not.toEqual({ key: 'editor.session.retry' });
    // The periodic save point leaves it alone.
    await vi.advanceTimersByTimeAsync(SAVE_POINT_MS * 2);
    http.expectNone(COMMITS);
  });

  it('says nothing of a save point refused for a block removed meanwhile, and goes on committing', async () => {
    const { draft, http, toast } = refusedSave();
    draft.edit(docOf(withImage('After')));
    const point = draft.savePoint();
    await settle();
    http
      .expectOne((r) => r.method === 'PUT')
      .flush(copyDoc(withImage('After'), 1));
    await settle();
    const commit = http.expectOne(COMMITS);
    draft.edit(docOf(content('After')));
    commit.flush(...refusal(422, 'unknown-asset', [PHOTO]));
    expect(await point).toBe('failed');
    expect(draft.refused()).toEqual([]);
    expect(toast.toasts()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    http
      .expectOne((r) => r.method === 'PUT')
      .flush(copyDoc(content('After'), 2));
    await settle();
    expect(draft.state()).toBe('saved');
    await vi.advanceTimersByTimeAsync(SAVE_POINT_MS);
    http.expectOne(COMMITS).flush({ data: { type: 'Commit', id: 'c1' } });
    await settle();
  });

  it('offers Retry for a refusal that names no file', async () => {
    const { draft, http, toast } = refusedSave();
    draft.edit(docOf(withImage('After')));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    http
      .expectOne((r) => r.method === 'PUT')
      .flush(...refusal(422, 'unknown-asset', []));
    await settle();
    expect(draft.state()).toBe('failed');
    expect(draft.failedOnFiles()).toBe(false);
    expect(toast.toasts()[0]?.actionLabel).toEqual({
      key: 'editor.session.retry',
    });
  });
});

describe('refused files', () => {
  it('finds the blocks naming them, nested too, by alt text, caption or name', () => {
    const photo = `sha256:${'a'.repeat(64)}`;
    const blocks = [
      {
        type: 'section',
        id: 's',
        title: [{ type: 'text', text: 'S' }],
        blocks: [
          {
            type: 'image',
            id: 'one',
            asset: photo,
            alt: '  ',
            title: [{ type: 'text', text: 'Port\nview' }],
          },
        ],
      },
      { type: 'image', id: 'two', asset: `sha256:${'c'.repeat(64)}`, alt: 'x' },
      {
        type: 'attachment',
        id: 'three',
        asset: photo,
        name: '',
        fileName: 'config.zip',
        mediaType: 'application/zip',
        size: 1,
      },
    ];
    expect(refusedFiles(blocks, new Set([photo]))).toEqual([
      { blockId: 'one', kind: 'image', label: 'Port view' },
      { blockId: 'three', kind: 'attachment', label: 'config.zip' },
    ]);
  });

  it('reads the refused files from the error, only for the codes that refuse them', () => {
    const errors = [{ status: '422', meta: { assets: ['sha256:a', 3] } }];
    expect(refusedAssets({ code: 'unknown-asset', errors } as never)).toEqual([
      'sha256:a',
    ]);
    expect(refusedAssets({ code: 'too-large', errors } as never)).toBeNull();
    expect(
      refusedAssets({
        code: 'unknown-asset',
        errors: [{ status: '422' }],
      } as never),
    ).toBeNull();
  });
});

describe('local drafts', () => {
  it('are kept apart per person', () => {
    expect(draftKey('a', SUBJECT)).not.toBe(draftKey('b', SUBJECT));
  });
});
