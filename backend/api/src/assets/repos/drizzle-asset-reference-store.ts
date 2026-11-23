import { Injectable } from '@nestjs/common';
import { and, inArray, lt, notInArray, sql } from 'drizzle-orm';
import { Database } from '../../database/database.js';
import {
  AssetReferenceStore,
  PRUNE_AFTER_MS,
} from '../core/asset-reference-index.js';
import { assetReferenceCommits } from './asset-references.tables.js';

/** Commits per query, well below Postgres' 65,535 parameters. */
const COMMITS_PER_QUERY = 5000;

const t = assetReferenceCommits;

/** `AssetReferenceStore` over `asset_reference_commits`. */
@Injectable()
export class DrizzleAssetReferenceStore extends AssetReferenceStore {
  constructor(private readonly database: Database) {
    super();
  }

  async referencedAt(commits: readonly string[]) {
    const indexed = new Set<string>();
    const hashes = new Set<string>();
    if (commits.length === 0) return { indexed, hashes };
    // One snapshot: a commit dropped meanwhile is read whole or not at all.
    await this.database.db.transaction(
      async (tx) => {
        for (const part of chunks(commits, COMMITS_PER_QUERY)) {
          const built = await tx
            .select({ commit: t.commit })
            .from(t)
            .where(inArray(t.commit, part));
          for (const row of built) indexed.add(row.commit);
          // Each hash once, from the database: not every commit's whole list.
          const used = await tx.execute<{ sha256: string }>(
            sql`select distinct h as sha256 from ${t} cross join lateral unnest(${t.hashes}) as h where ${inArray(t.commit, part)}`,
          );
          for (const row of used.rows) hashes.add(row.sha256);
        }
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
    return { indexed, hashes };
  }

  async mentioning(hashes: readonly string[], commits: readonly string[]) {
    const indexed = new Set<string>();
    const found = new Map<string, string[]>();
    if (commits.length === 0) return { indexed, commits: found };
    const wanted = [...new Set(hashes)];
    await this.database.db.transaction(
      async (tx) => {
        for (const part of chunks(commits, COMMITS_PER_QUERY)) {
          const built = await tx
            .select({ commit: t.commit })
            .from(t)
            .where(inArray(t.commit, part));
          for (const row of built) indexed.add(row.commit);
          if (wanted.length === 0) continue;
          const list = sql.join(
            wanted.map((hash) => sql`${hash}`),
            sql`, `,
          );
          const rows = await tx.execute<{ commit: string; sha256: string }>(
            sql`select ${t.commit} as commit, h as sha256 from ${t} cross join lateral unnest(${t.hashes}) as h where ${inArray(t.commit, part)} and h in (${list})`,
          );
          for (const row of rows.rows) {
            const at = found.get(row.sha256);
            if (at) at.push(row.commit);
            else found.set(row.sha256, [row.commit]);
          }
        }
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
    return { indexed, commits: found };
  }

  async put(
    commit: string,
    hashes: readonly string[],
    keep: readonly string[],
  ): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      // Waits for another server writing the same commit, then does nothing.
      const added = await tx
        .insert(t)
        .values({ commit, hashes: [...new Set(hashes)].sort() })
        .onConflictDoNothing()
        .returning({ commit: t.commit });
      if (added.length === 0) return;
      // So many refs that one statement cannot name them: nothing is dropped.
      if (keep.length >= COMMITS_PER_QUERY) return;
      await tx
        .delete(t)
        .where(
          and(
            lt(
              t.builtAt,
              sql`now() - make_interval(secs => ${PRUNE_AFTER_MS / 1000})`,
            ),
            notInArray(t.commit, [...keep, commit]),
          ),
        );
    });
  }

  async clear(): Promise<void> {
    await this.database.db.delete(t);
  }
}

function* chunks<T>(rows: readonly T[], size: number): Generator<T[]> {
  for (let start = 0; start < rows.length; start += size) {
    yield rows.slice(start, start + size);
  }
}
