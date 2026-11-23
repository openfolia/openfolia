import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { NotFoundError } from '../../base/core/errors.js';
import { Recent } from '../../base/core/recent.js';
import { ListChunksAction } from '../../chunks/core/actions/list-chunks.action.js';
import { OpenSnapshotAction } from '../../content/core/actions/open-snapshot.action.js';
import type { Release } from '../../releases/core/release.js';
import { ReleaseStore } from '../../releases/core/release-store.js';
import { readerOf, scopeDigest } from './feed-scopes.js';

/** One chunk as the feed compares it. */
export interface FeedChunk {
  /** `<lang>/<moduleId>`, or `<lang>/<moduleId>/<blockId>` for an FAQ entry: `GET /chunks`'s ID. */
  readonly id: string;
  readonly moduleId: string;
  readonly lang: string;
  readonly blockId?: string;
  /** SHA-256 of the chunk's text, as `GET /chunks` gives it. */
  readonly contentHash: string;
  /** SHA-256 of the text and every attribute a retrieval index filters on: what tells an upsert. */
  readonly fingerprint: string;
}

/** The release the chunks of a state were read at. */
export interface StateRelease {
  readonly releaseId: string;
  readonly product: string;
  readonly revision: string;
  readonly tag: string;
  readonly commit: string;
}

/** The chunks one reader holds in one released state. */
export interface ChunkState {
  /** Null for the state before anything was released: no chunks. */
  readonly release: StateRelease | null;
  /** By `id`; the modules deprecated with no replacement are not here. */
  readonly chunks: ReadonlyMap<string, FeedChunk>;
  /** The IDs of the chunks left out for being deprecated with no replacement. */
  readonly deprecated: ReadonlySet<string>;
}

/**
 * Port: the chunks a reader of `scopes` holds at a release (null: none
 * yet). The same release and scopes always give the same state.
 */
export abstract class ChunkStates {
  abstract of(
    releaseId: string | null,
    scopes: readonly string[],
  ): Promise<ChunkState>;
}

/** How many states (per release and scopes) are kept in memory. */
export const STATES_KEPT = 8;

/**
 * `ChunkStates` over the retrieval chunks (#52): the content at the
 * release's tag, read as a reader of exactly those scopes reads it
 * (`readerOf`), so a module outside them is never a chunk nor in one,
 * through the chunk sets `ListChunksAction` keeps. A module deprecated in
 * its source-language file (#266) with no replacement is left out, as
 * the feed tells a retrieval index to drop it; one with a replacement
 * stays. A reader who may not read the source-language file is judged by
 * the deprecation of the file they read.
 */
@Injectable()
export class ReleasedChunkStates extends ChunkStates {
  readonly #states = new Recent<ChunkState>(STATES_KEPT);

  constructor(
    private readonly releases: ReleaseStore,
    private readonly openSnapshot: OpenSnapshotAction,
    private readonly chunks: ListChunksAction,
  ) {
    super();
  }

  of(releaseId: string | null, scopes: readonly string[]): Promise<ChunkState> {
    if (releaseId === null) {
      return Promise.resolve({
        release: null,
        chunks: new Map(),
        deprecated: new Set(),
      });
    }
    return this.#states.get(`${releaseId}|${scopeDigest(scopes)}`, () =>
      this.read(releaseId, scopes),
    );
  }

  private async read(
    releaseId: string,
    scopes: readonly string[],
  ): Promise<ChunkState> {
    const release = await this.releases.find(releaseId);
    // The outbox names published releases only, and none is ever deleted.
    if (!release) throw new NotFoundError(`No release "${releaseId}".`);
    const chunks = new Map<string, FeedChunk>();
    const deprecated = new Set<string>();
    if (scopes.length > 0) {
      const actor = readerOf(scopes);
      const snapshot = await this.openSnapshot.handle({
        actor,
        // By commit, not by tag name: a branch could have that name too.
        ref: release.commit,
      });
      const set = await this.chunks.everyChunk({ actor, snapshot });
      for (const chunk of set.chunks) {
        const id = chunk.entry
          ? `${chunk.lang}/${chunk.moduleId}/${chunk.entry.blockId}`
          : `${chunk.lang}/${chunk.moduleId}`;
        const module =
          set.modules.get(`${set.source}/${chunk.moduleId}`) ??
          set.modules.get(`${chunk.lang}/${chunk.moduleId}`);
        const deprecation = module?.meta.deprecated;
        if (deprecation && !deprecation.replacedBy) {
          deprecated.add(id);
          continue;
        }
        chunks.set(id, {
          id,
          moduleId: chunk.moduleId,
          lang: chunk.lang,
          ...(chunk.entry && { blockId: chunk.entry.blockId }),
          contentHash: chunk.contentHash,
          fingerprint: fingerprintOf(chunk),
        });
      }
    }
    return { release: stateRelease(release), chunks, deprecated };
  }
}

function stateRelease(release: Release): StateRelease {
  return {
    releaseId: release.id,
    product: release.product,
    revision: release.revision,
    tag: release.tag,
    commit: release.commit,
  };
}

/** Over what `GET /chunks` answers of a chunk but its text (its hash stands for it) and `meta.release`. */
function fingerprintOf(chunk: {
  readonly contentHash: string;
  readonly sourceHash: string;
  readonly title: string;
  readonly moduleType: string;
  readonly audience?: string | undefined;
  readonly facets: Readonly<Record<string, readonly string[]>>;
  readonly keywords: readonly string[];
  readonly manuals: readonly string[];
  readonly conditions: readonly string[];
  readonly entry?:
    { readonly blockId: string; readonly question: string } | undefined;
}): string {
  const facets = Object.keys(chunk.facets)
    .sort()
    .map((facet) => [facet, [...(chunk.facets[facet] ?? [])].sort()]);
  return createHash('sha256')
    .update(
      JSON.stringify([
        chunk.contentHash,
        chunk.sourceHash,
        chunk.title,
        chunk.moduleType,
        chunk.audience ?? null,
        facets,
        chunk.keywords,
        chunk.manuals,
        chunk.conditions,
        chunk.entry?.question ?? null,
      ]),
    )
    .digest('hex');
}
