import { paginate, type PageRequest } from '../../src/base/core/paging.js';
import type { Transaction } from '../../src/base/core/unit-of-work.js';
import type {
  AudienceLang,
  NewReleaseOutput,
  OutputCounts,
  OutputError,
  OutputFilter,
  PlanRefusal,
  ReleaseOutput,
} from '../../src/releases/core/release-output.js';
import {
  type GroupJoin,
  type GroupMember,
  ReleaseOutputStore,
} from '../../src/releases/core/release-output-store.js';
import type { FakeHashLocks } from './fake-hash-locks.js';
import { fakeOf } from './fake-unit-of-work.js';

const subject = (
  o: Pick<
    ReleaseOutput,
    'releaseId' | 'manualId' | 'variant' | 'lang' | 'kind'
  >,
) => [o.releaseId, o.manualId, o.variant, o.lang, o.kind].join('\0');

const order = (a: ReleaseOutput, b: ReleaseOutput) =>
  (a.manualId ?? '').localeCompare(b.manualId ?? '') ||
  a.variant.localeCompare(b.variant) ||
  a.lang.localeCompare(b.lang) ||
  a.kind.localeCompare(b.kind);

/**
 * Release outputs in memory, with `FakeUnitOfWork`: writes in a
 * transaction are kept only when it commits; the others at once. One per
 * release, kind, manual, variant and language, as the table's index holds.
 */
export class FakeReleaseOutputStore extends ReleaseOutputStore {
  readonly rows: ReleaseOutput[] = [];
  readonly refusals = new Map<string, PlanRefusal>();
  /** When set, `finish` and `finishGroup` inside a transaction hold the file's hash in it (#593). */
  locks?: FakeHashLocks;
  /** When each release was cut, for `ahead` (set by the test, as the releases table holds it). */
  readonly publishedAt = new Map<string, Date>();
  /** Each release's product, for `ahead` (set by the test, as the releases table holds it). */
  readonly products = new Map<
    string,
    { product: string; productFacet: string }
  >();

  async insertMissing(tx: Transaction, outputs: readonly NewReleaseOutput[]) {
    const now = new Date();
    const taken = new Set(this.rows.map(subject));
    const fresh: ReleaseOutput[] = [];
    for (const o of outputs) {
      if (taken.has(subject(o))) continue;
      taken.add(subject(o));
      fresh.push({
        ...o,
        error: null,
        attempts: 0,
        retries: 0,
        createdAt: now,
        updatedAt: now,
        finishedAt: o.state === 'done' ? now : null,
        scheduledAt: null,
        promotedAt: null,
      });
    }
    fakeOf(tx).onCommit(() => this.rows.push(...fresh));
    return fresh;
  }

  async find(id: string) {
    return this.rows.find((r) => r.id === id);
  }

  async findOf(
    releaseId: string,
    of: { manualId: string; variant: string; lang: string; kind: string },
  ) {
    return this.rows.find(
      (r) =>
        r.releaseId === releaseId &&
        r.manualId === of.manualId &&
        r.variant === of.variant &&
        r.lang === of.lang &&
        r.kind === of.kind,
    );
  }

  async across(
    releaseIds: readonly string[],
    of: { manualId: string; variant: string; lang: string; kind: string },
  ) {
    const ids = new Set(releaseIds);
    return this.rows.filter(
      (r) =>
        ids.has(r.releaseId) &&
        r.manualId === of.manualId &&
        r.variant === of.variant &&
        r.lang === of.lang &&
        r.kind === of.kind,
    );
  }

  async all(releaseId: string) {
    return this.rows.filter((r) => r.releaseId === releaseId).sort(order);
  }

  async audiences(releaseId: string): Promise<AudienceLang[]> {
    const seen = new Map<string, AudienceLang>();
    for (const r of await this.all(releaseId)) {
      seen.set(`${r.audience}|${r.lang}`, {
        audience: r.audience,
        lang: r.lang,
      });
    }
    return [...seen.values()];
  }

  async counts(
    releaseId: string,
    visible: readonly AudienceLang[],
  ): Promise<OutputCounts> {
    const counts = { queued: 0, rendering: 0, done: 0, failed: 0 };
    for (const r of await this.all(releaseId)) {
      if (visible.some((v) => v.audience === r.audience && v.lang === r.lang))
        counts[r.state]++;
    }
    return counts;
  }

  async list(
    releaseId: string,
    filter: OutputFilter,
    visible: readonly AudienceLang[],
    page: PageRequest,
  ) {
    const rows = (await this.all(releaseId)).filter(
      (r) =>
        visible.some((v) => v.audience === r.audience && v.lang === r.lang) &&
        (filter.manual === undefined || r.manualId === filter.manual) &&
        (filter.lang === undefined || r.lang === filter.lang) &&
        (filter.kind === undefined || r.kind === filter.kind) &&
        (filter.state === undefined || r.state === filter.state),
    );
    return paginate(rows, page);
  }

  async start(id: string, retries: number) {
    if (this.rows.find((r) => r.id === id)?.retries !== retries)
      return undefined;
    return this.change(id, ['queued', 'rendering'], (r) => ({
      ...r,
      state: 'rendering',
      attempts: r.attempts + 1,
    }));
  }

  /** At once, whether in a transaction or not (`tx` is not waited for). */
  async finish(
    id: string,
    file: { sha256: string; size: number },
    tx?: Transaction,
  ) {
    if (tx) await this.#recording(tx, file);
    const before = this.rows.find((r) => r.id === id);
    if (before && tx) this.#undoing(tx, before);
    const done = this.change(id, ['queued', 'rendering', 'failed'], (r) => ({
      ...r,
      state: 'done',
      ...file,
      error: null,
      finishedAt: new Date(),
    }));
    return done && before;
  }

  async noteError(id: string, error: OutputError, retries: number) {
    if (this.rows.find((r) => r.id === id)?.retries !== retries) return;
    this.change(id, ['queued', 'rendering'], (r) => ({ ...r, error }));
  }

  async fail(
    tx: Transaction,
    id: string,
    error: OutputError | undefined,
    retries: number,
  ) {
    const row = this.rows.find((r) => r.id === id);
    if (
      !row ||
      row.retries !== retries ||
      (row.state !== 'queued' && row.state !== 'rendering')
    ) {
      return undefined;
    }
    const failed: ReleaseOutput = {
      ...row,
      state: 'failed',
      error: error ??
        row.error ?? {
          code: 'render-error',
          detail: 'Rendering failed; the server log says why.',
        },
      updatedAt: new Date(),
      finishedAt: new Date(),
    };
    fakeOf(tx).onCommit(() => this.replace(failed));
    return failed;
  }

  async requeue(tx: Transaction, id: string) {
    const row = this.rows.find((r) => r.id === id);
    if (row?.state !== 'failed') return undefined;
    const queued: ReleaseOutput = {
      ...row,
      state: 'queued',
      retries: row.retries + 1,
      error: null,
      updatedAt: new Date(),
      finishedAt: null,
      scheduledAt: new Date(),
      promotedAt: null,
    };
    fakeOf(tx).onCommit(() => this.replace(queued));
    return queued;
  }

  async schedule(tx: Transaction, releaseId: string, limit: number) {
    const mine = await this.all(releaseId);
    const busy = mine.filter(
      (r) =>
        (r.state === 'queued' || r.state === 'rendering') &&
        r.scheduledAt !== null,
    ).length;
    // An offline package (#59) waits until none of the release's PDFs is still to render.
    const pdfsPending = mine.some(
      (r) =>
        r.kind === 'pdf' && (r.state === 'queued' || r.state === 'rendering'),
    );
    const picked = mine
      .filter(
        (r) =>
          r.state === 'queued' &&
          r.scheduledAt === null &&
          !(r.kind === 'offline-package' && pdfsPending),
      )
      .slice(0, Math.max(0, limit - busy))
      .map((r) => ({ ...r, scheduledAt: new Date() }));
    fakeOf(tx).onCommit(() => picked.forEach((r) => this.replace(r)));
    return picked;
  }

  async promote(tx: Transaction, id: string, limit: number) {
    const row = this.rows.find((r) => r.id === id);
    if (row?.state !== 'queued' || row.promotedAt !== null) return undefined;
    const promoted = (await this.all(row.releaseId)).filter(
      (r) =>
        (r.state === 'queued' || r.state === 'rendering') &&
        r.promotedAt !== null,
    ).length;
    if (promoted >= limit) return undefined;
    const now: ReleaseOutput = {
      ...row,
      promotedAt: new Date(),
      scheduledAt: row.scheduledAt ?? new Date(),
    };
    fakeOf(tx).onCommit(() => this.replace(now));
    return { output: now, scheduled: row.scheduledAt === null };
  }

  async stalled(before: Date, limit: number, after?: string) {
    const moved = new Map<string, number>();
    for (const r of this.rows) {
      if (r.state !== 'queued' && r.state !== 'rendering') continue;
      const at = Math.max(r.updatedAt.getTime(), r.scheduledAt?.getTime() ?? 0);
      moved.set(r.releaseId, Math.max(moved.get(r.releaseId) ?? 0, at));
    }
    return [...moved]
      .filter(
        ([id, at]) =>
          at < before.getTime() && (after === undefined || id > after),
      )
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .slice(0, limit)
      .map(([id]) => id);
  }

  /** The sweep's cursor (#527), as the database row holds it. */
  sweep: { after?: string; version: number } = { version: 0 };

  async sweepCursor() {
    return { ...this.sweep };
  }

  async moveSweepCursor(version: number, after: string | undefined) {
    if (this.sweep.version !== version) return false;
    this.sweep = {
      ...(after === undefined ? {} : { after }),
      version: version + 1,
    };
    return true;
  }

  async scheduled(releaseId: string) {
    return (await this.all(releaseId)).filter(
      (r) =>
        (r.state === 'queued' || r.state === 'rendering') &&
        r.scheduledAt !== null,
    );
  }

  async oldestPendingIn(output: GroupMember & { id: string }) {
    const pending = this.rows.filter(
      (r) =>
        (r.state === 'queued' || r.state === 'rendering') &&
        (output.reuseGroup === null
          ? r.id === output.id
          : sameGroup(r, output)),
    );
    return pending.reduce<ReleaseOutput | undefined>(
      (first, r) =>
        !first || this.cutBefore(r.releaseId, first.releaseId) ? r : first,
      undefined,
    );
  }

  async doneIn(output: GroupMember) {
    return this.rows.find(
      (r) =>
        sameGroup(r, output) &&
        r.state === 'done' &&
        this.cutBefore(
          r.reusedFrom?.releaseId ?? r.releaseId,
          output.releaseId,
        ),
    );
  }

  /** Whether release `a` was cut before `b`, or is `b` (by the `publishedAt` the test set, then ID). */
  private cutBefore(a: string, b: string): boolean {
    const at = this.publishedAt.get(a)?.getTime() ?? 0;
    const bt = this.publishedAt.get(b)?.getTime() ?? 0;
    return at < bt || (at === bt && a <= b);
  }

  async finishGroup(
    output: GroupMember,
    file: { sha256: string; size: number },
    from: { releaseId: string; outputId: string },
    tx?: Transaction,
  ) {
    if (tx && output.reuseGroup !== null) await this.#recording(tx, file);
    const changed: ReleaseOutput[] = [];
    for (const row of [...this.rows]) {
      if (
        !sameGroup(row, output) ||
        !this.cutBefore(from.releaseId, row.releaseId) ||
        (row.state !== 'queued' && row.state !== 'rendering')
      ) {
        continue;
      }
      if (tx) this.#undoing(tx, row);
      const done: ReleaseOutput = {
        ...row,
        state: 'done',
        ...file,
        error: null,
        reusedFrom: from,
        updatedAt: new Date(),
        finishedAt: new Date(),
      };
      this.replace(done);
      changed.push(done);
    }
    return changed;
  }

  async planned(releaseIds: readonly string[]) {
    return new Set(
      releaseIds.filter((id) => this.rows.some((r) => r.releaseId === id)),
    );
  }

  /** The releases planned to the end (`markPlanned`), with when. */
  readonly wholly = new Map<string, Date>();

  async markPlanned(releaseId: string) {
    if (!this.wholly.has(releaseId)) this.wholly.set(releaseId, new Date());
  }

  async plannedWholly(releaseIds: readonly string[]) {
    return new Map(
      releaseIds.flatMap((id) => {
        const at = this.wholly.get(id);
        return at ? [[id, at] as const] : [];
      }),
    );
  }

  async joinGroups(tx: Transaction, joins: readonly GroupJoin[]) {
    const transaction = fakeOf(tx);
    for (const join of joins) {
      const group = { ...join, releaseId: '', reuseGroup: join.from };
      for (const row of [...this.rows]) {
        if (!sameGroup(row, group) || join.from === join.into) continue;
        transaction.onRollback(() => this.replace(row));
        this.replace({ ...row, reuseGroup: join.into });
      }
    }
  }

  async ahead(release: {
    id: string;
    publishedAt: Date;
    product: string;
    productFacet: string;
  }) {
    const later = (id: string) => {
      const at = this.publishedAt.get(id);
      if (!at) return false;
      const product = this.products.get(id);
      if (
        product?.product !== release.product ||
        product.productFacet !== release.productFacet
      ) {
        return false;
      }
      const diff = at.getTime() - release.publishedAt.getTime();
      return diff > 0 || (diff === 0 && id > release.id);
    };
    return this.rows.filter(
      (r) =>
        (r.state === 'queued' || r.state === 'rendering') && later(r.releaseId),
    ).length;
  }

  async refusal(releaseId: string) {
    return this.refusals.get(releaseId);
  }

  async refuse(releaseId: string, refusal: Omit<PlanRefusal, 'refusedAt'>) {
    const known = this.refusals.get(releaseId);
    if (
      known?.reason === refusal.reason &&
      known.wanted === refusal.wanted &&
      known.max === refusal.max
    ) {
      return false;
    }
    this.refusals.set(releaseId, { ...refusal, refusedAt: new Date() });
    return true;
  }

  async clearRefusal(tx: Transaction, releaseId: string) {
    fakeOf(tx).onCommit(() => this.refusals.delete(releaseId));
  }

  /** The file's hash lock in `tx`, if the test shares one. */
  async #recording(tx: Transaction, file: { sha256: string }): Promise<void> {
    fakeOf(tx);
    await this.locks?.lock(tx, [file.sha256]);
  }

  /** Puts `row` back as it is now, should `tx` roll back (its change is made at once). */
  #undoing(tx: Transaction, row: ReleaseOutput): void {
    fakeOf(tx).onRollback(() => this.replace(row));
  }

  private change(
    id: string,
    from: readonly ReleaseOutput['state'][],
    to: (row: ReleaseOutput) => ReleaseOutput,
  ): ReleaseOutput | undefined {
    const row = this.rows.find((r) => r.id === id);
    if (!row || !from.includes(row.state)) return undefined;
    const changed = { ...to(row), updatedAt: new Date() };
    this.replace(changed);
    return changed;
  }

  private replace(row: ReleaseOutput): void {
    const index = this.rows.findIndex((r) => r.id === row.id);
    if (index >= 0) this.rows[index] = row;
  }
}

/** Whether `row` is of `output`'s reuse group, with its very inputs (#497). */
function sameGroup(row: ReleaseOutput, output: GroupMember): boolean {
  return (
    output.reuseGroup !== null &&
    row.reuseGroup === output.reuseGroup &&
    row.manualId === output.manualId &&
    row.variant === output.variant &&
    row.lang === output.lang &&
    row.kind === output.kind &&
    row.audience === output.audience
  );
}
