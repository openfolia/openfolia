# @openfolia/content-repo

Reads content from a Git repository at any branch, tag or commit, and writes commits and branches to it, without a working tree. Content at a commit never changes, so reads and parsed files are cached.

## Repository layout

```
openfolia.yaml                 project configuration
modules/<lang>/<id>.adoc  modules, one file per language
modules/<lang>/<id>.translation.yaml
                          a translated module's translation record (what each block was translated from)
manuals/<id>.yaml         manual manifests
terms/<id>.yaml           terms, one file per concept (the content model's Term)
design/<id>.yaml          page designs, one file per design (the content model's PageDesign, #390)
assets/<sha256>           images, named by the SHA-256 of their content
symbols/<id>.svg|png      safety symbol artwork
templates/manual.typ      optional PDF template replacing the built-in one
```

## Use

```ts
const repo = ContentRepo.open('/srv/content.git');
const snapshot = await repo.at('v2.3'); // branch, tag or commit ID
const module = await snapshot?.module('battery-charging', 'de');
const result = await snapshot?.resolve(
  'operating-manual',
  { model: 'l-400' },
  'de',
);
repo.close();
```

- A ref is a branch or tag name, looked up by exact full name as `refs/heads/<name>` and then `refs/tags/<name>` (never by git's own lookup rules, so a branch and a tag of the same name always give the branch), a full `refs/heads/…` or `refs/tags/…` name, `HEAD`, or a commit ID, full or abbreviated to at least 7 characters (matched against objects only, never a ref of that name, and the objects with that prefix must peel to exactly one commit; a full ID that names a commit is looked up once and kept, since it always will). Git never searches above the repository folder; variables that would point it at another repository, index or object store are dropped, and replace objects and grafts (`info/grafts` included) are switched off, so an ID always means its own content. Refs that git could read as options or revision syntax (`--x`, `main~1`, `v1:path`) are rejected. `repo.atEach(refs)` (and `repo.git.resolveRefs(refs)`) opens several at once, each exactly as `at` (`resolveRef`) would, in the order given, from one ref listing however many names there are (#764: a product's release tags); a commit ID costs what it costs alone.
- Missing files return `undefined`; files that exist but are invalid throw `ContentError` with the path.
- `resolve` loads every module a manual needs (following module references) and reports unreadable modules as `invalid-module` issues. `resolve(id, variant, lang, { visible })` leaves out the modules `visible` refuses (an `outside-scope` issue each) and does not follow their module references. `{ manifest }` resolves that manifest instead of the stored one (a reader's view of it, say: entries left out are not evaluated, so their conditions raise no issues). `{ standIn }` gives a module's text in place of its file (`(id, lang) => Module | undefined`, `undefined`: the file), e.g. a draft not committed yet; its module references are followed as the file's would be. It also reads the terms the loaded modules link (#245, `resolveManual`'s `loadTerm`), each once; a term file that cannot be read counts as no term (its links stay plain text, and the API's checks report it).
- **Derived manuals** (#451). `snapshot.manifest(id)` gives a manifest as stored: a derived manual's (`kind: derived`) without entries. `snapshot.derive(manifest)` gathers one at this commit (`deriveManifest` in `@openfolia/content-model`: the source manifest, and the source-language file of each module it includes for its type; one that cannot be read is not gathered, an unreadable source is an issue): the manifest with its entries, `attributes` to resolve it with and the issues. `resolve(id, …)` without `{ manifest }` gathers a stored derived manual before resolving it; a manifest given is resolved as it is. `addSampleSafetyLeaflet(dir)` (testing) adds a `safety` type marked `safety: true`, two safety modules in English and German in the operating manual the leaflet's page design `design/leaflet.yaml` (`SAMPLE_LEAFLET_DESIGN`, `SAMPLE_LEAFLET_DESIGN_ID`, #668: A5 portrait, the `minimal` preset, small type and margins, unnumbered headings with no page break before each module, English, German and French texts) and the derived manual `safety-leaflet` (`SAMPLE_LEAFLET_ID`) naming it (`design: leaflet`) in a commit on `main`; the local sample has it. `addSampleNoticeLeaflet(dir)` (testing, after it; #670) adds a procedure module `hose-connection` (English and German; a caution in a step, a warning in a variant block for the large model) to the operating manual and the derived manual `safety-notices` (`SAMPLE_NOTICE_LEAFLET_ID`) gathering the operating manual's safety notices grouped by hazard level, on the same design; the local sample has it too. A notice gathering reads the modules the source's modules refer to as well (`readGatheringModules`). The design is a design like any other: an organisation's own leaflet design (or its own Typst template, #396) is a file of its own, named by the leaflet's manifest.
- `snapshot.terms()` lists the term IDs (`terms/<id>.yaml` with a valid term ID, sorted) and `snapshot.term(id)` reads one (`Term` in `@openfolia/content-model`, "Terms"; parsed once per commit): `undefined` when there is none or the ID is no term ID, `ContentError` for a file that is no term.
- `snapshot.pageDesigns()` lists the page design IDs (`design/<id>.yaml` with a valid design ID, sorted) and `snapshot.pageDesign(id)` reads one (`PageDesign` in `@openfolia/content-model`, "Page designs"; parsed once per commit): `undefined` when there is none or the ID is no design ID, `ContentError` for a file that is no design. The fonts, logos and cover images a design names are `sha256:` assets in the blob store, like images. `addSamplePageDesigns(dir)` (testing) adds `SAMPLE_PAGE_DESIGNS` in a commit on `main`.
- `snapshot.translationRecord(id, lang)` reads a translated module's record (`TranslationRecord` in `@openfolia/content-model`, "Translation"): per block ID the source hash it was translated from, and the source commit. `undefined` when there is none; a file that is no record throws `ContentError`. Module lists (`modules()`) name only `.adoc` files, so a record is never listed as a module. The import writes it. Deleting a module in a language does not remove its record yet (#287).
- Files are read through one long-running `git cat-file --batch` process; call `close()` when done.
- **What is kept in memory** (#479). A parsed file (module, manifest, term, translation record, the configuration) is kept by its blob ID and path, so the same file at many commits, and in history reads (`moduleAtRevision`), is parsed once and is the same object; callers asking for one at once share one parse. The cache is bounded by the files' text: `ContentRepo.open(dir, { parsedCacheBytes })` (default `DEFAULT_PARSED_CACHE_BYTES`, 64 MiB; parsed content takes five to six times its text). What is kept is shared: never change a parsed module, manifest or term in place. The indexes kept besides (#552) are bounded by their bytes, estimated from their strings, together at most `ContentRepo.open(dir, { indexCacheBytes })` (or `new GitRepo(dir, git, { indexCacheBytes })`; default `DEFAULT_INDEX_CACHE_BYTES`, 32 MiB), each a fixed share of it (`INDEX_SHARES`): blob IDs by `commit:path` and per folder (`knownFileId`, `fileIds`), `repo.git.changedPaths` per pair of commits, path histories and deletions (their messages and trailers counted), folder listings, and the list of module files per commit. An entry larger than its share is not kept, except a whole-folder index (blob IDs or paths below a folder, a commit's module files): the newest of each folder is kept however large, beside the others (at most 8 such), so a large `modules/` stays cached whatever else is read. File contents are kept up to 64 MiB on their own. Each `GitRepo` has its own caches: a process with several on one repository (the API's change-set and change-feed readers) keeps each one's bound. The generation of each repository's refs (`refsMoved`, below) is kept for the last 1,000 repositories written (`REF_GENERATIONS_KEPT`); one forgotten only shares its ref listings less, never a listing from before its last write. The ref listing (`for-each-ref`, behind `resolveRef` for names, `refs()` and `tagsNewestFirst()`) is never kept, but callers asking while one runs share it, unless a `GitWriter` of this process moved a ref of the repository since it began (`refsMoved`): a read after a write in the same process always sees it, while a ref moved by another process is seen by the next listing (at most one listing's time later than without sharing). A full commit ID once found to be a commit is not looked up again.

`@openfolia/content-repo/testing` exports `createSampleRepo()`, which builds a small repository with history for tests, and `createBareSampleRepo()`, the same as a bare repository (what a server that writes uses: nothing is checked out). Its `charging` module shows a real picture (`PNG`, a 480 × 300 drawing, stored as `assets/<PNG_HASH>`), so a local preview (`api:setup-local`) shows an image, not a dot. `addSampleSnippets(dir)` and `addSampleTerms(dir)` add a commit each on `main` (two snippets; the terms of `SAMPLE_TERMS`, approved, proposed and deprecated, and a module, `storage`, using a forbidden variant and linking two terms, which the operating manual, given `glossary: true`, now includes), kept out of the base sample whose content many tests count; the local sample has both. The sample is built once per process, bare with `git fast-import` (a template in the temporary folder named by the process ID; the next build removes those of processes that are gone) and copied for each call (the same commits each time), and the `addSample…` helpers commit with one `git fast-import` each rather than through `GitWriter`: on a loaded machine a fixture of a few commits made with a dozen `git` processes apiece took longer than a test hook may (#615).

`repo.git.tag(name)` reads one annotated tag by its exact name (its object, the commit it points to, the tagger date, its message without trailers and its trailers; undefined for a lightweight or missing one). `repo.git.tagsNewestFirst()` lists the tags newest first by when each was made (an annotated tag's tagger date, a lightweight one's commit date; ties by name); `repo.git.fileIds(commit, dir)` the blob ID of every file below a folder at a commit (cached per commit), and `snapshot.moduleRevision(id, lang)` a module file's blob ID: equal IDs, equal files, at any commits. `repo.git.refsContaining(commit, timeoutMs = 30_000)` lists the full names of the branches and tags whose history contains a commit (e.g. whether deleting a branch would lose commits no other ref has); `repo.git.headBranch()` names the branch `HEAD` points to. `repo.git.history(head, max, { excluding?, timeoutMs? })` gives up to `max` commits of `head`'s first-parent history (newest first) with their first parent, how many parents they have, their tree, author email and trailers; with `excluding` (a commit ID) it leaves out that commit's history, so on a branch it was merged into it lists the merge, what came after it and nothing before where the two met (finding a merge commit without a fixed window); `repo.git.changedPaths(from, to)` the files that differ between two commits, with whether each was deleted. `repo.git.committedAt(commit)` (and `snapshot.committedAt()`) gives a commit's committer date in whole seconds since the epoch, cached: the date a PDF of it carries, so the same commit renders the same bytes. `repo.git.isAncestor(ancestor, commit)` whether a commit is `commit` or in its history (full IDs; false for an ID that names no commit). `repo.git.countAhead(commit, excluding, max)` counts the commits `commit`'s history holds that `excluding`'s does not, up to `max` (how far a branch is behind another). `repo.git.pathHistory(head, path, max)` gives the commits among the newest `max` of `head`'s first-parent history that changed one file, each compared with its first parent (so a merge counts when it brought a change of the file into that line, and a commit made on a branch merged later does not count on its own), newest first, with the file's blob ID after it (none: deleted), the commit time, the message without its trailers and the trailers; `truncated` when the line is longer than `max`, and `before` then the file's blob ID at the newest commit not looked at. The path is read literally (no pathspec magic); results are cached per head, `max` and path. `repo.git.deletedFiles(head, dir, max)` lists the files below a folder (read literally) that a commit among the newest `max` of `head`'s first-parent history deleted, compared with its first parent as `pathHistory` compares, and that are not there at `head`: each once, with its newest deletion (commit, commit time) and its blob ID before it, newest first; `truncated` when the line is longer than `max` (a file deleted before is not listed); cached per head, `max` and folder. `snapshot.deletedModules(max)` is that for the module files (`id`, `lang`, `revision`: the file as it last was, for `moduleAtRevision`). `snapshot.moduleHistory(id, lang, max)` is that for a module's file (`revision`: its blob ID, as `moduleRevision` gives it), and `snapshot.moduleAtRevision(id, lang, revision)` reads the module stored in a revision (`repo.git.readBlob(id)`; parsed once per revision), throwing `ContentError` like `module` for one that cannot be read. The same for manuals' manifests (`manuals/<id>.yaml`): `snapshot.manifestRevision(id)`, `snapshot.manifestHistory(id, max)`, `snapshot.deletedManifests(max)` (`id`, `revision`) and `snapshot.manifestAtRevision(id, revision)`.

## Writing

```ts
const writer = new GitWriter('/srv/content.git');
const head = (await repo.at('main'))!.commit; // what the author read and edited
try {
  const { commit } = await writer.commit({
    branch: 'main',
    parent: head,
    changes: [
      { path: 'modules/en/battery-charging.adoc', content: text },
      { path: 'modules/en/old.adoc', delete: true },
    ],
    message: 'Explain charging',
    author: { name: 'Ada', email: 'ada@example.com' },
    trailers: [{ key: 'Change-set', value: '42' }],
  });
} catch (e) {
  if (e instanceof RefConflictError) {
    // main moved since `head` (e.actual): nothing was written to the branch
  }
}
// In two steps, to record what is about to be committed before any ref moves:
const { tree } = await writer.prepareCommit({
  parent: head,
  changes,
  message,
  author,
});
// … record (parent, tree) …
await writer.commitPrepared({
  branch: 'main',
  parent: head,
  tree,
  message,
  author,
});
await writer.createBranch('draft/x', head); // fails if it exists
await writer.deleteBranch('draft/x', head); // fails if it moved
```

- **`commit` in two steps.** `prepareCommit` checks a request as `commit` does and writes its blobs and tree, but no commit and no ref, and returns the tree (the same changes on the same parent give the same tree); `commitPrepared` commits that tree on `parent` by the same compare-and-swap (`invalid-commit` for an ID that is no tree, `no-changes` for the parent's own tree). `commit` is the two in a row. Unreferenced objects from a prepared tree that is never committed are left to `git gc`.
- **No working tree, no index.** The writer hashes a write's blobs, trees (only the folders on a changed path are rewritten) and commit itself, byte for byte as `hash-object`, `mktree` and `commit-tree` would, and writes them in one `git unpack-objects --strict`, the pack streamed one object at a time: git checks each object as `fsck` does (a tree's entries sorted, their names and modes sane) and that every object one names is there with its type, and writes none if one is wrong. So a folder that already holds an entry `fsck` refuses (a `.git`, say, from history made elsewhere) can no longer be written into: the write fails with git's error, where `mktree` used to copy the entry. Works on a bare repository; a checkout's files and index are never touched.
- **Few processes per write** (#727). An operation reads every object it needs (commits, trees, blobs) through one `git cat-file --batch` of its own, by full ID only, and lists the refs (`for-each-ref`, with the worktree each branch is checked out in) beside its last step before the transaction (writing the objects, `mktag`), so the checks only the listing makes see the refs as late as before; a merge lists them up front too, for the stale-caller check. Steps that do not depend on each other (the trailer check, the reads, the ref listing) run side by side; what fails first in the old order is still the error. A commit of any number of files starts five processes (`interpret-trailers`, `cat-file`, `for-each-ref`, `unpack-objects`, `update-ref`; 18 to 21 before), `prepareCommit` three, a merge commit eight (one `merge-base --all` tells up to date, fast-forward, diverged and unrelated), a fast-forward five, a change-set update keeping files eight, `previewMerge` four, a tag six, a branch created or deleted three; the git version merges need is asked once per git binary in a process. `writer-processes.spec.ts` holds these as upper bounds.
- **Refs move only by compare-and-swap.** Every ref change is an `update-ref --stdin` transaction naming the value the ref must still have: `parent` for a commit, "must not exist" for a new branch (and for a first commit, `parent: null`), the caller's commit for a delete. If the ref moved, nothing changes and `RefConflictError` says where it is now (`actual`, undefined when it does not exist). So concurrent writers never lose each other's commits: each lands or gets an explicit conflict. Contention on a ref lock is retried; the conflict decision is made from the ref values, never from git's message text.
- **A ref is changed only by its exact name.** Before the transaction the writer reads every ref and refuses a symbolic ref (an update would move the ref it points to), a branch checked out in a worktree (`checked-out`: its index and files would fall behind; the API's repository is bare; `%(worktreepath)` of the listing, except the main "worktree" of a bare repository, the branch its `HEAD` names, which `git worktree list` lists as bare too; when a bare repository has linked worktrees, `git worktree list` is asked whether one has that branch), and a new branch whose name differs only in case from, or clashes as file and folder with (`a` and `a/b`), an existing branch or tag. Each command also carries `no-deref`.
- **Paths** must be in the layout: `openfolia.yaml`, `templates/manual.typ`, or a file inside `modules/`, `manuals/`, `terms/`, `design/`, `assets/` or `symbols/`, with segments of `A-Za-z0-9._-` not starting with a dot (`isWritablePath`). An asset is `assets/<sha256>` and must be named by its content's SHA-256 (`invalid-asset`). A change is exactly `{ path, content }` (a string or bytes) or `{ path, delete: true }`; anything else is `invalid-change`. No `..`, no hidden files, nothing written through a symlink or submodule (an existing one on the way is a `path-conflict`); files are written as regular files (mode `100644`).
- **Limits** (`WriterLimits`, per writer): 20 MiB per file, 100 MiB per commit, 1000 changes per commit.
- Author and committer come from the actor (`committer` defaults to `author`; `date` to now). Characters git strips from either end of a name or email (whitespace and `.,:;"'\`) are stripped the same way, and `CommitResult` returns the identities exactly as recorded; `<`, `>` and control characters are refused.
- **Trailers come only from `trailers`** (`Key: value`, a key may repeat), appended as the message's last paragraph. A message that git itself (`interpret-trailers --parse`, with the repository's configuration) would read as ending in trailers is refused (`invalid-message`), as are control characters and `---` lines, so an `Approved-by:` can never be forged through the message text.
- Invalid requests throw `WriteError` with a stable `code` (`invalid-path`, `path-conflict`, `not-found`, `no-changes`, `too-large`, …) before anything is written to a ref. The branch HEAD names and the writer's `protectedBranches` option (the API's default branch) cannot be deleted (`protected-ref`); a new branch (`createBranch`, or `commit` with `parent: null`) cannot share its name with a tag. No branch operation takes a name that starts with `refs/` or is all hex of 7 to 64 characters (`readsAsCommitId`: the reader would read it as a commit ID, so the writer never writes a branch readers cannot find by name).
- Objects are written loose; objects of a commit that then loses its compare-and-swap stay unreferenced. Plumbing never runs `gc --auto`, so the host runs `git maintenance` (or `gc`) on the repository periodically.
- A `ContentRepo` reading the same repository sees the new commit as soon as `commit` returns.

## Merging and tagging

```ts
try {
  const result = await writer.merge({
    branch: 'main',
    expected: mainHead, // what the caller read; compare-and-swap
    source: changeSetHead, // an exact commit ID, never a name
    message: 'Merge change set 42',
    author: approver,
    trailers: [{ key: 'Approved-by', value: 'user/reviewer' }],
    fastForward: 'never', // default 'allow'
  });
  // result.kind: 'merge' | 'fast-forward' | 'up-to-date'
} catch (e) {
  if (e instanceof MergeConflictError) e.conflicts; // [{ path, kinds }]
  if (e instanceof RefConflictError) e.actual; // main moved: retry on top
}
await writer.createTag({
  name: 'release/x/1.2',
  commit: mainHead,
  message: 'Release 1.2',
  tagger: publisher,
  trailers: [{ key: 'Revision', value: '1.2' }],
});
```

- **Merges without a working tree**: `git merge-tree --write-tree` (git 2.40 or later, `MIN_MERGE_GIT_VERSION`: `merge-tree --write-tree` and `GIT_ATTR_SOURCE`; an older git fails the first merge with a `GitError` saying so). `up-to-date` when `source` is already in the branch's history; with `fastForward: 'allow'` (the default) the branch moves to `source` when that is a fast-forward, recording no merge commit (so no message and no trailers); otherwise a merge commit with parents `expected` and `source`, its message and trailers checked as for `commit`. Then the ref moves by the same compare-and-swap as a commit: a merge racing another update gets `RefConflictError` (`actual`), nothing written, and can be retried on top. The branch is checked up front too, so a stale caller learns it before any work; a fast-forward's transaction is checked against that same listing, a merge commit's against one taken beside its write, and the compare-and-swap refuses whatever moved since.
- **Conflicts are never resolved**: `MergeConflictError` lists each conflicting path with the kinds git names (`contents`, `modify/delete`, `rename/delete`, `file/directory`, …; for a file/directory conflict git may list a path of its own making, `<path>~<commit>`), and no ref changes (the objects git wrote stay unreferenced). Attributes are read from an empty tree, never from the commits merged, so a `.gitattributes` in content (say `merge=union`) cannot resolve a conflict silently. Content-addressed assets added on both sides are the same file and never conflict. Commits with no common history are `unrelated-histories`; a source or expected value that is no commit (a tag, a name) is `invalid-commit`.
- **Keeping resolved files** (`keep` on `merge`, for updating a change set from its base after its author resolved a conflict): where a listed path conflicts, the branch's own file (`expected`'s; none when it has none) is kept. Only a plain file conflict (`KEEPABLE_CONFLICTS`: `contents`, `add/add`, `modify/delete`) of a regular file is kept, and only when every conflict is resolved; otherwise `MergeConflictError` lists the ones left and nothing is written. `previewMerge(expected, source, keep?)` answers what `merge` would do without writing a commit or moving a ref: `up-to-date`, `fast-forward` or `merge` with the files the result changes against `expected`, or the `conflicts` left.
- **Applying a change elsewhere** (`applyChange({ from, to, onto, paths })`, for carrying a fix from one branch to another): a three-way merge with `from` as the merge base (`merge-tree --write-tree --merge-base`), so only the change `from` → `to` is applied onto `onto`, never what came before `from` on its branch. No commit, no ref moves. It answers `files`, the result's bytes at each of `paths` (each one `commit` may write) that is clean and differs from `onto` (`null`: no file there), and `conflicts`, every path git could not combine (as for `merge`; a result that is no regular file at a path: `not-a-file`), never resolved and never in `files`. Attributes come from an empty tree, as for merges.
- **Annotated tags** (`mktag`, with git's strict checks) on an exact commit, with the tagger normalised and checked like an author, the message and trailers like a commit's. A tag is created only if no ref of that name exists (`RefConflictError` with the existing tag in `actual`), never moved or deleted; a name follows the branch rules above and `git check-ref-format`, and must not clash with a branch or tag (same name in any case, or one a folder of the other): `invalid-ref`.
