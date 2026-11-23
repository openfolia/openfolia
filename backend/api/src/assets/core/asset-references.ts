import { Injectable } from '@nestjs/common';
import { UnavailableError } from '../../base/core/errors.js';
import { idOfBranch } from '../../change-sets/core/change-set.js';
import { ChangeSetStore } from '../../change-sets/core/change-set-store.js';
import { WorkingCopyStore } from '../../change-sets/core/working-copy-store.js';
import { ContentRepository } from '../../content/core/content.repository.js';
import { RELEASED_BRANCH } from '../../content/core/released.js';
import { AssetReferenceIndex } from './asset-reference-index.js';
import { AssetUploads } from './asset-uploads.js';
import { HeldBlobs } from './held-blobs.js';

/** Where a file is referred to, as a refusal to delete it names it. */
export type ReferencePlace =
  /** `main` or a release tag, named (released content: anyone reading may know of it). */
  | { readonly in: 'main' | 'release'; readonly ref: string }
  /** A branch that is not a change set's, an open change set's head, or a working copy: not named. */
  | { readonly in: 'branch' | 'change-set' | 'working-copy' }
  /** A blob an import keeps as its bundle, or an image of the branding (`HeldBlobs`): not named. */
  | { readonly in: 'import' | 'branding' };

/** More open change sets than this and the check gives up (503) rather than guess. */
export const MAX_OPEN_CHANGE_SETS = 10_000;

/** What is read before the refs' commits: places holding files directly. */
interface Gathered {
  /** Hashes held, in the order places are named. */
  readonly direct: readonly {
    readonly hashes: ReadonlySet<string>;
    readonly place: ReferencePlace;
  }[];
  /** The commits whose module files count, each with the place it stands for. */
  readonly reads: readonly { commit: string; place: ReferencePlace }[];
}

/**
 * Which files content refers to anywhere, whoever may read it (#255): what
 * decides that a file is unused and may be deleted. Never filtered by a
 * reader's scope, and never handed to a response but as `ReferencePlace`s.
 *
 * Read in this order, so a reference moving on meanwhile is seen at one
 * place or the next: the working copies (a save point commits one before
 * removing it), the open change sets, then every ref at once (a merge
 * moves the base branch before the change set leaves the open states).
 * Places: `main` and every other branch that is not a change set's,
 * every tag, the head of every open change set (not of a merged or
 * abandoned one, whose branch is kept) and every file uploaded into one
 * (an author's draft, not yet placed), every working copy, and the blobs
 * another component holds (`HeldBlobs`: an import's bundle). What the module
 * files at a commit mention is kept per commit (`AssetReferenceIndex`, #476),
 * so a check reads the refs, not their files.
 */
@Injectable()
export class AssetReferences {
  constructor(
    private readonly content: ContentRepository,
    private readonly changeSets: ChangeSetStore,
    private readonly workingCopies: WorkingCopyStore,
    private readonly uploads: AssetUploads,
    private readonly held: HeldBlobs,
    private readonly index: AssetReferenceIndex,
  ) {}

  /** Every file hash referred to anywhere, each once. */
  async referenced(): Promise<Set<string>> {
    const { direct, reads } = await this.#gather();
    const found = new Set<string>();
    for (const { hashes } of direct) for (const hash of hashes) found.add(hash);
    const commits = reads.map((read) => read.commit);
    for (const hash of await this.index.referencedAt(commits)) found.add(hash);
    return found;
  }

  /** Per hash of `hashes` referred to anywhere, the places that refer to it. */
  async placesOf(
    hashes: readonly string[],
  ): Promise<Map<string, ReferencePlace[]>> {
    const { direct, reads } = await this.#gather();
    const found = new Map<string, ReferencePlace[]>();
    const add = (hash: string, place: ReferencePlace) => {
      const places = found.get(hash);
      if (!places) found.set(hash, [place]);
      else if (!places.some((p) => samePlace(p, place))) places.push(place);
    };
    for (const { hashes: held, place } of direct) {
      for (const hash of hashes) if (held.has(hash)) add(hash, place);
    }
    const commits = await this.index.mentioning(
      hashes,
      reads.map((read) => read.commit),
    );
    // In the order of the reads, as the places are named.
    const at = new Map<string, Set<string>>();
    for (const [hash, list] of commits) at.set(hash, new Set(list));
    for (const { commit, place } of reads) {
      for (const hash of hashes) {
        if (at.get(hash)?.has(commit)) add(hash, place);
      }
    }
    return found;
  }

  async #gather(): Promise<Gathered> {
    const direct: { hashes: ReadonlySet<string>; place: ReferencePlace }[] = [];
    // An import's bundle is its own until it goes, a branding image the
    // branding's (deleting checks it again under the hash's lock:
    // `HeldBlobs.holds`).
    const held = await this.held.held();
    for (const by of ['import', 'branding'] as const) {
      direct.push({
        hashes: new Set(held.filter((h) => h.by === by).map((h) => h.sha256)),
        place: { in: by },
      });
    }
    direct.push({
      hashes: await this.workingCopies.referencedAssets(),
      place: { in: 'working-copy' },
    });
    const open = await this.changeSets.listOpen(MAX_OPEN_CHANGE_SETS + 1);
    if (open.length > MAX_OPEN_CHANGE_SETS) {
      throw new UnavailableError(
        'too-many-change-sets',
        'Too many change sets are open to tell whether a file is used.',
        60,
      );
    }
    // An upload into an open change set is its author's draft, used or not.
    direct.push({
      hashes: new Set(await this.uploads.uploadedInto(open.map((c) => c.id))),
      place: { in: 'change-set' },
    });
    const openBranches = new Set(open.map((changeSet) => changeSet.branch));
    const refs = await this.content.refs();
    const reads: { commit: string; place: ReferencePlace }[] = [];
    for (const branch of refs.branches) {
      if (branch.name === RELEASED_BRANCH) {
        reads.push({
          commit: branch.commit,
          place: { in: 'main', ref: branch.name },
        });
      } else if (idOfBranch(branch.name) === undefined) {
        reads.push({ commit: branch.commit, place: { in: 'branch' } });
      } else if (openBranches.has(branch.name)) {
        reads.push({ commit: branch.commit, place: { in: 'change-set' } });
      }
    }
    for (const tag of refs.tags) {
      reads.push({
        commit: tag.commit,
        place: { in: 'release', ref: tag.name },
      });
    }
    return { direct, reads };
  }
}

function samePlace(a: ReferencePlace, b: ReferencePlace): boolean {
  return (
    a.in === b.in && ('ref' in a ? a.ref : '') === ('ref' in b ? b.ref : '')
  );
}
