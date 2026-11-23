import {
  MAX_TEMPLATE_BYTES,
  MAX_TEMPLATE_FILE_BYTES,
  PageDesign,
  type Module,
} from '@openfolia/content-model';
import { actorWith } from '../../../../tests/fakes/actors.js';
import { FakeAssetUploads } from '../../../../tests/fakes/fake-asset-uploads.js';
import { FakeChangeSetStore } from '../../../../tests/fakes/fake-change-set-store.js';
import {
  type FakeContent,
  FakeSnapshot,
  manifest,
  module,
} from '../../../../tests/fakes/fake-content.js';
import { FakeUnitOfWork } from '../../../../tests/fakes/fake-unit-of-work.js';
import { FakeWorkingCopyStore } from '../../../../tests/fakes/fake-working-copy-store.js';
import type { Actor, Scope } from '../../../access/core/actor.js';
import type { Permission } from '../../../access/core/permissions.js';
import {
  ForbiddenError,
  InvalidContentError,
  NotFoundError,
} from '../../../base/core/errors.js';
import { ReadableContent } from '../../../content/core/readable-content.js';
import {
  type ChangeSet,
  changeSetBranch,
  newChangeSetId,
} from '../change-set.js';
import type { LockSubject } from '../lock.js';
import type { WorkingCopyContent } from '../working-copy.js';
import {
  LIVE_PREVIEW_AUTHOR_ONLY,
  OpenWorkingCopiesAction,
} from './open-working-copies.action.js';

const EDITING: Permission[] = [
  'content.read',
  'content.read.draft',
  'content.edit',
];
const editor = (scope: Scope = {}, id = 'live-author'): Actor => ({
  ...actorWith(EDITING, scope),
  id,
});
const author = editor();
/** An author without `content.read.draft`: their own branch only (#126). */
const ownOnly: Actor = {
  ...actorWith(['content.read', 'content.edit']),
  id: 'live-author',
};
const draftReader = editor({}, 'live-reviewer');
const stranger: Actor = {
  ...actorWith(['content.read', 'content.edit']),
  id: 'live-stranger',
};

const HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);

const withText = (id: string, text: string, lang = 'en'): Module =>
  module(id, lang, text);

const withRef = (id: string, target: string): Module => ({
  ...module(id),
  blocks: [{ type: 'moduleRef', id: 'ref', module: target }],
});

const withImage = (id: string, hash: string): Module => ({
  ...module(id),
  blocks: [
    { type: 'image', id: 'img', asset: `sha256:${hash}`, alt: 'Picture' },
  ],
});

function setUp(content: FakeContent = {}) {
  const id = newChangeSetId();
  const now = new Date();
  const mine: ChangeSet = {
    id,
    title: 'Live',
    description: null,
    author: { kind: 'user', id: author.id },
    baseRef: 'main',
    baseCommit: 'a'.repeat(40),
    baseReleased: true,
    branch: changeSetBranch(id),
    state: 'draft',
    createdAt: now,
    updatedAt: now,
  };
  const branch = new FakeSnapshot(content);
  const copies = new FakeWorkingCopyStore();
  const uploads = new FakeAssetUploads();
  const unit = new FakeUnitOfWork();
  const action = new OpenWorkingCopiesAction(
    new FakeChangeSetStore([mine]),
    copies,
    unit,
    uploads,
  );
  const save = (subject: LockSubject, saved: WorkingCopyContent) =>
    unit.run((tx) =>
      copies.save(
        tx,
        {
          changeSetId: id,
          subject,
          content: saved,
          baseCommit: branch.commit,
          updatedBy: { kind: 'user', id: author.id },
        },
        0,
      ),
    );
  const open = (actor: Actor = author, permission = 'content.read.draft') =>
    action.handle({
      actor,
      snapshot: new ReadableContent(
        branch,
        actor,
        permission as 'content.read.draft',
      ),
      changeSetId: id,
    });
  return { mine, branch, copies, unit, uploads, save, open };
}

const moduleSubject = (moduleId: string, lang = 'en'): LockSubject => ({
  type: 'module',
  lang,
  moduleId,
});

describe('OpenWorkingCopiesAction', () => {
  it('reads a module’s working copy in place of its file, and the file where there is none', async () => {
    const t = setUp({
      modules: [withText('charging', 'Committed.'), withText('other', 'Kept.')],
    });
    await t.save(moduleSubject('charging'), withText('charging', 'Typed.'));
    const { content } = await t.open();
    expect(await content.module('charging', 'en')).toEqual(
      withText('charging', 'Typed.'),
    );
    expect(await content.module('other', 'en')).toEqual(
      withText('other', 'Kept.'),
    );
    const resolved = await content.resolveModule('charging', {}, 'en');
    expect(JSON.stringify(resolved?.manual.entries)).toContain('Typed.');
    // The branch itself is read as before.
    const committed = new ReadableContent(
      t.branch,
      author,
      'content.read.draft',
    );
    expect(await committed.module('charging', 'en')).toEqual(
      withText('charging', 'Committed.'),
    );
  });

  it('follows module references to their own working copies, else to the branch', async () => {
    const t = setUp({
      modules: [
        withRef('charging', 'safety'),
        withText('safety', 'Committed safety.'),
        withText('cooling', 'Committed cooling.'),
      ],
    });
    await t.save(moduleSubject('safety'), withRef('safety', 'cooling'));
    const { content } = await t.open();
    const text = JSON.stringify(
      (await content.resolveModule('charging', {}, 'en'))?.manual.entries,
    );
    expect(text).not.toContain('Committed safety.');
    expect(text).toContain('Committed cooling.');
    // A working copy of a module the branch does not have yet is read and listed too.
    await t.save(moduleSubject('cooling'), withRef('cooling', 'fresh'));
    await t.save(moduleSubject('fresh'), withText('fresh', 'New module.'));
    const again = await t.open();
    const fresh = JSON.stringify(
      (await again.content.resolveModule('charging', {}, 'en'))?.manual.entries,
    );
    expect(fresh).toContain('New module.');
    expect(
      (await again.content.modules('en')).map((m) => 'module' in m && m.id),
    ).toEqual(['charging', 'cooling', 'safety', 'fresh']);
  });

  it('reads a manual’s working copy (its manifest) in place of its file', async () => {
    const t = setUp({
      modules: [withText('a', 'A.'), withText('b', 'B.')],
      manifests: [manifest('op', ['a'])],
    });
    await t.save({ type: 'manual', manualId: 'op' }, manifest('op', ['b']));
    const { content } = await t.open();
    const resolved = await content.resolve('op', { model: 'large' }, 'en');
    const text = JSON.stringify(resolved?.manual.entries);
    expect(text).toContain('B.');
    expect(text).not.toContain('A.');
  });

  it('answers another author’s change set as reading its working copies does: 403 for a reader of drafts, 404 for anyone else', async () => {
    const t = setUp({ modules: [withText('charging', 'Committed.')] });
    await expect(t.open(draftReader)).rejects.toEqual(
      new ForbiddenError(LIVE_PREVIEW_AUTHOR_ONLY),
    );
    const refused = await t.open(stranger, 'content.read').catch((e) => e);
    expect(refused).toBeInstanceOf(NotFoundError);
    expect((refused as NotFoundError).message).toBe(
      `No change set "${t.mine.id}".`,
    );
  });

  it('opens for an author without content.read.draft, through their content.read scope', async () => {
    const t = setUp({ modules: [withText('charging', 'Committed.')] });
    await t.save(moduleSubject('charging'), withText('charging', 'Mine.'));
    const { content } = await t.open(ownOnly, 'content.read');
    expect(await content.module('charging', 'en')).toEqual(
      withText('charging', 'Mine.'),
    );
  });

  it('shows no working copy outside the author’s scope', async () => {
    const t = setUp({ modules: [withText('charging', 'Committed.')] });
    await t.save(moduleSubject('charging'), withText('charging', 'Typed.'));
    // Their roles changed since: they read German only.
    const scoped: Actor = { ...editor({ languages: ['de'] }), id: author.id };
    const { content } = await t.open(scoped);
    expect(await content.module('charging', 'en')).toBeUndefined();
    expect(await content.resolveModule('charging', {}, 'en')).toBeUndefined();
  });

  it('reads images the branch shows and those uploaded into the change set, nothing else', async () => {
    const t = setUp({
      modules: [withImage('shown', HASH)],
      assets: {
        [HASH]: new Uint8Array([1]),
        [OTHER_HASH]: new Uint8Array([2]),
      },
    });
    await t.save(moduleSubject('typed'), withImage('typed', OTHER_HASH));
    const before = await t.open();
    expect(before.uploaded.size).toBe(0);
    const resolution = await before.content.resolveModule('typed', {}, 'en');
    if (!resolution) throw new Error('not resolved');
    const source = before.content.renderSource(resolution);
    // Named only by a working copy, uploaded nowhere: not read.
    expect(await source.asset(OTHER_HASH)).toBeUndefined();
    t.uploads.uploads.push({
      changeSetId: t.mine.id,
      sha256: OTHER_HASH,
      size: 1,
      contentType: 'image/png',
      uploadedBy: { kind: 'user', id: author.id },
      uploadedAt: new Date(),
      lastUploadedAt: new Date(),
    });
    const after = await t.open();
    expect([...after.uploaded]).toEqual([OTHER_HASH]);
    const again = await after.content.resolveModule('typed', {}, 'en');
    if (!again) throw new Error('not resolved');
    expect(await after.content.renderSource(again).asset(OTHER_HASH)).toEqual(
      new Uint8Array([2]),
    );
  });

  it('reads a page design’s working copy in place of its file, a new one too (#392)', async () => {
    const yaml = (name: string, logo?: string) =>
      [
        'schemaVersion: 1',
        `name: ${name}`,
        'preset: minimal',
        'colours:',
        '  primary: "#1f4e79"',
        '  accent: "#b45309"',
        '  text: "#1f2328"',
        ...(logo ? ['logo:', `  light: sha256:${logo}`] : []),
        '',
      ].join('\n');
    const t = setUp({
      modules: [withText('a', 'A.')],
      manifests: [manifest('op', ['a'])],
      pageDesigns: { brand: yaml('Committed', HASH), other: yaml('Other') },
      assets: {
        [HASH]: new Uint8Array([1]),
        [OTHER_HASH]: new Uint8Array([2]),
      },
    });
    const draft = (id: string, name: string, logo: string) =>
      PageDesign.parse({
        schemaVersion: 1,
        id,
        name,
        preset: 'classic',
        colours: { primary: '#000000', accent: '#111111', text: '#222222' },
        logo: { light: `sha256:${logo}` },
      });
    await t.save(
      { type: 'design', designId: 'brand' },
      draft('brand', 'Typed', HASH),
    );
    await t.save(
      { type: 'design', designId: 'fresh' },
      draft('fresh', 'New', OTHER_HASH),
    );
    const { content } = await t.open();
    expect((await content.pageDesign('brand'))?.name).toBe('Typed');
    expect((await content.pageDesign('other'))?.name).toBe('Other');
    expect((await content.pageDesign('fresh'))?.name).toBe('New');
    expect((await content.pageDesigns()).map((d) => d.id)).toEqual([
      'brand',
      'fresh',
      'other',
    ]);
    const resolved = await content.resolve('op', { model: 'large' }, 'en', {
      design: 'brand',
    });
    if (!resolved) throw new Error('not resolved');
    expect(resolved.design?.name).toBe('Typed');
    // A file a committed design names is every reader's: the preview shows it.
    expect(await content.renderSource(resolved).asset(HASH)).toEqual(
      new Uint8Array([1]),
    );
    // One only a working copy names, uploaded nowhere: not read.
    const fresh = await content.resolve('op', { model: 'large' }, 'en', {
      design: 'fresh',
    });
    if (!fresh) throw new Error('not resolved');
    expect(fresh.design?.name).toBe('New');
    expect(await content.renderSource(fresh).asset(OTHER_HASH)).toBeUndefined();
    // The branch itself reads its files.
    const committed = new ReadableContent(
      t.branch,
      author,
      'content.read.draft',
    );
    expect((await committed.pageDesign('brand'))?.name).toBe('Committed');
    expect(await committed.pageDesign('fresh')).toBeUndefined();
  });

  it('refuses a template whose drafts grew past the caps since their lengths were listed, never giving part of them (#803)', async () => {
    const t = setUp({ designTemplates: { house: { 'manual.typ': '// x\n' } } });
    const count = Math.ceil(MAX_TEMPLATE_BYTES / MAX_TEMPLATE_FILE_BYTES) + 1;
    const subject = (i: number): LockSubject => ({
      type: 'template',
      templateId: 'house',
      path: `f${i}.typ`,
    });
    for (let i = 0; i < count; i++) {
      await t.save(subject(i), { schemaVersion: 1, text: 'x' });
    }
    const { content } = await t.open();
    // Their lengths are listed now (one byte each): within the caps.
    expect(
      (await content.designTemplateListing('house')).filter((f) => f.draft),
    ).toHaveLength(count);
    // Saved longer meanwhile.
    const long = 'y'.repeat(MAX_TEMPLATE_FILE_BYTES);
    for (let i = 0; i < count; i++) {
      await t.unit.run((tx) =>
        t.copies.save(
          tx,
          {
            changeSetId: t.mine.id,
            subject: subject(i),
            content: { schemaVersion: 1, text: long },
            baseCommit: t.branch.commit,
            updatedBy: { kind: 'user', id: author.id },
          },
          1,
        ),
      );
    }
    await expect(content.designTemplate('house')).rejects.toBeInstanceOf(
      InvalidContentError,
    );
  });

  it('keeps its reading key apart from the branch’s', async () => {
    const t = setUp({ modules: [withText('charging', 'Committed.')] });
    const { content } = await t.open();
    const committed = new ReadableContent(
      t.branch,
      author,
      'content.read.draft',
    );
    expect(content.commit).toBe(committed.commit);
    expect(content.readingKey).not.toBe(committed.readingKey);
    expect(content.readingKey).toContain(t.mine.id);
  });
});
