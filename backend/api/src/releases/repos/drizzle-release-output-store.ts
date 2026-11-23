import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  count,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  ne,
  notExists,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { PageRequest, Paginated } from '../../base/core/paging.js';
import type { Transaction } from '../../base/core/unit-of-work.js';
import { lockFileHashes } from '../../assets/repos/drizzle-asset-uploads.js';
import { Database } from '../../database/database.js';
import { drizzleOf } from '../../database/drizzle-unit-of-work.js';
import {
  type AudienceLang,
  isOutputId,
  type NewReleaseOutput,
  type OutputCounts,
  type OutputError,
  type OutputFilter,
  type OutputKind,
  type OutputState,
  type PlanRefusal,
  type PlanRefusalReason,
  type ReleaseOutput,
} from '../core/release-output.js';
import { isReleaseId } from '../core/release.js';
import {
  type GroupJoin,
  type GroupMember,
  ReleaseOutputStore,
} from '../core/release-output-store.js';
import {
  releaseOutputRefusals as refusals,
  releasePlannings,
  releaseOutputSweeps as sweeps,
  releaseOutputs as t,
  releases,
} from './releases.tables.js';

type Row = typeof t.$inferSelect;

/** Rows per insert statement: well below Postgres's 65,535 parameters. */
const INSERT_BATCH = 500;

/** The list's order, which the unique index holds. */
const ORDER = [asc(t.manualId), asc(t.variant), asc(t.lang), asc(t.kind)];

/** The same order in memory, for rows an `UPDATE … RETURNING` gives in no particular order. */
const inOrder = (a: Row, b: Row) =>
  a.manualId.localeCompare(b.manualId) ||
  a.variant.localeCompare(b.variant) ||
  a.lang.localeCompare(b.lang) ||
  a.kind.localeCompare(b.kind);

/** The first key of the advisory lock `schedule` holds per release (the second: the release's hash). */
const SCHEDULE_LOCK = 497;

/** Takes the advisory lock `schedule` and `promote` hold per release, until the transaction ends. */
async function lockRelease(
  db: ReturnType<typeof drizzleOf>,
  releaseId: string,
): Promise<void> {
  await db.execute(
    sql`select pg_advisory_xact_lock(${SCHEDULE_LOCK}::int4, hashtext(${releaseId}::text))`,
  );
}

/** The rows of `output`'s reuse group with its very inputs (#497); undefined for none. */
function sameGroup(output: GroupMember) {
  if (output.reuseGroup === null || !isOutputId(output.reuseGroup)) {
    return undefined;
  }
  return and(
    eq(t.reuseGroup, output.reuseGroup),
    eq(t.manualId, output.manualId),
    eq(t.variant, output.variant),
    eq(t.lang, output.lang),
    eq(t.kind, output.kind),
    output.audience === null
      ? isNull(t.audience)
      : eq(t.audience, output.audience),
  );
}

/** Still to render: queued or rendering. */
const PENDING = ['queued', 'rendering'] as const;

/** The outputs whose audience and language are among `visible` (not empty). */
function among(visible: readonly AudienceLang[]): SQL {
  // `<audience>|<lang>`, '' for no audience: neither a configuration key
  // nor a language tag holds "|", and a configured audience is never empty.
  const pairs = visible.map((v) => `${v.audience ?? ''}|${v.lang}`);
  return inArray(sql`coalesce(${t.audience}, '') || '|' || ${t.lang}`, pairs);
}

/** `ReleaseOutputStore` over the `release_outputs` table. */
@Injectable()
export class DrizzleReleaseOutputStore extends ReleaseOutputStore {
  constructor(private readonly database: Database) {
    super();
  }

  async insertMissing(
    tx: Transaction,
    outputs: readonly NewReleaseOutput[],
  ): Promise<ReleaseOutput[]> {
    const db = drizzleOf(tx);
    const now = new Date();
    const inserted: ReleaseOutput[] = [];
    for (let i = 0; i < outputs.length; i += INSERT_BATCH) {
      const rows = await db
        .insert(t)
        .values(
          outputs.slice(i, i + INSERT_BATCH).map((o) => ({
            id: o.id,
            releaseId: o.releaseId,
            kind: o.kind,
            manualId: o.manualId,
            variant: o.variant,
            lang: o.lang,
            audience: o.audience,
            state: o.state,
            sha256: o.sha256,
            size: o.size,
            reusedFromRelease: o.reusedFrom?.releaseId ?? null,
            reusedFromOutput: o.reusedFrom?.outputId ?? null,
            reuseGroup: o.reuseGroup,
            qrCode: o.qrCode,
            createdAt: now,
            updatedAt: now,
            finishedAt: o.state === 'done' ? now : null,
          })),
        )
        .onConflictDoNothing({
          target: [t.releaseId, t.manualId, t.variant, t.lang, t.kind],
        })
        .returning();
      inserted.push(...rows.map(toOutput));
    }
    return inserted;
  }

  async find(id: string): Promise<ReleaseOutput | undefined> {
    if (!isOutputId(id)) return undefined;
    const [row] = await this.database.db.select().from(t).where(eq(t.id, id));
    return row && toOutput(row);
  }

  async findOf(
    releaseId: string,
    of: { manualId: string; variant: string; lang: string; kind: OutputKind },
  ): Promise<ReleaseOutput | undefined> {
    if (!isReleaseId(releaseId)) return undefined;
    const [row] = await this.database.db
      .select()
      .from(t)
      .where(
        and(
          eq(t.releaseId, releaseId),
          eq(t.manualId, of.manualId),
          eq(t.variant, of.variant),
          eq(t.lang, of.lang),
          eq(t.kind, of.kind),
        ),
      )
      .limit(1);
    return row && toOutput(row);
  }

  async across(
    releaseIds: readonly string[],
    of: { manualId: string; variant: string; lang: string; kind: OutputKind },
  ): Promise<ReleaseOutput[]> {
    const ids = releaseIds.filter(isReleaseId);
    if (ids.length === 0) return [];
    const rows = await this.database.db
      .select()
      .from(t)
      .where(
        and(
          inArray(t.releaseId, ids),
          eq(t.manualId, of.manualId),
          eq(t.variant, of.variant),
          eq(t.lang, of.lang),
          eq(t.kind, of.kind),
        ),
      );
    return rows.map(toOutput);
  }

  async all(releaseId: string): Promise<ReleaseOutput[]> {
    const rows = await this.database.db
      .select()
      .from(t)
      .where(eq(t.releaseId, releaseId))
      .orderBy(...ORDER);
    return rows.map(toOutput);
  }

  async audiences(releaseId: string): Promise<AudienceLang[]> {
    const rows = await this.database.db
      .selectDistinct({ audience: t.audience, lang: t.lang })
      .from(t)
      .where(eq(t.releaseId, releaseId));
    return rows;
  }

  async counts(
    releaseId: string,
    visible: readonly AudienceLang[],
  ): Promise<OutputCounts> {
    const counts = { queued: 0, rendering: 0, done: 0, failed: 0 };
    if (visible.length === 0) return counts;
    const rows = await this.database.db
      .select({ state: t.state, n: count() })
      .from(t)
      .where(and(eq(t.releaseId, releaseId), among(visible)))
      .groupBy(t.state);
    for (const { state, n } of rows) counts[state as OutputState] = n;
    return counts;
  }

  async list(
    releaseId: string,
    filter: OutputFilter,
    visible: readonly AudienceLang[],
    page: PageRequest,
  ): Promise<Paginated<ReleaseOutput>> {
    if (visible.length === 0) return { total: 0, items: [] };
    const where = and(
      eq(t.releaseId, releaseId),
      among(visible),
      ...conditions(filter),
    );
    // One snapshot, so the page and the total agree.
    const [rows, [counted]] = await this.database.db.transaction(
      async (tx) => [
        await tx
          .select()
          .from(t)
          .where(where)
          .orderBy(...ORDER)
          .limit(page.size)
          .offset((page.number - 1) * page.size),
        await tx.select({ total: count() }).from(t).where(where),
      ],
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
    return { total: counted?.total ?? 0, items: rows.map(toOutput) };
  }

  async start(id: string, retries: number): Promise<ReleaseOutput | undefined> {
    if (!isOutputId(id)) return undefined;
    const [row] = await this.database.db
      .update(t)
      .set({
        state: 'rendering',
        attempts: sql`${t.attempts} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(t.id, id),
          eq(t.retries, retries),
          inArray(t.state, ['queued', 'rendering']),
        ),
      )
      .returning();
    return row && toOutput(row);
  }

  async finish(
    id: string,
    file: { readonly sha256: string; readonly size: number },
    tx?: Transaction,
  ): Promise<ReleaseOutput | undefined> {
    const run = async (db: ReturnType<typeof drizzleOf>) => {
      // The file's hash lock first, before any row (#593): a file delete
      // holds it from its check to its blob's removal.
      await lockFileHashes(db, [file.sha256]);
      // The row as it was, locked until the transaction ends: two finishing
      // at once change it (and see it unfinished) once.
      const [before] = await db
        .select()
        .from(t)
        .where(and(eq(t.id, id), ne(t.state, 'done')))
        .for('update');
      if (!before) return undefined;
      const now = new Date();
      await db
        .update(t)
        .set({
          state: 'done',
          sha256: file.sha256,
          size: file.size,
          errorCode: null,
          errorDetail: null,
          updatedAt: now,
          finishedAt: now,
        })
        .where(eq(t.id, id));
      return toOutput(before);
    };
    return tx
      ? run(drizzleOf(tx))
      : this.database.db.transaction((db) => run(db));
  }

  async noteError(
    id: string,
    error: OutputError,
    retries: number,
  ): Promise<void> {
    await this.database.db
      .update(t)
      .set({
        errorCode: error.code,
        errorDetail: error.detail,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(t.id, id),
          eq(t.retries, retries),
          inArray(t.state, ['queued', 'rendering']),
        ),
      );
  }

  async fail(
    tx: Transaction,
    id: string,
    error: OutputError | undefined,
    retries: number,
  ): Promise<ReleaseOutput | undefined> {
    const now = new Date();
    const [row] = await drizzleOf(tx)
      .update(t)
      .set({
        state: 'failed',
        // Never none: a failed output says why, as far as it is known.
        errorCode: error?.code ?? sql`coalesce(${t.errorCode}, 'render-error')`,
        errorDetail:
          error?.detail ??
          sql`coalesce(${t.errorDetail}, 'Rendering failed; the server log says why.')`,
        updatedAt: now,
        finishedAt: now,
      })
      .where(
        and(
          eq(t.id, id),
          eq(t.retries, retries),
          inArray(t.state, ['queued', 'rendering']),
        ),
      )
      .returning();
    return row && toOutput(row);
  }

  async requeue(
    tx: Transaction,
    id: string,
  ): Promise<ReleaseOutput | undefined> {
    const [row] = await drizzleOf(tx)
      .update(t)
      .set({
        state: 'queued',
        retries: sql`${t.retries} + 1`,
        errorCode: null,
        errorDetail: null,
        updatedAt: new Date(),
        finishedAt: null,
        // Its job is queued with it.
        scheduledAt: new Date(),
        // Its own job now: no longer one of the release's moved up.
        promotedAt: null,
      })
      .where(and(eq(t.id, id), eq(t.state, 'failed')))
      .returning();
    return row && toOutput(row);
  }

  async schedule(
    tx: Transaction,
    releaseId: string,
    limit: number,
  ): Promise<ReleaseOutput[]> {
    const db = drizzleOf(tx);
    // One at a time per release, until the transaction ends: the count
    // and the marking below agree, so two at once never pass the limit.
    await lockRelease(db, releaseId);
    const [scheduled] = await db
      .select({ n: count() })
      .from(t)
      .where(
        and(
          eq(t.releaseId, releaseId),
          inArray(t.state, PENDING),
          isNotNull(t.scheduledAt),
        ),
      );
    const room = limit - (scheduled?.n ?? 0);
    if (room <= 0) return [];
    // An offline package (#59) holds the release's PDFs: it waits until none is still to render.
    const pdfs = alias(t, 'pdfs');
    const next = db
      .select({ id: t.id })
      .from(t)
      .where(
        and(
          eq(t.releaseId, releaseId),
          eq(t.state, 'queued'),
          isNull(t.scheduledAt),
          or(
            ne(t.kind, 'offline-package'),
            notExists(
              db
                .select({ id: pdfs.id })
                .from(pdfs)
                .where(
                  and(
                    eq(pdfs.releaseId, releaseId),
                    eq(pdfs.kind, 'pdf'),
                    inArray(pdfs.state, PENDING),
                  ),
                ),
            ),
          ),
        ),
      )
      .orderBy(...ORDER)
      .limit(room);
    const rows = await db
      .update(t)
      .set({ scheduledAt: new Date() })
      .where(and(inArray(t.id, next), isNull(t.scheduledAt)))
      .returning();
    return rows.sort(inOrder).map(toOutput);
  }

  async promote(
    tx: Transaction,
    id: string,
    limit: number,
  ): Promise<{ output: ReleaseOutput; scheduled: boolean } | undefined> {
    if (!isOutputId(id)) return undefined;
    const db = drizzleOf(tx);
    const [found] = await db
      .select({ releaseId: t.releaseId })
      .from(t)
      .where(and(eq(t.id, id), eq(t.state, 'queued'), isNull(t.promotedAt)));
    if (!found) return undefined;
    // The release's lock, as `schedule` takes it: the count holds.
    await lockRelease(db, found.releaseId);
    const [promoted] = await db
      .select({ n: count() })
      .from(t)
      .where(
        and(
          eq(t.releaseId, found.releaseId),
          inArray(t.state, PENDING),
          isNotNull(t.promotedAt),
        ),
      );
    if ((promoted?.n ?? 0) >= limit) return undefined;
    const [before] = await db
      .select({ scheduledAt: t.scheduledAt })
      .from(t)
      .where(and(eq(t.id, id), eq(t.state, 'queued'), isNull(t.promotedAt)));
    if (!before) return undefined;
    const now = new Date();
    const [row] = await db
      .update(t)
      .set({ promotedAt: now, scheduledAt: before.scheduledAt ?? now })
      .where(and(eq(t.id, id), eq(t.state, 'queued'), isNull(t.promotedAt)))
      .returning();
    return (
      row && { output: toOutput(row), scheduled: before.scheduledAt === null }
    );
  }

  async stalled(
    before: Date,
    limit: number,
    after?: string,
  ): Promise<string[]> {
    const moved = sql`max(greatest(${t.updatedAt}, coalesce(${t.scheduledAt}, ${t.updatedAt})))`;
    const rows = await this.database.db
      .select({ releaseId: t.releaseId })
      .from(t)
      .where(
        and(
          inArray(t.state, PENDING),
          after !== undefined && isReleaseId(after)
            ? gt(t.releaseId, after)
            : undefined,
        ),
      )
      .groupBy(t.releaseId)
      .having(sql`${moved} < ${before.toISOString()}::timestamptz`)
      .orderBy(asc(t.releaseId))
      .limit(limit);
    return rows.map((r) => r.releaseId);
  }

  async sweepCursor(): Promise<{ after?: string; version: number }> {
    const [row] = await this.database.db
      .select({ after: sweeps.after, version: sweeps.version })
      .from(sweeps)
      .where(eq(sweeps.id, 1));
    if (!row) return { version: 0 };
    return {
      ...(row.after === null ? {} : { after: row.after }),
      version: row.version,
    };
  }

  async moveSweepCursor(
    version: number,
    after: string | undefined,
  ): Promise<boolean> {
    const next = {
      after: after ?? null,
      version: version + 1,
      sweptAt: new Date(),
    };
    // The first sweep ever makes the row (version 0 stands for none).
    const rows =
      version === 0
        ? await this.database.db
            .insert(sweeps)
            .values({ id: 1, ...next })
            .onConflictDoNothing()
            .returning({ id: sweeps.id })
        : await this.database.db
            .update(sweeps)
            .set(next)
            .where(and(eq(sweeps.id, 1), eq(sweeps.version, version)))
            .returning({ id: sweeps.id });
    return rows.length === 1;
  }

  async scheduled(releaseId: string): Promise<ReleaseOutput[]> {
    const rows = await this.database.db
      .select()
      .from(t)
      .where(
        and(
          eq(t.releaseId, releaseId),
          inArray(t.state, PENDING),
          isNotNull(t.scheduledAt),
        ),
      )
      .orderBy(...ORDER);
    return rows.map(toOutput);
  }

  async oldestPendingIn(
    output: GroupMember & { readonly id: string },
  ): Promise<ReleaseOutput | undefined> {
    const group = sameGroup(output);
    const [row] = await this.database.db
      .select({ output: t })
      .from(t)
      .innerJoin(releases, eq(releases.id, t.releaseId))
      .where(
        group
          ? and(group, inArray(t.state, PENDING))
          : and(eq(t.id, output.id), inArray(t.state, PENDING)),
      )
      .orderBy(asc(releases.publishedAt), asc(releases.id))
      .limit(1);
    return row && toOutput(row.output);
  }

  async doneIn(output: GroupMember): Promise<ReleaseOutput | undefined> {
    const group = sameGroup(output);
    if (!group) return undefined;
    const [row] = await this.database.db
      .select()
      .from(t)
      .where(
        and(
          group,
          eq(t.state, 'done'),
          // Its file rendered for this release or an earlier one.
          sql`exists (select 1 from ${releases} s, ${releases} o where s.id = coalesce(${t.reusedFromRelease}, ${t.releaseId}) and o.id = ${output.releaseId}::uuid and (s.published_at, s.id) <= (o.published_at, o.id))`,
        ),
      )
      .limit(1);
    return row && toOutput(row);
  }

  async finishGroup(
    output: GroupMember,
    file: { readonly sha256: string; readonly size: number },
    from: { readonly releaseId: string; readonly outputId: string },
    tx?: Transaction,
  ): Promise<ReleaseOutput[]> {
    const group = sameGroup(output);
    if (!group) return [];
    const run = async (db: ReturnType<typeof drizzleOf>) => {
      // The file's hash lock first, before any member's row (#593), as `finish`.
      await lockFileHashes(db, [file.sha256]);
      return this.#finishGroup(db, group, file, from);
    };
    const rows = tx
      ? await run(drizzleOf(tx))
      : await this.database.db.transaction((db) => run(db));
    return rows.map(toOutput);
  }

  async #finishGroup(
    db: ReturnType<typeof drizzleOf>,
    group: SQL,
    file: { readonly sha256: string; readonly size: number },
    from: { readonly releaseId: string; readonly outputId: string },
  ): Promise<Row[]> {
    const now = new Date();
    return db
      .update(t)
      .set({
        state: 'done',
        sha256: file.sha256,
        size: file.size,
        errorCode: null,
        errorDetail: null,
        reusedFromRelease: from.releaseId,
        reusedFromOutput: from.outputId,
        updatedAt: now,
        finishedAt: now,
      })
      .where(
        and(
          group,
          inArray(t.state, PENDING),
          // Only releases cut at or after the file's own.
          sql`exists (select 1 from ${releases} m, ${releases} f where m.id = ${t.releaseId} and f.id = ${from.releaseId}::uuid and (m.published_at, m.id) >= (f.published_at, f.id))`,
        ),
      )
      .returning();
  }

  async planned(releaseIds: readonly string[]): Promise<Set<string>> {
    const ids = releaseIds.filter(isReleaseId);
    if (ids.length === 0) return new Set();
    // One output each is enough: the unique index leads with the release.
    const rows = await this.database.db
      .select({ id: releases.id })
      .from(releases)
      .where(
        and(
          inArray(releases.id, ids),
          exists(
            this.database.db
              .select({ one: sql`1` })
              .from(t)
              .where(eq(t.releaseId, releases.id)),
          ),
        ),
      );
    return new Set(rows.map((r) => r.id));
  }

  async markPlanned(releaseId: string): Promise<void> {
    await this.database.db
      .insert(releasePlannings)
      .values({ releaseId, plannedAt: sql`now()` })
      .onConflictDoNothing({ target: releasePlannings.releaseId });
  }

  async plannedWholly(
    releaseIds: readonly string[],
  ): Promise<ReadonlyMap<string, Date>> {
    const ids = releaseIds.filter(isReleaseId);
    if (ids.length === 0) return new Map();
    const rows = await this.database.db
      .select({
        id: releasePlannings.releaseId,
        at: releasePlannings.plannedAt,
      })
      .from(releasePlannings)
      .where(inArray(releasePlannings.releaseId, ids));
    return new Map(rows.map((r) => [r.id, r.at]));
  }

  async joinGroups(
    tx: Transaction,
    joins: readonly GroupJoin[],
  ): Promise<void> {
    const db = drizzleOf(tx);
    for (const join of joins) {
      if (!isOutputId(join.from) || !isOutputId(join.into)) continue;
      if (join.from === join.into) continue;
      const group = sameGroup({
        ...join,
        releaseId: '',
        reuseGroup: join.from,
      });
      await db.update(t).set({ reuseGroup: join.into }).where(group);
    }
  }

  async ahead(release: {
    readonly id: string;
    readonly publishedAt: Date;
    readonly product: string;
    readonly productFacet: string;
  }): Promise<number> {
    const [row] = await this.database.db
      .select({ n: count() })
      .from(t)
      .innerJoin(releases, eq(releases.id, t.releaseId))
      .where(
        and(
          inArray(t.state, PENDING),
          eq(releases.product, release.product),
          eq(releases.productFacet, release.productFacet),
          sql`(${releases.publishedAt}, ${releases.id}) > (${release.publishedAt.toISOString()}::timestamptz, ${release.id}::uuid)`,
        ),
      );
    return row?.n ?? 0;
  }

  async refusal(releaseId: string): Promise<PlanRefusal | undefined> {
    if (!isReleaseId(releaseId)) return undefined;
    const [row] = await this.database.db
      .select()
      .from(refusals)
      .where(eq(refusals.releaseId, releaseId));
    return row
      ? {
          reason: row.reason as PlanRefusalReason,
          wanted: row.wanted,
          max: row.max,
          refusedAt: row.refusedAt,
        }
      : undefined;
  }

  async refuse(
    releaseId: string,
    refusal: Omit<PlanRefusal, 'refusedAt'>,
  ): Promise<boolean> {
    const values = { ...refusal, releaseId, refusedAt: new Date() };
    // Written unless the same refusal is there already: one row either way.
    const rows = await this.database.db
      .insert(refusals)
      .values(values)
      .onConflictDoUpdate({
        target: refusals.releaseId,
        set: {
          reason: values.reason,
          wanted: values.wanted,
          max: values.max,
          refusedAt: values.refusedAt,
        },
        setWhere: sql`(${refusals.reason}, ${refusals.wanted}, ${refusals.max}) is distinct from (excluded.reason, excluded.wanted, excluded.max)`,
      })
      .returning({ releaseId: refusals.releaseId });
    return rows.length > 0;
  }

  async clearRefusal(tx: Transaction, releaseId: string): Promise<void> {
    await drizzleOf(tx)
      .delete(refusals)
      .where(eq(refusals.releaseId, releaseId));
  }
}

function conditions(filter: OutputFilter): SQL[] {
  return [
    ...(filter.manual !== undefined ? [eq(t.manualId, filter.manual)] : []),
    ...(filter.lang !== undefined ? [eq(t.lang, filter.lang)] : []),
    ...(filter.kind !== undefined ? [eq(t.kind, filter.kind)] : []),
    ...(filter.state !== undefined ? [eq(t.state, filter.state)] : []),
  ];
}

function toOutput(row: Row): ReleaseOutput {
  return {
    id: row.id,
    releaseId: row.releaseId,
    manualId: row.manualId,
    variant: row.variant,
    lang: row.lang,
    kind: row.kind as OutputKind,
    audience: row.audience,
    state: row.state as OutputState,
    sha256: row.sha256,
    size: row.size,
    error:
      row.errorCode !== null && row.errorDetail !== null
        ? { code: row.errorCode, detail: row.errorDetail }
        : null,
    reusedFrom:
      row.reusedFromRelease !== null && row.reusedFromOutput !== null
        ? { releaseId: row.reusedFromRelease, outputId: row.reusedFromOutput }
        : null,
    attempts: row.attempts,
    retries: row.retries,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    finishedAt: row.finishedAt,
    scheduledAt: row.scheduledAt,
    reuseGroup: row.reuseGroup,
    promotedAt: row.promotedAt,
    qrCode: row.qrCode ?? null,
  };
}
