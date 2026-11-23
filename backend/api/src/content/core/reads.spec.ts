import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { READER } from '../../../tests/fakes/actors.js';
import { FakeSnapshot } from '../../../tests/fakes/fake-content.js';
import { ReadableContent } from './readable-content.js';

/**
 * Every read of content goes through `ReadableContent`, which filters it by
 * the actor's scope: no other code can reach the unfiltered snapshot or the
 * repository. A new file that needs them is a decision for review, made
 * here.
 */
const src = join(import.meta.dirname, '../..');
const sources = readdirSync(src, { recursive: true, encoding: 'utf8' })
  .filter((file) => file.endsWith('.ts') && !file.endsWith('.spec.ts'))
  .sort()
  .map((file) => ({ file, text: readFileSync(join(src, file), 'utf8') }));

const using = (pattern: RegExp) =>
  sources.filter(({ text }) => pattern.test(text)).map(({ file }) => file);

describe('reading content', () => {
  it('finds the sources', () => {
    expect(sources.length).toBeGreaterThan(50);
  });

  it('reaches the unfiltered snapshot only where it is wrapped', () => {
    expect(using(/\bContentSnapshot\b/)).toEqual([
      // What a merged change set deprecates (#266), for the outbox: reads
      // only the deprecation (reason, replacement) of the files it changed;
      // each consumer decides by its own rules who is told.
      'change-sets/core/deprecation-events.ts',
      // Drafts over a snapshot (#237), only ever wrapped by the filter
      // (`ReadableContent.withOverlay`).
      'content/core/content-overlay.ts',
      // The port, its adapter, and the filter.
      'content/core/content.repository.ts',
      // Derived manuals gathered over a snapshot (#451), only ever wrapped by
      // the filter and the module index, as the snapshot is.
      'content/core/derived-manuals.ts',
      'content/core/readable-content.ts',
      'content/repos/git-content.repo.ts',
      // The module index (#45): built from the unfiltered commit, and read
      // only through `ReadableModuleIndex`, which keeps what
      // `ReadableContent.judgeIndexed` lets the reader see.
      'modules/core/module-index.ts',
    ]);
  });

  it('opens the repository only to wrap a snapshot, or to list refs', () => {
    expect(using(/\bContentRepository\b/)).toEqual([
      // Which files content refers to anywhere, for deleting unused ones
      // (#255), and its index per commit (#476): only `sha256:` hashes
      // leave them, never content.
      'assets/core/asset-reference-index.ts',
      'assets/core/asset-references.ts',
      // Opens a merged change set's base commit and review head (see above).
      'change-sets/core/deprecation-events.ts',
      'content/content.module.ts',
      // Released content only (`isReleased`), through `content.read`, many tags at once (#764).
      'content/core/actions/open-released-snapshots.action.ts',
      'content/core/actions/open-snapshot.action.ts',
      'content/core/content.repository.ts',
      // Looks up refs by name through the draft rule; reads no content.
      'content/core/readable-refs.ts',
      'content/repos/git-content.repo.ts',
      // The module index (#45): opens a commit to build its index (see above).
      'modules/core/module-index.ts',
      // Filters the refs itself (`releasedRefs`); reads no content.
      'project/core/actions/list-refs.action.ts',
      // Asks `refs()` whether the exported commit is released (#50); reads
      // the content through `OpenSnapshotAction`.
      'translations/core/actions/export-translations.action.ts',
    ]);
  });

  it('makes readable content in one place, for the request’s actor', () => {
    expect(using(/new ReadableContent\b/)).toEqual([
      // Released content as `OpenSnapshotAction` opens it, for many tags at once (#764).
      'content/core/actions/open-released-snapshots.action.ts',
      'content/core/actions/open-snapshot.action.ts',
      // `withOverlay`: the same actor and permission, over the same snapshot.
      'content/core/readable-content.ts',
    ]);
  });

  it('lets only the change set’s diff and status open an authored base commit', () => {
    // `authoredBase` opens a commit by ID without `content.read.draft`;
    // only after `opensAsAuthor` on the change set whose base it is.
    expect(using(/\bauthoredBase\b/)).toEqual([
      // A change set's base, put back when changes are taken out of it, and
      // its two sides: for its diff, and for its comments.
      'change-sets/core/actions/revert-changes.action.ts',
      'change-sets/core/change-set-sides.ts',
      'change-sets/core/change-set-touches.ts',
      // A change set's base, whose translation records may be put back (#663).
      'change-sets/core/save-point.ts',
      // Declares it.
      'content/core/actions/open-snapshot.action.ts',
    ]);
  });

  it('lets only a translation job’s file and its import open its commit as once released', () => {
    // `releasedOnce` opens a commit by ID without `content.read.draft`;
    // only for the commit a job recorded as released when it was exported.
    expect(using(/\breleasedOnce\b/)).toEqual([
      'content/core/actions/open-snapshot.action.ts',
      'translations/core/actions/translation-job-file.action.ts',
      // The same commit, to check an import of that job's file against it (#51).
      'translations/core/translation-import-check.ts',
    ]);
  });

  it('lets only the save point’s write path tell OpenSnapshotAction who authors a branch', () => {
    // `authored` skips asking AuthoredBranches; from a request it would open
    // any branch at its head (#126).
    expect(using(/\bauthored\??:/)).toEqual([
      // \`authored: false\` only: under the row lock, no second query (#317).
      'change-sets/core/actions/reconcile-change-set-commits.action.ts',
      'change-sets/core/save-point.ts',
      // Declares it.
      'content/core/actions/open-snapshot.action.ts',
    ]);
  });

  it('never hands out the snapshot it wraps', () => {
    const raw = new FakeSnapshot();
    const readable = new ReadableContent(raw, READER, 'content.read');
    expect(Object.values(readable)).not.toContain(raw);
    // Its own fields are only these; the snapshot is a #private field.
    expect(Reflect.ownKeys(readable).map(String).sort()).toEqual([
      'commit',
      'permission',
      'readingKey',
    ]);
  });
});
