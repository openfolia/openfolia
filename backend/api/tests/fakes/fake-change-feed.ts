import {
  InvalidContentError,
  NotFoundError,
} from '../../src/base/core/errors.js';
import type { Scope } from '../../src/access/core/actor.js';
import {
  ChangeFeedSource,
  isAfter,
} from '../../src/changes/core/change-feed-source.js';
import {
  type ChunkState,
  ChunkStates,
  type FeedChunk,
} from '../../src/changes/core/chunk-states.js';
import { FeedScopes } from '../../src/changes/core/feed-scopes.js';
import { ChunkSetTooLargeError } from '../../src/chunks/core/chunk-set-too-large.js';
import {
  type OutboxEvent,
  type OutboxPosition,
  START,
} from '../../src/outbox/core/outbox-feed.js';

/**
 * The feed's outbox rows in memory, in `(tx, id)` order. A `pending` row
 * stands for a transaction still running: it and every row after it are
 * not settled yet. Releases of a maintenance line are in `lineReleases`.
 */
export class FakeChangeFeedSource extends ChangeFeedSource {
  readonly rows: (OutboxEvent & { pending?: boolean })[] = [];
  readonly lineReleases = new Set<string>();
  /** Held after a restore (`blocked`). */
  held = false;
  private nextId = 1;
  private nextTx = 100;

  add(
    topic: string,
    payload: Record<string, unknown>,
    options: { pending?: boolean } = {},
  ): OutboxEvent & { pending?: boolean } {
    const id = this.nextId++;
    const row = {
      position: { tx: String(this.nextTx++), id },
      topic,
      key: `key-${id}`,
      payload,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, id)),
      ...(options.pending && { pending: true }),
    };
    this.rows.push(row);
    return row;
  }

  private settled(): OutboxEvent[] {
    const out: OutboxEvent[] = [];
    for (const row of this.rows) {
      if (row.pending) break;
      out.push(row);
    }
    return out;
  }

  async blocked(): Promise<boolean> {
    return this.held;
  }

  async holds(position: OutboxPosition): Promise<boolean> {
    if (position.tx === START.tx && position.id === START.id) return true;
    return this.rows.some(
      (r) => r.position.tx === position.tx && r.position.id === position.id,
    );
  }

  async horizon(): Promise<OutboxPosition> {
    return this.settled().at(-1)?.position ?? START;
  }

  async after(position: OutboxPosition, limit: number): Promise<OutboxEvent[]> {
    return this.settled()
      .filter((r) => isAfter(r.position, position))
      .slice(0, limit);
  }

  async standingAt(position: OutboxPosition): Promise<string | undefined> {
    const upTo = this.rows.filter((r) => !isAfter(r.position, position));
    const withdrawn = new Set(
      upTo
        .filter((r) => r.topic === 'release.withdrawn')
        .map((r) => String(r.payload['releaseId'])),
    );
    return upTo
      .filter(
        (r) =>
          r.topic === 'release.published' &&
          !withdrawn.has(String(r.payload['releaseId'])) &&
          !this.lineReleases.has(String(r.payload['releaseId'])),
      )
      .map((r) => String(r.payload['releaseId']))
      .at(-1);
  }
}

export class FakeFeedScopes extends FeedScopes {
  readonly kept = new Map<string, readonly string[]>();

  async save(digest: string, scopes: readonly string[]): Promise<void> {
    if (!this.kept.has(digest)) this.kept.set(digest, [...scopes]);
  }

  async find(digest: string): Promise<readonly string[] | undefined> {
    return this.kept.get(digest);
  }
}

/** A chunk of a fake release: its ID (`<lang>/<moduleId>`) and a version (its fingerprint). */
export interface FakeChunk {
  readonly id: string;
  readonly version: string;
  readonly deprecated?: boolean;
}

/**
 * Releases as lists of chunks; a reader sees a chunk when one of their
 * scopes has no `languages`, or names the chunk's language.
 */
export class FakeChunkStates extends ChunkStates {
  readonly releases = new Map<string, readonly FakeChunk[]>();
  /** `release|scopes` of every state read. */
  readonly reads: string[] = [];
  /** Releases whose content does not read (an invalid configuration). */
  readonly unreadable = new Set<string>();
  /** `release|scopes` (joined by commas) that do not read for a reader of exactly those scopes. */
  readonly unreadableFor = new Set<string>();
  /** Releases whose commit is gone from the repository. */
  readonly vanished = new Set<string>();
  /** Releases whose chunks are too large to cut together (#684). */
  readonly tooLarge = new Set<string>();

  async of(
    releaseId: string | null,
    scopes: readonly string[],
  ): Promise<ChunkState> {
    this.reads.push(`${releaseId}|${scopes.join(',')}`);
    const chunks = new Map<string, FeedChunk>();
    const deprecated = new Set<string>();
    if (releaseId === null) return { release: null, chunks, deprecated };
    // A reader without scopes reads nothing, so nothing is opened (as the adapter).
    if (scopes.length === 0) return { release: null, chunks, deprecated };
    if (this.vanished.has(releaseId)) {
      throw new NotFoundError(`No branch, tag or commit "${releaseId}".`);
    }
    if (this.tooLarge.has(releaseId)) {
      throw new ChunkSetTooLargeError({ nodes: 1, chars: 1, cells: 1 }, []);
    }
    if (
      this.unreadable.has(releaseId) ||
      this.unreadableFor.has(`${releaseId}|${scopes.join(',')}`)
    ) {
      throw new InvalidContentError('openfolia.yaml', 'Not a configuration.');
    }
    const parsed = scopes.map((s) => JSON.parse(s) as Scope);
    for (const chunk of this.releases.get(releaseId) ?? []) {
      const [lang = '', moduleId = ''] = chunk.id.split('/');
      if (!parsed.some((s) => !s.languages || s.languages.includes(lang))) {
        continue;
      }
      if (chunk.deprecated) {
        deprecated.add(chunk.id);
        continue;
      }
      chunks.set(chunk.id, {
        id: chunk.id,
        moduleId,
        lang,
        contentHash: `hash-${chunk.version}`,
        fingerprint: chunk.version,
      });
    }
    return {
      release: {
        releaseId,
        product: 'north',
        revision: releaseId,
        tag: `release/north/${releaseId}`,
        commit: 'c'.repeat(40),
      },
      chunks,
      deprecated,
    };
  }
}
