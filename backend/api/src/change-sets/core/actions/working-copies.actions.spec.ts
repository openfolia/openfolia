import { FakeRefreshConflicts } from '../../../../tests/fakes/fake-refresh-conflicts.js';
import { MAX_FILES_PER_WORKING_COPY } from '../../../assets/core/file-references.js';
import { FakeAssetUploads } from '../../../../tests/fakes/fake-asset-uploads.js';
import { ReadableAssets } from '../../../assets/core/readable-assets.js';
import { FakeChangeSetEvents } from '../../../../tests/fakes/fake-change-set-events.js';
import {
  MAX_TEMPLATE_BYTES,
  MAX_TEMPLATE_FILES,
  type Module,
  ProjectConfig,
} from '@openfolia/content-model';
import { actorWith } from '../../../../tests/fakes/actors.js';
import { FakeAuditLog } from '../../../../tests/fakes/fake-audit-log.js';
import { FakeChangeSetBranches } from '../../../../tests/fakes/fake-change-set-branches.js';
import { FakeChangeSetStore } from '../../../../tests/fakes/fake-change-set-store.js';
import {
  config as baseConfig,
  type FakeContent,
  FakeSnapshot,
  manifest,
  module,
} from '../../../../tests/fakes/fake-content.js';
import { FakeLockStore } from '../../../../tests/fakes/fake-lock-store.js';
import { FakeUnitOfWork } from '../../../../tests/fakes/fake-unit-of-work.js';
import { FakeWorkingCopyStore } from '../../../../tests/fakes/fake-working-copy-store.js';
import type { Actor, Scope } from '../../../access/core/actor.js';
import type { Permission } from '../../../access/core/permissions.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
} from '../../../base/core/errors.js';
import { ChangeSetAuthoredBranches } from '../change-set-authored-branches.js';
import { OpenSnapshotAction } from '../../../content/core/actions/open-snapshot.action.js';
import {
  ContentRepository,
  type ContentSnapshot,
} from '../../../content/core/content.repository.js';
import {
  type ChangeSet,
  changeSetBranch,
  newChangeSetId,
} from '../change-set.js';
import { type LockSubject, newLockId } from '../lock.js';
import {
  MAX_WORKING_COPIES_PER_CHANGE_SET,
  MAX_WORKING_COPY_BYTES,
} from '../working-copy.js';
import { AbandonChangeSetAction } from './abandon-change-set.action.js';
import { DiscardWorkingCopyAction } from './discard-working-copy.action.js';
import { GetWorkingCopyAction } from './get-working-copy.action.js';
import { SaveWorkingCopyAction } from './save-working-copy.action.js';

const EDITING: Permission[] = [
  'content.read',
  'content.read.draft',
  'content.edit',
];
const editor = (scope: Scope = {}, id = 'sample-author'): Actor => ({
  ...actorWith(EDITING, scope),
  id,
});
const author = editor();
const other = editor({}, 'sample-other');
/** The author, editing concepts only. */
const narrowAuthor = editor({ moduleTypes: ['concept'] });

const charging: LockSubject = {
  type: 'module',
  lang: 'en',
  moduleId: 'charging',
};
const operating: LockSubject = { type: 'manual', manualId: 'operating' };

/** `main` and every change set's branch, each at a commit of its own. */
class FakeRepository extends ContentRepository {
  readonly branches = new Map<string, ContentSnapshot>();
  main: ContentSnapshot = new FakeSnapshot();

  at(ref: string): Promise<ContentSnapshot | undefined> {
    return Promise.resolve(ref === 'main' ? this.main : this.branches.get(ref));
  }

  refs() {
    return Promise.resolve({
      branches: [
        { name: 'main', commit: this.main.commit },
        ...[...this.branches].map(([name, s]) => ({
          name,
          commit: s.commit,
        })),
      ],
      tags: [],
    });
  }
}

/**
 * `released`: the branch is still at `main`'s commit, as a new change
 * set's is, so it is read as released content (`content.read`).
 */
function setUp(content: FakeContent = {}, { released = false } = {}) {
  const id = newChangeSetId();
  const now = new Date();
  const mine: ChangeSet = {
    id,
    title: 'x',
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
  const repository = new FakeRepository();
  const branch = new FakeSnapshot(content);
  repository.branches.set(mine.branch, branch);
  if (released) repository.main = branch;
  const changeSets = new FakeChangeSetStore([mine]);
  const locks = new FakeLockStore();
  const copies = new FakeWorkingCopyStore();
  const audit = new FakeAuditLog();
  const unit = new FakeUnitOfWork();
  const assets = new FakeAssetUploads();
  const open = new OpenSnapshotAction(
    repository,
    new ChangeSetAuthoredBranches(changeSets),
  );
  const branches = new FakeChangeSetBranches();
  branches.heads.set(mine.branch, branch.commit);
  const lock = (subject: LockSubject, changeSetId = id) =>
    locks.locks.push({
      id: newLockId(),
      subject,
      changeSetId,
      holder: { kind: 'user', id: author.id },
      since: now,
    });
  return {
    mine,
    branch,
    changeSets,
    locks,
    copies,
    audit,
    unit,
    lock,
    assets,
    save: new SaveWorkingCopyAction(
      changeSets,
      locks,
      copies,
      open,
      branches,
      unit,
      assets,
      new ReadableAssets(assets),
      new FakeRefreshConflicts(),
    ),
    /** Records an upload of `sha256` into a change set `by` is the author of. */
    uploaded: (sha256: string, by: Actor = author, changeSetId = id) =>
      unit.run((tx) =>
        assets.record(tx, {
          changeSetId,
          sha256,
          size: 1,
          contentType: 'image/png',
          uploadedBy: { kind: by.kind, id: by.id },
        }),
      ),
    repository,
    open,
    get: new GetWorkingCopyAction(changeSets, copies, open),
    discard: new DiscardWorkingCopyAction(
      changeSets,
      copies,
      unit,
      new FakeRefreshConflicts(),
    ),
    abandon: new AbandonChangeSetAction(
      changeSets,
      locks,
      copies,
      audit,
      new FakeChangeSetEvents(),
      unit,
    ),
  };
}

const edited = (text: string): Module => module('charging', 'en', text);

describe('SaveWorkingCopyAction', () => {
  it('refuses a copy naming more than MAX_FILES_PER_WORKING_COPY files (422), before locking any', async () => {
    const t = setUp();
    t.lock(charging);
    const content: Module = {
      ...edited('Many pictures'),
      blocks: Array.from(
        { length: MAX_FILES_PER_WORKING_COPY + 1 },
        (_, n) => ({
          type: 'image' as const,
          id: `p${n}`,
          asset: `sha256:${n.toString(16).padStart(64, '0')}`,
          alt: 'x',
        }),
      ),
    };
    await expect(
      t.save.handle({
        actor: author,
        changeSetId: t.mine.id,
        subject: charging,
        content,
        version: 0,
      }),
    ).rejects.toMatchObject({
      code: 'too-many-files',
      meta: { max: MAX_FILES_PER_WORKING_COPY },
    });
    expect(t.assets.lockedHashes).toEqual([]);
  });

  it('refuses a copy naming a file deleted as unused, under that file’s lock (#255)', async () => {
    const t = setUp();
    t.lock(charging);
    const hash = 'e'.repeat(64);
    // Uploaded by the author, then deleted between the scope check and the
    // save's transaction.
    await t.uploaded(hash);
    t.assets.deleted.add(hash);
    const content: Module = {
      ...edited('With a picture'),
      blocks: [{ type: 'image', id: 'p', asset: `sha256:${hash}`, alt: 'x' }],
    };
    const input = {
      actor: author,
      changeSetId: t.mine.id,
      subject: charging,
      content,
      version: 0,
    };
    await expect(t.save.handle(input)).rejects.toMatchObject({
      code: 'asset-deleted',
      meta: { assets: [`sha256:${hash}`] },
    });
    expect(t.assets.lockedHashes).toContain(hash);
    expect(t.copies.copies.size).toBe(0);
    // Text that only mentions a hash names no file.
    t.assets.lockedHashes.length = 0;
    await expect(
      t.save.handle({ ...input, content: edited(`sha256:${hash}`) }),
    ).resolves.toMatchObject({ version: 1 });
    expect(t.assets.lockedHashes).toEqual([]);
    await t.discard.handle({
      actor: author,
      changeSetId: t.mine.id,
      subject: charging,
    });
    // Uploaded again: the mark is gone, and the save goes through.
    t.assets.deleted.delete(hash);
    await expect(t.save.handle(input)).resolves.toMatchObject({ version: 1 });
  });

  describe('the files it names (#335)', () => {
    const image = (id: string, hash: string) => ({
      type: 'image' as const,
      id,
      asset: `sha256:${hash}`,
      alt: 'x',
    });
    const naming = (...hashes: string[]): Module => ({
      ...edited('With pictures'),
      blocks: hashes.map((hash, n) => image(`i${n}`, hash)),
    });
    const onBranch = 'b'.repeat(64);
    const onBase = 'c'.repeat(64);
    const own = 'd'.repeat(64);
    const others = '1'.repeat(64);
    const hidden = '2'.repeat(64);
    const missing = '3'.repeat(64);

    async function scoped() {
      const t = setUp({
        modules: [
          module('charging'),
          { ...module('safety'), blocks: [image('a', onBranch)] },
          // A task: outside the scope of an editor of concepts only.
          {
            ...module('hidden'),
            meta: { ...module('hidden').meta, type: 'task' },
            blocks: [image('a', hidden)],
          },
        ],
      });
      // `main` moved on since: a module added there uses another file.
      t.repository.main = new FakeSnapshot({
        modules: [{ ...module('newer'), blocks: [image('a', onBase)] }],
      });
      await t.uploaded(own);
      const otherSet = newChangeSetId();
      t.assets.authors.set(otherSet, { kind: 'user', id: other.id });
      await t.uploaded(others, other, otherSet);
      t.lock(charging);
      return t;
    }
    const input = (
      t: ReturnType<typeof setUp>,
      content: Module,
      actor = author,
    ) => ({
      actor,
      changeSetId: t.mine.id,
      subject: charging,
      content,
      version: 0,
    });

    it('takes a file used on the branch or at its base, or uploaded into a change set of the author', async () => {
      const t = await scoped();
      await expect(
        t.save.handle(input(t, naming(onBranch, onBase, own))),
      ).resolves.toMatchObject({ version: 1 });
    });

    it('refuses another author’s upload, a file only hidden content uses and a missing one alike, before any lock', async () => {
      const t = await scoped();
      const answers = [];
      for (const hash of [others, hidden, missing]) {
        const error = await t.save
          .handle(input(t, naming(own, hash), narrowAuthor))
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(UnprocessableError);
        answers.push(error as UnprocessableError);
      }
      for (const [n, error] of answers.entries()) {
        const hash = [others, hidden, missing][n] as string;
        expect(error).toMatchObject({
          code: 'unknown-asset',
          meta: { assets: [`sha256:${hash}`] },
        });
        expect(error.message).toBe(answers[0]?.message);
      }
      expect(t.assets.lockedHashes).toEqual([]);
      expect(t.copies.copies.size).toBe(0);
    });

    it('never counts a file another working copy of the change set names', async () => {
      const t = await scoped();
      const safety: LockSubject = {
        type: 'module',
        lang: 'en',
        moduleId: 'safety',
      };
      t.lock(safety);
      // Saved before this rule, say: a draft does not vouch for its files.
      await t.unit.run((tx) =>
        t.copies.save(
          tx,
          {
            changeSetId: t.mine.id,
            subject: safety,
            content: { ...module('safety'), blocks: [image('a', others)] },
            baseCommit: t.branch.commit,
            updatedBy: { kind: 'user', id: author.id },
          },
          0,
        ),
      );
      await expect(
        t.save.handle(input(t, naming(others))),
      ).rejects.toMatchObject({ code: 'unknown-asset' });
    });

    it('reads the base only when the branch and the uploads leave a file undecided, and takes nothing from a base that does not open', async () => {
      const t = await scoped();
      const opened = vi.spyOn(t.open, 'handle');
      await t.save.handle(input(t, naming(onBranch, own)));
      expect(opened.mock.calls.map(([i]) => i.ref)).toEqual([t.mine.branch]);
      // A base that does not open (gone) adds nothing, and is no error.
      const at = t.repository.at.bind(t.repository);
      vi.spyOn(t.repository, 'at').mockImplementation((ref) =>
        ref === 'main' ? Promise.resolve(undefined) : at(ref),
      );
      await expect(
        t.save.handle({ ...input(t, naming(onBase)), version: 1 }),
      ).rejects.toMatchObject({ code: 'unknown-asset' });
      await expect(
        t.save.handle({ ...input(t, naming(own)), version: 1 }),
      ).resolves.toMatchObject({ version: 2 });
    });
  });

  it('saves a thousand times without a commit or an audit event', async () => {
    const t = setUp();
    t.lock(charging);
    const first = await t.save.handle({
      actor: author,
      changeSetId: t.mine.id,
      subject: charging,
      content: edited('v1'),
      version: 0,
    });
    expect(first).toMatchObject({
      version: 1,
      baseCommit: t.branch.commit,
      updatedBy: { kind: 'user', id: author.id },
      issues: [],
    });
    let version = first.version;
    for (let i = 0; i < 999; i++) {
      ({ version } = await t.save.handle({
        actor: author,
        changeSetId: t.mine.id,
        subject: charging,
        content: edited(`v${i + 2}`),
        version,
      }));
    }
    expect(version).toBe(1000);
    expect(t.audit.events).toEqual([]);
    const read = await t.get.handle({
      actor: author,
      changeSetId: t.mine.id,
      subject: charging,
    });
    expect(read.version).toBe(1000);
    expect(read.content).toEqual(edited('v1000'));
    // The base commit stays the first save's.
    expect(read.baseCommit).toBe(t.branch.commit);
  });

  it('returns validation issues without refusing a draft', async () => {
    const t = setUp();
    t.lock(charging);
    const draft = {
      ...edited('x'),
      meta: { ...edited('x').meta, type: 'nope' },
    };
    const saved = await t.save.handle({
      actor: author,
      changeSetId: t.mine.id,
      subject: charging,
      content: draft,
      version: 0,
    });
    expect(saved.version).toBe(1);
    expect(saved.issues.map((i) => i.code)).toContain('unknown-module-type');
  });

  it('refuses a stale save with the current version, and overwrites nothing', async () => {
    const t = setUp();
    t.lock(charging);
    const input = {
      actor: author,
      changeSetId: t.mine.id,
      subject: charging,
    };
    await t.save.handle({ ...input, content: edited('a'), version: 0 });
    await t.save.handle({ ...input, content: edited('b'), version: 1 });
    for (const version of [0, 1, 3]) {
      const refused = await t.save
        .handle({ ...input, content: edited('stale'), version })
        .catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(ConflictError);
      expect(refused).toMatchObject({
        code: 'version-conflict',
        meta: { version: 2 },
      });
    }
    const missing = await t.save
      .handle({
        ...input,
        subject: { ...charging, moduleId: 'other' },
        content: module('other', 'en'),
        version: 4,
      })
      .catch((e: unknown) => e);
    // No lock on that one: the lock is checked first.
    expect(missing).toMatchObject({ code: 'lock-required' });
    expect((await t.get.handle(input)).content).toEqual(edited('b'));
  });

  it('needs the lock, held by this change set', async () => {
    const t = setUp();
    const input = {
      actor: author,
      changeSetId: t.mine.id,
      subject: charging,
      content: edited('x'),
      version: 0,
    };
    await expect(t.save.handle(input)).rejects.toMatchObject({
      code: 'lock-required',
    });
    t.lock(charging, newChangeSetId());
    await expect(t.save.handle(input)).rejects.toMatchObject({
      code: 'lock-required',
    });
    expect(t.copies.copies.size).toBe(0);
  });

  it('is for the author of a draft change set only', async () => {
    const t = setUp();
    t.lock(charging);
    const input = {
      changeSetId: t.mine.id,
      subject: charging,
      content: edited('x'),
      version: 0,
    };
    await expect(
      t.save.handle({ ...input, actor: other }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      t.save.handle({ ...input, actor: author, changeSetId: newChangeSetId() }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      t.save.handle({ ...input, actor: actorWith(['content.read.draft']) }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await t.unit.run((tx) => t.changeSets.setState(tx, t.mine.id, 'in-review'));
    await expect(
      t.save.handle({ ...input, actor: author }),
    ).rejects.toMatchObject({
      code: 'invalid-state',
      meta: { state: 'in-review' },
    });
  });

  it('refuses content of another subject, and too much of it', async () => {
    const t = setUp();
    t.lock(charging);
    const input = { actor: author, changeSetId: t.mine.id, subject: charging };
    for (const content of [module('other', 'en'), module('charging', 'de')]) {
      await expect(
        t.save.handle({ ...input, content, version: 0 }),
      ).rejects.toMatchObject({ code: 'subject-mismatch' });
    }
    await expect(
      t.save.handle({
        ...input,
        content: edited('x'.repeat(MAX_WORKING_COPY_BYTES)),
        version: 0,
      }),
    ).rejects.toSatisfy(
      (e) =>
        e instanceof UnprocessableError &&
        e.code === 'too-large' &&
        e.meta?.['max'] === MAX_WORKING_COPY_BYTES,
    );
  });

  it('keeps a module within what the actor may edit, new and committed', async () => {
    const restricted = editor({ moduleTypes: ['task'] });
    // The new content is outside the scope.
    const t = setUp();
    t.lock(charging);
    await expect(
      t.save.handle({
        actor: restricted,
        changeSetId: t.mine.id,
        subject: charging,
        content: edited('x'),
        version: 0,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    // The new content is within it, the committed file is not (but may
    // be read: the draft-read role is wider than the edit role).
    const wider: Actor = {
      ...author,
      roles: [
        {
          id: 'r',
          name: 'r',
          permissions: ['content.read', 'content.read.draft'],
          scope: {},
        },
        {
          id: 'e',
          name: 'e',
          permissions: ['content.edit'],
          scope: { moduleTypes: ['task'] },
        },
      ],
    };
    const c = setUp({ modules: [edited('committed')] });
    c.lock(charging);
    const asTask = {
      ...edited('x'),
      meta: { ...edited('x').meta, type: 'task' },
    };
    await expect(
      c.save.handle({
        actor: wider,
        changeSetId: c.mine.id,
        subject: charging,
        content: asTask,
        version: 0,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('refuses a manual whose committed manifest names modules the actor may not see', async () => {
    const hidden = {
      ...module('internal-only'),
      meta: { ...module('internal-only').meta, type: 'secret' },
    };
    const t = setUp({
      modules: [hidden, edited('x')],
      manifests: [manifest('operating', ['charging', 'internal-only'])],
    });
    t.lock(operating);
    const narrow = editor({ moduleTypes: ['concept'] });
    const input = {
      changeSetId: t.mine.id,
      subject: operating,
      content: manifest('operating', ['charging']),
      version: 0,
    };
    await expect(
      t.save.handle({ ...input, actor: narrow }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // Seeing all of it, the author may.
    const saved = await t.save.handle({ ...input, actor: author });
    expect(saved).toMatchObject({ version: 1, subject: operating });
  });

  it('checks a committed module hidden from the actor, never skipping it as missing', async () => {
    const secret = {
      ...edited('committed'),
      meta: { ...edited('committed').meta, type: 'secret' },
    };
    const t = setUp({ modules: [secret] });
    t.lock(charging);
    const narrow = editor({ moduleTypes: ['concept'] });
    const refused = await t.save
      .handle({
        actor: narrow,
        changeSetId: t.mine.id,
        subject: charging,
        content: edited('overwrite'),
        version: 0,
      })
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ForbiddenError);
    // The same answer as for a module they see but may not edit.
    const visible = setUp({ modules: [edited('committed')] });
    visible.lock(charging);
    const readOnly: Actor = {
      ...author,
      roles: [
        {
          id: 'r',
          name: 'r',
          permissions: ['content.read', 'content.read.draft'],
          scope: {},
        },
        {
          id: 'e',
          name: 'e',
          permissions: ['content.edit'],
          scope: { moduleTypes: ['task'] },
        },
      ],
    };
    const also = await visible.save
      .handle({
        actor: readOnly,
        changeSetId: visible.mine.id,
        subject: charging,
        content: {
          ...edited('x'),
          meta: { ...edited('x').meta, type: 'task' },
        },
        version: 0,
      })
      .catch((e: unknown) => e);
    expect((also as Error).message).toBe((refused as Error).message);
    expect(t.copies.copies.size + visible.copies.copies.size).toBe(0);
  });

  it('keeps a manual within what the actor may edit, committed and new, hidden or not', async () => {
    const config = ProjectConfig.parse({
      ...baseConfig,
      audiences: [
        { id: 'public', label: 'Public' },
        { id: 'internal', label: 'Internal' },
      ],
    });
    const internal = { ...manifest('operating', []), audience: 'internal' };
    const t = setUp({
      config,
      manifests: [{ ...internal, entries: [{ module: 'charging' }] }],
    });
    t.lock(operating);
    const publicOnly = editor({ maxAudience: 'public' });
    const input = {
      changeSetId: t.mine.id,
      subject: operating,
      content: manifest('operating', ['charging']),
      version: 0,
    };
    // The committed manual is hidden from them: still refused.
    await expect(
      t.save.handle({ ...input, actor: publicOnly }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // Reading internal, editing public only: roles never combine.
    const readsMore: Actor = {
      ...author,
      roles: [
        {
          id: 'r',
          name: 'r',
          permissions: ['content.read', 'content.read.draft'],
          scope: {},
        },
        {
          id: 'e',
          name: 'e',
          permissions: ['content.edit'],
          scope: { maxAudience: 'public' },
        },
      ],
    };
    await expect(
      t.save.handle({ ...input, actor: readsMore }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // A new manual with an audience above the edit role.
    const n = setUp({ config });
    n.lock(operating);
    await expect(
      n.save.handle({
        ...input,
        changeSetId: n.mine.id,
        actor: publicOnly,
        content: internal,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(t.copies.copies.size + n.copies.copies.size).toBe(0);
  });

  it('answers a missing module and a hidden one alike', async () => {
    const secret = {
      ...module('hidden'),
      meta: { ...module('hidden').meta, type: 'secret' },
    };
    const t = setUp({ modules: [secret] });
    const narrow = editor({ moduleTypes: ['concept'] });
    const refusal = async (moduleId: string) => {
      const subject: LockSubject = { type: 'module', lang: 'en', moduleId };
      t.lock(subject);
      const error = await t.save
        .handle({
          actor: narrow,
          changeSetId: t.mine.id,
          subject,
          content: module(moduleId),
          version: 0,
        })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ForbiddenError);
      return (error as ForbiddenError).message;
    };
    expect(await refusal('hidden')).toBe(await refusal('missing'));
    // Creating one takes a role over all of the language.
    const created = await t.save.handle({
      actor: author,
      changeSetId: t.mine.id,
      subject: { type: 'module', lang: 'en', moduleId: 'missing' },
      content: module('missing'),
      version: 0,
    });
    expect(created.version).toBe(1);
  });

  it('refuses a manual hiding entries from a reader without content.read.draft', async () => {
    const secret = {
      ...module('internal-only'),
      meta: { ...module('internal-only').meta, type: 'secret' },
    };
    // Released: the reader gets no `outside-scope` notes.
    const t = setUp(
      {
        modules: [secret, edited('x')],
        manifests: [manifest('operating', ['charging', 'internal-only'])],
      },
      { released: true },
    );
    t.lock(operating);
    const releasedReader: Actor = {
      ...actorWith(['content.read', 'content.edit'], {
        moduleTypes: ['concept'],
      }),
      id: author.id,
    };
    await expect(
      t.save.handle({
        actor: releasedReader,
        changeSetId: t.mine.id,
        subject: operating,
        content: manifest('operating', ['charging']),
        version: 0,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(t.copies.copies.size).toBe(0);

    // The same reader, a committed manifest naming only what they see:
    // the refusal above came from the hidden entry.
    const visible = setUp(
      {
        modules: [secret, edited('x')],
        manifests: [manifest('operating', ['charging'])],
      },
      { released: true },
    );
    visible.lock(operating);
    const saved = await visible.save.handle({
      actor: releasedReader,
      changeSetId: visible.mine.id,
      subject: operating,
      content: manifest('operating', ['charging']),
      version: 0,
    });
    expect(saved.version).toBe(1);
  });

  it('holds at most so many working copies per change set', async () => {
    const t = setUp();
    t.lock(charging);
    for (let i = 0; i < MAX_WORKING_COPIES_PER_CHANGE_SET; i++) {
      t.copies.copies.set(`${t.mine.id}:module/en/m${i}`, {} as never);
    }
    await expect(
      t.save.handle({
        actor: author,
        changeSetId: t.mine.id,
        subject: charging,
        content: edited('x'),
        version: 0,
      }),
    ).rejects.toMatchObject({
      code: 'too-many-working-copies',
      meta: { max: MAX_WORKING_COPIES_PER_CHANGE_SET },
    });
  });

  describe('a template file past the folder’s caps (#803)', () => {
    /** A branch whose template `house` lists `sizes` (path → bytes), as Git's tree tells them. */
    const withListing = (sizes: Record<string, number>) => {
      const t = setUp();
      const locked = new Set<string>();
      t.branch.designTemplateListing = (id: string) =>
        Promise.resolve(
          id === 'house'
            ? Object.entries(sizes).map(([path, size]) => ({
                path,
                size,
                draft: false,
                committed: true,
              }))
            : [],
        );
      const saveText = (path: string, text: string, version = 0) => {
        const subject: LockSubject = {
          type: 'template',
          templateId: 'house',
          path,
        };
        if (!locked.has(path)) t.lock(subject);
        locked.add(path);
        return t.save.handle({
          actor: author,
          changeSetId: t.mine.id,
          subject,
          content: { schemaVersion: 1, text },
          version,
        });
      };
      return { t, saveText };
    };

    it('refuses a save past MAX_TEMPLATE_BYTES (422 template-too-large), storing nothing', async () => {
      const { t, saveText } = withListing({
        'manual.typ': MAX_TEMPLATE_BYTES - 3,
      });
      await expect(saveText('new.typ', 'abcd')).rejects.toMatchObject({
        code: 'template-too-large',
        meta: {
          maxFiles: MAX_TEMPLATE_FILES,
          maxBytes: MAX_TEMPLATE_BYTES,
          files: 2,
          bytes: MAX_TEMPLATE_BYTES + 1,
        },
      });
      expect(t.copies.copies.size).toBe(0);
      // Up to the cap it is saved.
      await expect(saveText('new.typ', 'abc')).resolves.toMatchObject({
        version: 1,
      });
    });

    it('counts the change set’s other drafts at their length, in place of their files', async () => {
      const { saveText } = withListing({
        'manual.typ': MAX_TEMPLATE_BYTES - 100,
        'big.typ': 90,
      });
      // big.typ's draft is shorter than its file: room for more.
      await saveText('big.typ', 'x'.repeat(10));
      await expect(saveText('a.typ', 'y'.repeat(90))).resolves.toBeDefined();
      await expect(saveText('b.typ', 'z')).rejects.toMatchObject({
        code: 'template-too-large',
      });
    });

    it('refuses a new file past MAX_TEMPLATE_FILES, a draft of a listed one not', async () => {
      const { saveText } = withListing(
        Object.fromEntries(
          Array.from({ length: MAX_TEMPLATE_FILES }, (_, i) => [
            i === 0 ? 'manual.typ' : `f${i}.typ`,
            1,
          ]),
        ),
      );
      await expect(saveText('f1.typ', 'x')).resolves.toBeDefined();
      await expect(saveText('extra.typ', '')).rejects.toMatchObject({
        code: 'template-too-large',
        meta: { files: MAX_TEMPLATE_FILES + 1 },
      });
    });

    it('keeps a save that makes a folder past the caps no larger', async () => {
      const { saveText } = withListing({
        'manual.typ': MAX_TEMPLATE_BYTES,
        'big.typ': 100,
      });
      await expect(saveText('big.typ', 'x'.repeat(50))).resolves.toBeDefined();
      await expect(
        saveText('big.typ', 'x'.repeat(50), 1),
      ).resolves.toBeDefined();
      await expect(
        saveText('big.typ', 'x'.repeat(51), 2),
      ).rejects.toMatchObject({ code: 'template-too-large' });
    });
  });

  it('answers one who may not read drafts as if another’s change set did not exist', async () => {
    const t = setUp();
    const editsOnly = { ...actorWith(['content.edit']), id: 'sample-other' };
    for (const changeSetId of [t.mine.id, newChangeSetId()]) {
      const error = await t.discard
        .handle({ actor: editsOnly, changeSetId, subject: charging })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NotFoundError);
      expect((error as Error).message).toBe(`No change set "${changeSetId}".`);
    }
  });

  it('saves a manual with no entries yet', async () => {
    const t = setUp();
    t.lock(operating);
    const saved = await t.save.handle({
      actor: author,
      changeSetId: t.mine.id,
      subject: operating,
      content: { ...manifest('operating', []), entries: [] },
      version: 0,
    });
    expect(saved.version).toBe(1);
  });
});

describe('GetWorkingCopyAction', () => {
  it('reads the working copy, else the committed file at version 0', async () => {
    const t = setUp({ modules: [edited('committed')] });
    const input = { actor: author, changeSetId: t.mine.id, subject: charging };
    expect(await t.get.handle(input)).toEqual({
      changeSetId: t.mine.id,
      subject: charging,
      content: edited('committed'),
      baseCommit: t.branch.commit,
      version: 0,
      issues: [],
    });
    t.lock(charging);
    await t.save.handle({ ...input, content: edited('typed'), version: 0 });
    expect(await t.get.handle(input)).toMatchObject({
      content: edited('typed'),
      version: 1,
    });
    await expect(
      t.get.handle({ ...input, subject: { ...charging, moduleId: 'none' } }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('is for the author only, and what lies outside their scope is not there', async () => {
    const t = setUp({ modules: [edited('committed')] });
    const input = { changeSetId: t.mine.id, subject: charging };
    await expect(
      t.get.handle({ ...input, actor: other }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const narrow = editor({ moduleTypes: ['task'] });
    await expect(
      t.get.handle({ ...input, actor: narrow }),
    ).rejects.toBeInstanceOf(NotFoundError);
    // A saved copy outside the scope, too.
    t.copies.copies.set(`${t.mine.id}:module/en/charging`, {
      changeSetId: t.mine.id,
      subject: charging,
      content: edited('saved'),
      baseCommit: t.branch.commit,
      version: 1,
      updatedBy: { kind: 'user', id: author.id },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await expect(
      t.get.handle({ ...input, actor: narrow }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect((await t.get.handle({ ...input, actor: author })).version).toBe(1);
  });

  it('reads a committed manual as the reader may see it', async () => {
    const t = setUp({
      modules: [edited('x')],
      manifests: [manifest('operating', ['charging'])],
    });
    const read = await t.get.handle({
      actor: author,
      changeSetId: t.mine.id,
      subject: operating,
    });
    expect(read).toMatchObject({
      version: 0,
      content: manifest('operating', ['charging']),
    });
  });
});

describe('an author without content.read.draft (#126)', () => {
  const plain = (scope: Scope = {}, id = author.id): Actor => ({
    ...actorWith(['content.read', 'content.edit'], scope),
    id,
  });

  it('saves, reads and discards working copies on their own draft branch', async () => {
    // Not released: the branch has moved past main.
    const t = setUp({ modules: [edited('committed')] });
    const input = { actor: plain(), changeSetId: t.mine.id, subject: charging };
    expect(await t.get.handle(input)).toMatchObject({
      version: 0,
      content: edited('committed'),
      baseCommit: t.branch.commit,
    });
    t.lock(charging);
    const saved = await t.save.handle({
      ...input,
      content: edited('typed'),
      version: 0,
    });
    expect(saved.version).toBe(1);
    expect(await t.get.handle(input)).toMatchObject({
      content: edited('typed'),
      version: 1,
    });
    await t.discard.handle(input);
    expect(t.copies.copies.size).toBe(0);
  });

  it('sees only what their content.read scope covers, and nothing of another author’s', async () => {
    const t = setUp({ modules: [edited('committed')] });
    t.lock(charging);
    const input = { changeSetId: t.mine.id, subject: charging };
    await t.save.handle({
      ...input,
      actor: plain(),
      content: edited('typed'),
      version: 0,
    });
    // Their roles narrowed since: the copy is not there, like a missing one.
    const narrow = plain({ moduleTypes: ['task'] });
    await expect(
      t.get.handle({ ...input, actor: narrow }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      t.save.handle({
        ...input,
        actor: narrow,
        content: edited('again'),
        version: 1,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // Another author without content.read.draft: not found, exactly like a
    // change set that does not exist (#125), for every route.
    const stranger = plain({}, 'sample-stranger');
    const answers = await Promise.all(
      [
        () => t.get.handle({ ...input, actor: stranger }),
        () => t.discard.handle({ ...input, actor: stranger }),
        () =>
          t.save.handle({
            ...input,
            actor: stranger,
            content: edited('x'),
            version: 1,
          }),
        () =>
          t.get.handle({
            ...input,
            actor: stranger,
            changeSetId: '01900000-0000-7000-8000-000000000000',
          }),
      ].map((run) => run().catch((e: unknown) => e)),
    );
    for (const answer of answers) {
      expect(answer).toBeInstanceOf(NotFoundError);
    }
    expect((answers[0] as Error).message).toBe(`No change set "${t.mine.id}".`);
  });
});

describe('DiscardWorkingCopyAction and abandoning', () => {
  it('discards without the lock; a second time it is not there', async () => {
    const t = setUp();
    t.lock(charging);
    const input = { actor: author, changeSetId: t.mine.id, subject: charging };
    await t.save.handle({ ...input, content: edited('x'), version: 0 });
    t.locks.locks.length = 0;
    await expect(
      t.discard.handle({ ...input, actor: other }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await t.discard.handle(input);
    expect(t.copies.copies.size).toBe(0);
    await expect(t.discard.handle(input)).rejects.toBeInstanceOf(NotFoundError);
    expect(t.audit.events).toEqual([]);
  });

  it('drops the working copies when the change set is abandoned', async () => {
    const t = setUp();
    t.lock(charging);
    t.lock(operating);
    const input = { actor: author, changeSetId: t.mine.id };
    await t.save.handle({
      ...input,
      subject: charging,
      content: edited('x'),
      version: 0,
    });
    await t.save.handle({
      ...input,
      subject: operating,
      content: manifest('operating', ['charging']),
      version: 0,
    });
    expect(t.copies.copies.size).toBe(2);
    await t.abandon.handle({ actor: author, id: t.mine.id });
    expect(t.copies.copies.size).toBe(0);
    expect(t.audit.events[0]).toMatchObject({
      action: 'change-set.abandon',
      data: { from: 'draft', to: 'abandoned', workingCopies: 2 },
    });
  });
});
