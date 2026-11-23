import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { AssetReferenceIndex } from '../../../assets/core/asset-reference-index.js';
import { AssetInfoReader } from '../../../assets/core/asset-info.js';
import { AssetReferences } from '../../../assets/core/asset-references.js';
import { DeleteAssetAction } from '../../../assets/core/actions/delete-asset.action.js';
import { FakeArchivedFiles } from '../../../../tests/fakes/fake-archived-files.js';
import { FakeAssetReferenceStore } from '../../../../tests/fakes/fake-asset-reference-store.js';
import { FakeAssetRenditions } from '../../../../tests/fakes/fake-asset-renditions.js';
import { FakeAssetUploads } from '../../../../tests/fakes/fake-asset-uploads.js';
import { FakeChangeSetStore } from '../../../../tests/fakes/fake-change-set-store.js';
import { FakeHashLocks } from '../../../../tests/fakes/fake-hash-locks.js';
import { FakeHeldBlobs } from '../../../../tests/fakes/fake-held-blobs.js';
import { FakeRepository } from '../../../../tests/fakes/fake-repository.js';
import { FakeWorkingCopyStore } from '../../../../tests/fakes/fake-working-copy-store.js';
import {
  STALLED_AFTER_MS,
  SweepReleaseOutputsAction,
} from './sweep-release-outputs.action.js';
import { FakeReleaseDiffStore } from '../../../../tests/fakes/fake-release-diff-store.js';
import { Logger } from '@nestjs/common';
import { unzipSync } from 'fflate';
import { fakeQuota } from '../../../../tests/fakes/fake-storage-usage.js';
import { type Module, ProjectConfig } from '@openfolia/content-model';
import { actorWith, READER } from '../../../../tests/fakes/actors.js';
import { FakeAuditLog } from '../../../../tests/fakes/fake-audit-log.js';
import { FakeBlobStore } from '../../../../tests/fakes/fake-blob-store.js';
import {
  config as baseConfig,
  FakeSnapshot,
  manifest,
  module,
} from '../../../../tests/fakes/fake-content.js';
import { FakeHistory } from '../../../../tests/fakes/fake-history.js';
import { FakeJobQueue } from '../../../../tests/fakes/fake-job-queue.js';
import { FakeMaintenanceLineStore } from '../../../../tests/fakes/fake-maintenance-lines.js';
import { FakeReleaseEvents } from '../../../../tests/fakes/fake-release-events.js';
import { FakeReleaseOutputStore } from '../../../../tests/fakes/fake-release-output-store.js';
import { FakeReleaseStore } from '../../../../tests/fakes/fake-release-store.js';
import {
  problem,
  RecordingRenderer,
} from '../../../../tests/fakes/recording-pdf-renderer.js';
import { FakeUnitOfWork } from '../../../../tests/fakes/fake-unit-of-work.js';
import type { Actor } from '../../../access/core/actor.js';
import {
  PROMOTIONS_PER_READER,
  ReaderPromotions,
} from '../reader-promotions.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnavailableError,
  UnprocessableError,
} from '../../../base/core/errors.js';
import { zipSize } from '../../../base/core/zip-stream.js';
import { RenderManualPdfAction } from '../../../manuals/core/actions/render-manual-pdf.action.js';
import { ResolveManualAction } from '../../../manuals/core/actions/resolve-manual.action.js';
import { PdfAccessibilityError } from '../../../manuals/core/pdf-renderer.js';
import { newReleaseId, type Release } from '../release.js';
import {
  type ReleaseOutput,
  outputFileName,
  outputRenderer,
  outputsProgress,
  PLAN_BATCH,
  INTERACTIVE_PRIORITY,
  PROMOTED_PER_RELEASE,
  PROMOTED_PRIORITY,
  PLAN_RELEASE_OUTPUTS,
  QUEUED_PER_RELEASE,
  releasePriority,
  RENDER_RELEASE_OUTPUT,
  BUILD_OFFLINE_PACKAGE,
  outputJob,
} from '../release-output.js';
import { archiveEntryNames, archiveFileName } from '../release-archive.js';
import { PlanReleaseOutputsAction } from './plan-release-outputs.action.js';
import { ReleaseArchiveAction } from './release-archive.action.js';
import { ReleaseChangeReader } from './release-changes.action.js';
import {
  ListReleaseOutputsAction,
  ReleaseOutputFileAction,
  ReleaseOutputsProgressAction,
  ReplanReleaseOutputsAction,
  RetryReleaseOutputAction,
} from './release-outputs.action.js';
import {
  FailReleaseOutputAction,
  RenderReleaseOutputAction,
} from './render-release-output.action.js';
import { ScheduleReleaseOutputsAction } from './schedule-release-outputs.action.js';
import { FakePlanningTurns } from '../../../../tests/fakes/fake-planning-turns.js';
import {
  FakeOfflineSite,
  TextHtmlRenderer,
} from '../../../../tests/fakes/fake-offline-site.js';
import { BuildOfflinePackageAction } from './build-offline-package.action.js';

const config = ProjectConfig.parse({
  ...baseConfig,
  audiences: [
    { id: 'public', label: 'Public' },
    { id: 'internal', label: 'Internal' },
  ],
  facets: [
    {
      id: 'product-line',
      label: 'Product line',
      values: [{ id: 'tuggers', label: 'Tuggers' }],
    },
  ],
});

const publisher: Actor = {
  ...actorWith(['content.read', 'release.publish']),
  id: 'sample-publisher',
};
const publicReader = actorWith(['content.read'], { maxAudience: 'public' });

const internalManual = {
  ...manifest('staff', ['a']),
  audience: 'internal',
};

/** Modules `a` and `b` in English and German; three manuals, one internal. */
const v1 = {
  config,
  modules: ['a', 'b'].flatMap((id) => [module(id), module(id, 'de')]),
  manifests: [
    manifest('only-a', ['a']),
    manifest('only-b', ['b']),
    internalManual,
  ],
};

const changed = (id: string, lang: string): Module =>
  module(id, lang, `Changed ${id}.`);

const page = { number: 1, size: 200 };

function setup() {
  // The readers' promotion budget's clock (#497): a test moves it on by hand.
  const clock = { now: Date.UTC(2026, 3, 1) };
  const promotions = new ReaderPromotions(
    PROMOTIONS_PER_READER,
    () => clock.now,
  );
  /** The limit of outputs per release (`CCMS_RELEASE_MAX_OUTPUTS`); raised in place by a test. */
  const settings = {
    maxOutputs: 2_000,
    renderConcurrency: 1,
    // Its own spec plans them (`build-offline-package.spec.ts`).
    offlinePackages: false,
  };
  const history = new FakeHistory(v1);
  const store = new FakeReleaseStore();
  const outputs = new FakeReleaseOutputStore();
  const jobs = new FakeJobQueue();
  const unit = new FakeUnitOfWork();
  const events = new FakeReleaseEvents();
  const audit = new FakeAuditLog();
  const blobs = new FakeBlobStore();
  const renderer = new RecordingRenderer();
  const storage = fakeQuota({ unit });
  const lines = new FakeMaintenanceLineStore();
  store.lineOf = (id) => lines.released.get(id);
  const reader = new ReleaseChangeReader(
    store,
    history.openSnapshot,
    history.branches,
    lines,
    new FakeReleaseDiffStore(),
  );
  const schedule = new ScheduleReleaseOutputsAction(outputs, jobs, unit);
  const turns = new FakePlanningTurns();
  const addressSettings: {
    publicUrl: string | undefined;
    maxAccess: 'public';
    ignoredQuery: string[];
    sharedMaxAge: number;
    buildId: string;
  } = {
    publicUrl: undefined,
    maxAccess: 'public',
    ignoredQuery: [],
    sharedMaxAge: 300,
    buildId: 'test-build',
  };
  const plan = new PlanReleaseOutputsAction(
    store,
    outputs,
    history.openSnapshot,
    reader,
    history.branches,
    schedule,
    unit,
    settings,
    addressSettings,
    turns,
    jobs,
  );
  const fail = new FailReleaseOutputAction(
    outputs,
    store,
    events,
    unit,
    schedule,
  );
  const html = new TextHtmlRenderer();
  const render = new RenderReleaseOutputAction(
    outputs,
    store,
    history.openSnapshot,
    new RenderManualPdfAction(new ResolveManualAction(), renderer),
    blobs,
    fail,
    unit,
    storage.quota,
    schedule,
    events,
    new BuildOfflinePackageAction(
      history.openSnapshot,
      new ResolveManualAction(),
      html,
      new FakeOfflineSite(),
      outputs,
      blobs,
      { maxBytes: 2 ** 31 },
    ),
  );
  let at = Date.parse('2026-03-01T10:00:00Z');
  const release = (
    revision: string,
    content: Parameters<FakeHistory['onMain']>[0] = v1,
  ): Release => {
    const commit = history.onMain(content).commit;
    const tag = `release/tuggers/${revision}`;
    history.tag(tag, commit);
    at += 1000;
    const r: Release = {
      id: newReleaseId(at),
      product: 'tuggers',
      productFacet: 'product-line',
      revision,
      tag,
      tagObject: 'e'.repeat(40),
      commit,
      notes: null,
      notesByLanguage: {},
      major: false,
      publishedBy: { kind: 'user', id: 'sample-publisher' },
      publishedAt: new Date(at),
      withdrawal: null,
    };
    store.rows.push(r);
    outputs.publishedAt.set(r.id, r.publishedAt);
    outputs.products.set(r.id, {
      product: r.product,
      productFacet: r.productFacet,
    });
    return r;
  };
  /**
   * Runs the queued render jobs, highest priority first, as the worker
   * would, until none is left (those that ending one queues too; failures
   * throw). The outputs rendered, in order.
   */
  const renderAll = async () => {
    const ran: string[] = [];
    for (;;) {
      const [job] = jobs.jobs
        .filter(
          (j) =>
            (j.queue === RENDER_RELEASE_OUTPUT.name ||
              j.queue === BUILD_OFFLINE_PACKAGE.name) &&
            j.state === 'queued',
        )
        .sort((a, b) => b.priority - a.priority);
      if (!job) return ran;
      job.state = 'done';
      const payload = job.payload as { outputId: string; retries: number };
      ran.push(payload.outputId);
      await render.handle(payload);
    }
  };
  const sweep = new SweepReleaseOutputsAction(outputs, store, schedule);
  return {
    sweep,
    settings,
    addressSettings,
    history,
    store,
    lines,
    outputs,
    jobs,
    events,
    audit,
    blobs,
    renderer,
    html,
    plan,
    turns,
    render,
    fail,
    release,
    renderAll,
    list: new ListReleaseOutputsAction(store, outputs, history.openSnapshot),
    file: new ReleaseOutputFileAction(
      store,
      outputs,
      history.openSnapshot,
      blobs,
      schedule,
      promotions,
    ),
    clock,
    unit,
    storage: storage.usage,
    retry: new RetryReleaseOutputAction(
      store,
      outputs,
      history.openSnapshot,
      jobs,
      audit,
      unit,
    ),
    replan: new ReplanReleaseOutputsAction(
      store,
      history.openSnapshot,
      jobs,
      audit,
      unit,
      outputs,
      settings,
    ),
    progress: new ReleaseOutputsProgressAction(
      outputs,
      history.openSnapshot,
      jobs,
      settings,
      store,
    ),
  };
}

type T = ReturnType<typeof setup>;
/** The release's outputs as `<state> <manual>/<variant>/<lang>`, with `(reused)`. */
const outputsOf = async (t: T, r: Release) =>
  (await t.outputs.all(r.id)).map(
    (o) =>
      `${o.state} ${o.manualId}/${o.variant}/${o.lang}${o.reusedFrom ? ' (reused)' : ''}`,
  );

describe('PlanReleaseOutputsAction', () => {
  it('reuses, for a maintenance line’s release, its line’s previous release’s files, never a newer one of main (#60)', async () => {
    const t = setup();
    const base = t.release('1.0');
    await t.plan.handle({ releaseId: base.id });
    await t.renderAll();
    // main moves on: `b` changes everywhere in 2.0.
    const newer = t.release('2.0', {
      ...v1,
      modules: [
        module('a'),
        module('a', 'de'),
        changed('b', 'en'),
        changed('b', 'de'),
      ],
    });
    await t.plan.handle({ releaseId: newer.id });
    await t.renderAll();
    // The line fixes `a` in German on 1.0's content.
    const lineId = newReleaseId();
    t.lines.rows.push({
      id: lineId,
      product: 'tuggers',
      revision: '1.0',
      baseRelease: base.id,
      baseCommit: base.commit,
      branch: 'maintenance/tuggers/1.0',
      createdBy: { kind: 'user', id: 'sample-publisher' },
      createdAt: new Date(),
      closedAt: null,
      closedBy: null,
    });
    const fix = t.release('1.0.1', {
      ...v1,
      modules: [
        module('a'),
        changed('a', 'de'),
        module('b'),
        module('b', 'de'),
      ],
    });
    t.lines.released.set(fix.id, lineId);
    await t.plan.handle({ releaseId: fix.id });
    const outputs = await t.outputs.all(fix.id);
    const onlyB = outputs.filter((o) => o.manualId === 'only-b');
    expect(onlyB).toHaveLength(4);
    for (const o of onlyB) {
      expect(o.reusedFrom?.releaseId).toBe(base.id);
    }
    expect(
      outputs
        .filter((o) => o.state === 'queued')
        .map((o) => `${o.manualId}/${o.variant}/${o.lang}`)
        .sort(),
    ).toEqual([
      'only-a/model=large/de',
      'only-a/model=small/de',
      'staff/model=large/de',
      'staff/model=small/de',
    ]);
  });

  it('plans every manual in each variant and language for a product’s first release, once', async () => {
    const t = setup();
    const first = t.release('1.0');
    await t.plan.handle({ releaseId: first.id });
    const planned = await outputsOf(t, first);
    // Three manuals × two variants × two languages.
    expect(planned).toHaveLength(12);
    expect(planned.every((o) => o.startsWith('queued '))).toBe(true);
    expect(planned).toContain('queued staff/model=large/de');
    const renderJobs = t.jobs.jobs.filter(
      (j) => j.queue === RENDER_RELEASE_OUTPUT.name,
    );
    expect(renderJobs.map((j) => j.key).sort()).toEqual(
      t.outputs.rows.map((o) => o.id).sort(),
    );
    // Run again (an attempt cut off after it committed): nothing more.
    await t.plan.handle({ releaseId: first.id });
    expect(t.outputs.rows).toHaveLength(12);
    expect(
      t.jobs.jobs.filter((j) => j.queue === RENDER_RELEASE_OUTPUT.name),
    ).toHaveLength(12);
  });

  it('plans in its product’s turn, each time (#527: one planning of a product at a time across workers)', async () => {
    const t = setup();
    const first = t.release('1.0');
    await t.plan.handle({ releaseId: first.id });
    await t.plan.handle({ releaseId: first.id });
    expect(t.turns.taken).toEqual([first.product, first.product]);
    // A release that is gone takes no turn.
    await t.plan.handle({ releaseId: '00000000-0000-4000-8000-000000000000' });
    expect(t.turns.taken).toHaveLength(2);
  });

  it('plans the product’s earlier releases still to be planned first, oldest first, in the same turn (#527: strictly in the order cut)', async () => {
    const t = setup();
    const enqueue = (r: Release) =>
      t.jobs.enqueue(
        PLAN_RELEASE_OUTPUTS,
        { releaseId: r.id },
        { key: r.id, priority: releasePriority(r) },
      );
    const first = t.release('1.0');
    const second = t.release('1.1');
    const third = t.release('1.2');
    for (const r of [first, second, third]) await enqueue(r);
    // Another product's earlier release is not this product's turn.
    const other = t.release('9.0');
    const i = t.store.rows.findIndex((r) => r.id === other.id);
    t.store.rows[i] = {
      ...t.store.rows[i]!,
      product: 'other',
      publishedAt: new Date(first.publishedAt.getTime() - 1000),
    };
    await enqueue(other);
    // The newest one's job is claimed first (newest first): it plans 1.0 and 1.1 before itself.
    const order: string[] = [];
    const insert = t.outputs.insertMissing.bind(t.outputs);
    t.outputs.insertMissing = async (tx, rows) => {
      const id = rows[0]?.releaseId;
      if (id && order.at(-1) !== id) order.push(id);
      return insert(tx, rows);
    };
    await t.plan.handle({ releaseId: third.id });
    expect(order).toEqual([first.id, second.id, third.id]);
    expect(t.turns.taken).toEqual([first.product]);
    expect((await t.outputs.all(other.id)).length).toBe(0);
    // Each compared with the one cut just before it: all of 1.1 and 1.2 shares 1.0's files.
    for (const r of [second, third]) {
      expect((await t.outputs.all(r.id)).every((o) => o.reuseGroup)).toBe(true);
    }
    const groups = (r: Release) =>
      t.outputs.all(r.id).then((os) => os.map((o) => o.reuseGroup).sort());
    expect(await groups(third)).toEqual(await groups(first));
    expect(await groups(second)).toEqual(await groups(first));
    await t.renderAll();
    // Each file once, for the three of them.
    expect(t.renderer.keys).toHaveLength(12);
    // Their own jobs, later, add nothing.
    const rows = t.outputs.rows.length;
    await t.plan.handle({ releaseId: first.id });
    await t.plan.handle({ releaseId: second.id });
    expect(t.outputs.rows).toHaveLength(rows);
    expect(t.renderer.keys).toHaveLength(12);
  });

  it('passes over an earlier release that cannot be planned, and stops when the attempt is aborted (#527)', async () => {
    const t = setup();
    const first = t.release('1.0');
    const second = t.release('1.1');
    for (const r of [first, second]) {
      await t.jobs.enqueue(
        PLAN_RELEASE_OUTPUTS,
        { releaseId: r.id },
        { key: r.id, priority: releasePriority(r) },
      );
    }
    // 1.0's tag moved: its planning throws, and 1.1 is planned all the same.
    t.history.tag(first.tag, t.history.onMain(v1).commit);
    await t.plan.handle({ releaseId: second.id });
    expect(await t.outputs.all(first.id)).toEqual([]);
    expect(await t.outputs.all(second.id)).toHaveLength(12);
    // Aborted: nothing more is planned.
    const third = t.release('1.2');
    const fourth = t.release('1.3');
    for (const r of [third, fourth]) {
      await t.jobs.enqueue(
        PLAN_RELEASE_OUTPUTS,
        { releaseId: r.id },
        { key: r.id, priority: releasePriority(r) },
      );
    }
    const abort = new AbortController();
    abort.abort(new Error('lapsed'));
    await expect(
      t.plan.handle({ releaseId: fourth.id, signal: abort.signal }),
    ).rejects.toThrow('lapsed');
    expect(await t.outputs.all(third.id)).toEqual([]);
    expect(await t.outputs.all(fourth.id)).toEqual([]);
  });

  it('plans a release planned to the end only once: its own job then tops up its render jobs, and plans nothing else (#527)', async () => {
    const t = setup();
    const first = t.release('1.0');
    const second = t.release('1.1');
    for (const r of [first, second]) {
      await t.jobs.enqueue(
        PLAN_RELEASE_OUTPUTS,
        { releaseId: r.id },
        { key: r.id, priority: releasePriority(r) },
      );
    }
    await t.plan.handle({ releaseId: second.id });
    expect([
      ...(await t.outputs.plannedWholly([first.id, second.id])).keys(),
    ]).toEqual([first.id, second.id]);
    // The older one's own job: no rows written, no tag read again.
    let writes = 0;
    const insert = t.outputs.insertMissing.bind(t.outputs);
    t.outputs.insertMissing = async (tx, rows) => {
      writes++;
      return insert(tx, rows);
    };
    await t.plan.handle({ releaseId: first.id });
    await t.plan.handle({ releaseId: second.id });
    expect(writes).toBe(0);
    // Its progress no longer waits for that job, queued since before it was planned.
    expect(
      (await t.progress.handle({ actor: publisher, release: first }))?.state,
    ).toBe('rendering');
    // Nor reads failed when that job ran out of tries waiting for the turn.
    t.jobs.jobs.find((j) => j.key === first.id)!.state = 'failed';
    expect(
      (await t.progress.handle({ actor: publisher, release: first }))?.state,
    ).toBe('rendering');
  });

  it('does not plan an earlier release whose planning ended, refused or failed for good (#527)', async () => {
    const t = setup();
    const first = t.release('1.0');
    const second = t.release('1.1');
    for (const r of [first, second]) {
      await t.jobs.enqueue(
        PLAN_RELEASE_OUTPUTS,
        { releaseId: r.id },
        { key: r.id, priority: releasePriority(r) },
      );
    }
    t.jobs.jobs.find((j) => j.key === first.id)!.state = 'failed';
    await t.plan.handle({ releaseId: second.id });
    expect(await t.outputs.all(first.id)).toEqual([]);
    expect(await t.outputs.all(second.id)).toHaveLength(12);
  });

  it('plans its own release once the earlier ones took their share of the attempt; they join its groups later (#527)', async () => {
    const t = setup();
    const first = t.release('1.0');
    const second = t.release('1.1');
    for (const r of [first, second]) {
      await t.jobs.enqueue(
        PLAN_RELEASE_OUTPUTS,
        { releaseId: r.id },
        { key: r.id, priority: releasePriority(r) },
      );
    }
    t.plan.earlierBudgetMs = 0;
    await t.plan.handle({ releaseId: second.id });
    expect(await t.outputs.all(first.id)).toEqual([]);
    expect(await t.outputs.all(second.id)).toHaveLength(12);
    // The earlier one's own job, later: it shares the later one's files (#497's `joinLater`).
    await t.plan.handle({ releaseId: first.id });
    await t.renderAll();
    expect(t.renderer.keys).toHaveLength(12);
  });

  it('stops at once when the attempt is aborted while an earlier release is planned (#527)', async () => {
    const t = setup();
    const releases = ['1.0', '1.1', '1.2'].map((r) => t.release(r));
    for (const r of releases) {
      await t.jobs.enqueue(
        PLAN_RELEASE_OUTPUTS,
        { releaseId: r.id },
        { key: r.id, priority: releasePriority(r) },
      );
    }
    const abort = new AbortController();
    const insert = t.outputs.insertMissing.bind(t.outputs);
    t.outputs.insertMissing = async (tx, rows) => {
      // The attempt's claim lapses while the first earlier release is written.
      abort.abort(new Error('lapsed'));
      await insert(tx, rows);
      throw new Error('cut off');
    };
    await expect(
      t.plan.handle({ releaseId: releases[2]!.id, signal: abort.signal }),
    ).rejects.toThrow('cut off');
    expect(await t.outputs.all(releases[1]!.id)).toEqual([]);
    expect(await t.outputs.all(releases[2]!.id)).toEqual([]);
  });

  it('renders only what the release changed and reuses the previous release’s files for the rest', async () => {
    const t = setup();
    const first = t.release('1.0');
    await t.plan.handle({ releaseId: first.id });
    await t.renderAll();
    // `a` changes in German only: `only-a` and `staff` in German.
    const second = t.release('1.1', {
      ...v1,
      modules: [
        module('a'),
        changed('a', 'de'),
        module('b'),
        module('b', 'de'),
      ],
    });
    await t.plan.handle({ releaseId: second.id });
    expect(await outputsOf(t, second)).toEqual([
      'queued only-a/model=large/de',
      'done only-a/model=large/en (reused)',
      'queued only-a/model=small/de',
      'done only-a/model=small/en (reused)',
      'done only-b/model=large/de (reused)',
      'done only-b/model=large/en (reused)',
      'done only-b/model=small/de (reused)',
      'done only-b/model=small/en (reused)',
      'queued staff/model=large/de',
      'done staff/model=large/en (reused)',
      'queued staff/model=small/de',
      'done staff/model=small/en (reused)',
    ]);
    const reused = (await t.outputs.all(second.id)).find(
      (o) =>
        o.manualId === 'only-b' &&
        o.variant === 'model=small' &&
        o.lang === 'en',
    );
    const original = (await t.outputs.all(first.id)).find(
      (o) =>
        o.manualId === 'only-b' &&
        o.variant === 'model=small' &&
        o.lang === 'en',
    );
    expect(reused?.sha256).toBe(original?.sha256);
    expect(reused?.reusedFrom).toEqual({
      releaseId: first.id,
      outputId: original?.id,
    });

    // `b` changes in English, the source language: its manual in every language.
    await t.renderAll();
    const third = t.release('1.2', {
      ...v1,
      modules: [
        module('a'),
        changed('a', 'de'),
        changed('b', 'en'),
        module('b', 'de'),
      ],
    });
    await t.plan.handle({ releaseId: third.id });
    const planned = await outputsOf(t, third);
    expect(planned.filter((o) => o.startsWith('queued'))).toEqual([
      'queued only-b/model=large/de',
      'queued only-b/model=large/en',
      'queued only-b/model=small/de',
      'queued only-b/model=small/en',
    ]);
    // Reused twice over: still the file's own output.
    const again = (await t.outputs.all(third.id)).find(
      (o) =>
        o.manualId === 'only-a' &&
        o.variant === 'model=small' &&
        o.lang === 'en',
    );
    expect(again?.reusedFrom?.releaseId).toBe(first.id);
  });

  it('renders, never reuses, a manual whose page design prints the release, with its name and date (#395)', async () => {
    const t = setup();
    // The minimal preset with its default title page fields: the release and the date among them.
    const stamped = {
      ...v1,
      manifests: [
        { ...manifest('only-a', ['a']), design: 'stamped' },
        manifest('only-b', ['b']),
        internalManual,
      ],
      pageDesigns: {
        stamped: [
          'schemaVersion: 1',
          'name: Stamped',
          'preset: minimal',
          'colours:',
          '  primary: "#1f4e79"',
          '  accent: "#b45309"',
          '  text: "#1f2328"',
          '',
        ].join('\n'),
      },
    };
    const printed: string[] = [];
    t.renderer.fail = (resolution) => {
      const values = resolution.design?.placeholders;
      if (values) {
        printed.push(
          `${resolution.manual.lang} ${values.release ?? '-'} ${values.date ?? '-'}`,
        );
      }
      return undefined;
    };
    const first = t.release('1.0', stamped);
    await t.plan.handle({ releaseId: first.id });
    await t.renderAll();
    expect([...new Set(printed)].sort()).toEqual([
      'de 1.0 1. März 2026',
      'en 1.0 March 1, 2026',
    ]);
    printed.length = 0;

    // Only `b` changes, in German: `only-a` prints the new release, so it is rendered again.
    const second = t.release('1.1', {
      ...stamped,
      modules: [
        module('a'),
        module('a', 'de'),
        module('b'),
        changed('b', 'de'),
      ],
    });
    await t.plan.handle({ releaseId: second.id });
    expect(await outputsOf(t, second)).toEqual([
      'queued only-a/model=large/de',
      'queued only-a/model=large/en',
      'queued only-a/model=small/de',
      'queued only-a/model=small/en',
      'queued only-b/model=large/de',
      'done only-b/model=large/en (reused)',
      'queued only-b/model=small/de',
      'done only-b/model=small/en (reused)',
      'done staff/model=large/de (reused)',
      'done staff/model=large/en (reused)',
      'done staff/model=small/de (reused)',
      'done staff/model=small/en (reused)',
    ]);
    await t.renderAll();
    expect([...new Set(printed)].sort()).toEqual([
      'de 1.1 1. März 2026',
      'en 1.1 March 1, 2026',
    ]);
  });

  it('renders everything again when the configuration changed', async () => {
    const t = setup();
    const first = t.release('1.0');
    await t.plan.handle({ releaseId: first.id });
    await t.renderAll();
    const second = t.release('1.1', {
      ...v1,
      config: ProjectConfig.parse({
        ...config,
        outputLabels: { en: { note: 'Remark' } },
      }),
    });
    await t.plan.handle({ releaseId: second.id });
    const planned = await outputsOf(t, second);
    expect(planned.every((o) => o.startsWith('queued '))).toBe(true);
  });

  it('renders again what the previous release failed for', async () => {
    const t = setup();
    const first = t.release('1.0');
    await t.plan.handle({ releaseId: first.id });
    t.renderer.fail = () => new PdfAccessibilityError([problem('no alt')]);
    await t.renderAll();
    t.renderer.fail = undefined;
    const second = t.release('1.1');
    await t.plan.handle({ releaseId: second.id });
    expect(
      (await outputsOf(t, second)).every((o) => o.startsWith('queued ')),
    ).toBe(true);
    await t.renderAll();
    expect(
      (await outputsOf(t, second)).every(
        (o) => o.startsWith('done ') && !o.endsWith('(reused)'),
      ),
    ).toBe(true);
  });

  it('renders unchanged outputs once for releases whose files are not made yet, newest first, each file at the oldest release that has it (#497)', async () => {
    const t = setup();
    const first = t.release('1.0');
    await t.plan.handle({ releaseId: first.id });
    // Cut before the first one's files were rendered: it changed nothing they show.
    const second = t.release('1.1');
    await t.plan.handle({ releaseId: second.id });
    expect(
      (await outputsOf(t, second)).every((o) => o.startsWith('queued ')),
    ).toBe(true);
    const ran = await t.renderAll();
    // Each file rendered once, by the newer release's jobs (they go first),
    // at the older release's tag: the file is the older one's own and the
    // newer one reuses it, so no file carries a later commit than its
    // release's (#328).
    expect(t.renderer.keys).toHaveLength(12);
    expect(t.renderer.keys.every((k) => k.includes(first.commit))).toBe(true);
    expect(new Set(ran.slice(0, 12).map((id) => id))).toEqual(
      new Set((await t.outputs.all(second.id)).map((o) => o.id)),
    );
    for (const old of await t.outputs.all(first.id)) {
      expect(old).toMatchObject({ state: 'done', reusedFrom: null });
      const mine = (await t.outputs.all(second.id)).find(
        (o) =>
          o.manualId === old.manualId &&
          o.variant === old.variant &&
          o.lang === old.lang,
      );
      expect(mine).toMatchObject({
        state: 'done',
        sha256: old.sha256,
        reusedFrom: { releaseId: first.id, outputId: old.id },
      });
    }
    // A third one, cut now: the second's files, done, reused at once.
    const third = t.release('1.2');
    await t.plan.handle({ releaseId: third.id });
    expect(
      (await outputsOf(t, third)).every(
        (o) => o.startsWith('done ') && o.endsWith('(reused)'),
      ),
    ).toBe(true);
    expect(await t.renderAll()).toEqual([]);
    expect(t.renderer.keys).toHaveLength(12);
  });

  it('renders an output at its own release when its group’s older release cannot be rendered (#497)', async () => {
    const t = setup();
    const first = t.release('1.0');
    await t.plan.handle({ releaseId: first.id });
    const second = t.release('1.1');
    await t.plan.handle({ releaseId: second.id });
    // The older release's tag no longer at its commit: its own files fail.
    const i = t.store.rows.findIndex((r) => r.id === first.id);
    t.store.rows[i] = { ...t.store.rows[i]!, commit: 'f'.repeat(40) };
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      await t.renderAll();
    } finally {
      vi.restoreAllMocks();
    }
    // Not the newer release's fault: its files are made at its own tag.
    for (const o of await t.outputs.all(second.id)) {
      expect(o).toMatchObject({ state: 'done', reusedFrom: null });
    }
  });

  it('reuses, before rendering, a file its group got meanwhile (#497)', async () => {
    const t = setup();
    const first = t.release('1.0');
    await t.plan.handle({ releaseId: first.id });
    const second = t.release('1.1');
    await t.plan.handle({ releaseId: second.id });
    // The second's job for one output runs while the first's is done by
    // another server: no render.
    const [mine] = await t.outputs.all(second.id);
    const theirs = (await t.outputs.all(first.id)).find(
      (o) =>
        o.manualId === mine?.manualId &&
        o.variant === mine.variant &&
        o.lang === mine.lang,
    );
    await t.outputs.finish(theirs!.id, { sha256: 'f'.repeat(64), size: 3 });
    await t.render.handle({ outputId: mine!.id, retries: 0 });
    expect(t.renderer.keys).toEqual([]);
    expect(await t.outputs.find(mine!.id)).toMatchObject({
      state: 'done',
      sha256: 'f'.repeat(64),
      reusedFrom: { releaseId: first.id, outputId: theirs!.id },
    });
  });

  it('keeps at most QUEUED_PER_RELEASE render jobs of a release at a time, queueing the next as each ends (#497)', async () => {
    const t = setup();
    const first = t.release('1.0', manuals(30));
    await t.plan.handle({ releaseId: first.id });
    expect(t.outputs.rows).toHaveLength(120);
    const queuedJobs = () =>
      t.jobs.jobs.filter(
        (j) => j.queue === RENDER_RELEASE_OUTPUT.name && j.state === 'queued',
      );
    expect(queuedJobs()).toHaveLength(QUEUED_PER_RELEASE);
    // In list order, at the release's priority.
    expect(queuedJobs().map((j) => j.key)).toEqual(
      (await t.outputs.all(first.id))
        .slice(0, QUEUED_PER_RELEASE)
        .map((o) => o.id),
    );
    expect(new Set(queuedJobs().map((j) => j.priority))).toEqual(
      new Set([releasePriority(first)]),
    );
    // One ends: the next takes its place.
    const [job] = queuedJobs();
    job!.state = 'done';
    await t.render.handle(
      job!.payload as { outputId: string; retries: number },
    );
    expect(queuedJobs()).toHaveLength(QUEUED_PER_RELEASE);
    await t.renderAll();
    expect(
      (await outputsOf(t, first)).every((o) => o.startsWith('done ')),
    ).toBe(true);
    expect(t.renderer.keys).toHaveLength(120);
  });

  it('renders the newest release’s files before an older one’s backlog (#497)', async () => {
    const t = setup();
    const older = t.release('1.0', manuals(30));
    await t.plan.handle({ releaseId: older.id });
    // A configuration change: every file of the new one is its own.
    const newer = t.release('1.1', {
      ...manuals(30),
      config: ProjectConfig.parse({
        ...config,
        outputLabels: { en: { note: 'Remark' } },
      }),
    });
    await t.plan.handle({ releaseId: newer.id });
    const ran = await t.renderAll();
    const newerIds = new Set((await t.outputs.all(newer.id)).map((o) => o.id));
    expect(ran.slice(0, 120).every((id) => newerIds.has(id))).toBe(true);
    expect(ran).toHaveLength(240);
  });

  it('queues again, when planned again, a scheduled output whose job went missing (#497)', async () => {
    const t = setup();
    const first = t.release('1.0');
    await t.plan.handle({ releaseId: first.id });
    const [lost] = t.jobs.jobs;
    lost!.state = 'cancelled';
    await t.plan.handle({ releaseId: first.id });
    const open = t.jobs.jobs.filter(
      (j) => j.key === lost!.key && j.state === 'queued',
    );
    expect(open).toHaveLength(1);
    // The others kept their one job each.
    expect(t.jobs.jobs.filter((j) => j.state === 'queued')).toHaveLength(12);
  });

  /** `count` manuals of module `a`, each in two variants: 4 outputs each (2 variants × en, de). */
  const manuals = (count: number) => ({
    ...v1,
    manifests: Array.from({ length: count }, (_, i) =>
      manifest(`m${String(i).padStart(5, '0')}`, ['a']),
    ),
  });

  it('plans a large release in batches, one transaction each (#477)', async () => {
    const t = setup();
    // 6,000 outputs: about a repository of 300 manuals in 8 languages.
    t.settings.maxOutputs = 6_000;
    const first = t.release('1.0', manuals(1_500));
    const before = t.unit.committed;
    await t.plan.handle({ releaseId: first.id });
    expect(t.outputs.rows).toHaveLength(6_000);
    // Only the first few get a job (#497); the rest as those end.
    expect(
      t.jobs.jobs.filter((j) => j.queue === RENDER_RELEASE_OUTPUT.name),
    ).toHaveLength(QUEUED_PER_RELEASE);
    // Each batch, then the release's jobs topped up.
    expect(t.unit.committed - before).toBe(2 * Math.ceil(6_000 / PLAN_BATCH));
    expect(await t.outputs.refusal(first.id)).toBeUndefined();
  });

  it('goes on where a planning cut off between batches stopped, adding nothing twice', async () => {
    const t = setup();
    const first = t.release('1.0', manuals(200));
    const insert = t.outputs.insertMissing.bind(t.outputs);
    let calls = 0;
    t.outputs.insertMissing = async (tx, outputs) => {
      if (++calls === 2) throw new Error('The database went away.');
      return insert(tx, outputs);
    };
    await expect(t.plan.handle({ releaseId: first.id })).rejects.toThrow(
      'went away',
    );
    // The first batch is kept, rows and its first jobs together.
    expect(t.outputs.rows).toHaveLength(PLAN_BATCH);
    expect(t.jobs.jobs).toHaveLength(QUEUED_PER_RELEASE);
    await t.plan.handle({ releaseId: first.id });
    expect(t.outputs.rows).toHaveLength(800);
    expect(t.jobs.jobs).toHaveLength(QUEUED_PER_RELEASE);
    expect(new Set(t.jobs.jobs.map((j) => j.key)).size).toBe(
      QUEUED_PER_RELEASE,
    );
    await t.renderAll();
    expect(t.renderer.keys).toHaveLength(800);
    expect(new Set(t.jobs.jobs.map((j) => j.key)).size).toBe(800);
  });

  it('plans nothing past the limit, records the refusal and logs it once, until the limit is raised (#477)', async () => {
    const t = setup();
    t.settings.maxOutputs = 10;
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      const first = t.release('1.0');
      await t.plan.handle({ releaseId: first.id });
      expect(t.outputs.rows).toEqual([]);
      expect(t.jobs.jobs).toEqual([]);
      expect(await t.outputs.refusal(first.id)).toMatchObject({
        reason: 'too-many-outputs',
        wanted: 12,
        max: 10,
      });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain('12 outputs, more than 10');
      // Again (a restart, a retry): the tag is not read, nothing is logged.
      const open = vi.spyOn(t.history.openSnapshot, 'handle');
      await t.plan.handle({ releaseId: first.id });
      expect(open).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      // Another limit, still too low: recorded and told once more.
      t.settings.maxOutputs = 11;
      await t.plan.handle({ releaseId: first.id });
      await t.plan.handle({ releaseId: first.id });
      expect(await t.outputs.refusal(first.id)).toMatchObject({ max: 11 });
      expect(warn).toHaveBeenCalledTimes(2);
      // Raised far enough: planned, and the refusal forgotten.
      t.settings.maxOutputs = 12;
      await t.plan.handle({ releaseId: first.id });
      expect(t.outputs.rows).toHaveLength(12);
      expect(await t.outputs.refusal(first.id)).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('RenderReleaseOutputAction', () => {
  it('renders at the release’s tag as the manual’s audience reads it, stores the PDF and is done once', async () => {
    const t = setup();
    const first = t.release('1.0');
    await t.plan.handle({ releaseId: first.id });
    const output = (await t.outputs.all(first.id)).find(
      (o) => o.manualId === 'only-a' && o.lang === 'en',
    );
    if (!output) throw new Error('no output');
    await t.render.handle({ outputId: output.id, retries: 0 });
    const done = await t.outputs.find(output.id);
    expect(done).toMatchObject({ state: 'done', size: 3, attempts: 1 });
    expect(t.blobs.blobs.get(done?.sha256 as string)?.contentType).toBe(
      'application/pdf',
    );
    // At the release's commit, as the manual's audience reads it.
    const [key] = t.renderer.keys;
    expect(key?.startsWith(`${first.commit}|only-a|`)).toBe(true);
    // Run again (at least once): nothing rendered twice.
    await t.render.handle({ outputId: output.id, retries: 0 });
    expect(t.renderer.keys).toHaveLength(1);
    expect((await t.outputs.find(output.id))?.attempts).toBe(1);
    // Archived: counted towards the storage used, once (#404).
    expect(t.storage.totals.pdfs).toEqual({ bytes: 3, files: 1 });
  });

  it('prints the latest stable address as a QR code where the release’s configuration says, only with CCMS_PUBLIC_URL (#450)', async () => {
    const t = setup();
    const withQr = (pdfQrCode: string, access = 'public') => ({
      ...v1,
      config: ProjectConfig.parse({
        ...config,
        delivery: {
          access,
          pdfQrCode,
          manuals: { 'only-a': { slug: 'guide' } },
        },
      }),
    });
    const renderOne = async (r: Release) => {
      await t.plan.handle({ releaseId: r.id });
      const output = (await t.outputs.all(r.id)).find(
        (o) => o.manualId === 'only-a' && o.lang === 'de',
      );
      if (!output) throw new Error('no output');
      await t.render.handle({ outputId: output.id, retries: 0 });
      return t.renderer.extras.at(-1);
    };
    // No public URL: no address to print.
    expect(await renderOne(t.release('1.0', withQr('title-page')))).toBe(
      undefined,
    );
    t.addressSettings.publicUrl = 'https://docs.example.com/manuals/';
    expect(await renderOne(t.release('2.0', withQr('back-cover')))).toEqual({
      qrCode: {
        url: 'https://docs.example.com/manuals/d/tuggers/guide/model=large/de',
        placement: 'back-cover',
      },
    });
    // And the rendering is told apart from one without it.
    expect(t.renderer.keys.at(-1)).toContain(
      '|qr:back-cover:https://docs.example.com/manuals/d/tuggers/guide/model=large/de',
    );
    expect(await renderOne(t.release('3.0', withQr('none')))).toBe(undefined);
    expect(await renderOne(t.release('4.0', withQr('title-page', 'off')))).toBe(
      undefined,
    );
    // Signed in: a scanned code could not open it.
    expect(
      await renderOne(t.release('5.0', withQr('title-page', 'signed-in'))),
    ).toBe(undefined);
  });

  it('reuses a file only for an output that prints the same QR code: another CCMS_PUBLIC_URL renders again (#450, #497)', async () => {
    const t = setup();
    const content = {
      ...v1,
      config: ProjectConfig.parse({
        ...config,
        delivery: { access: 'public', pdfQrCode: 'title-page' },
      }),
    };
    const only = (r: Release) =>
      t.outputs
        .all(r.id)
        .then((all) =>
          all.find(
            (o) =>
              o.manualId === 'only-a' &&
              o.variant === 'model=large' &&
              o.lang === 'en',
          ),
        );
    t.addressSettings.publicUrl = 'https://old.example.com/';
    const first = t.release('1.0', content);
    await t.plan.handle({ releaseId: first.id });
    await t.renderAll();
    const old = {
      url: 'https://old.example.com/d/tuggers/only-a/model=large/en',
      placement: 'title-page',
    };
    expect((await only(first))?.qrCode).toEqual(old);

    // Nothing changed, the same address: the file is reused.
    const second = t.release('1.1', content);
    await t.plan.handle({ releaseId: second.id });
    expect(await only(second)).toMatchObject({
      state: 'done',
      qrCode: old,
      reusedFrom: { releaseId: first.id },
    });

    // Nothing changed but the public URL: every file is made again, with the new code.
    t.addressSettings.publicUrl = 'https://docs.example.com/';
    const third = t.release('1.2', content);
    await t.plan.handle({ releaseId: third.id });
    const planned = await only(third);
    expect(planned).toMatchObject({ state: 'queued', reusedFrom: null });
    expect(planned?.reuseGroup).not.toBe((await only(first))?.reuseGroup);
    expect(
      (await t.outputs.all(third.id)).every((o) => o.reusedFrom === null),
    ).toBe(true);
    const before = t.renderer.extras.length;
    await t.renderAll();
    const printed = t.renderer.extras.slice(before).map((e) => e?.qrCode?.url);
    expect(printed).toContain(
      'https://docs.example.com/d/tuggers/only-a/model=large/en',
    );
    expect(printed.some((u) => u?.startsWith('https://old.'))).toBe(false);
    expect((await only(third))?.state).toBe('done');
  });

  it('never joins a group still to render that prints another QR code: each release prints its own URL (#450, #497)', async () => {
    const t = setup();
    const content = {
      ...v1,
      config: ProjectConfig.parse({
        ...config,
        delivery: { access: 'public', pdfQrCode: 'title-page' },
      }),
    };
    const only = async (r: Release) =>
      (await t.outputs.all(r.id)).find(
        (o) =>
          o.manualId === 'only-a' &&
          o.variant === 'model=large' &&
          o.lang === 'en',
      );
    t.addressSettings.publicUrl = 'https://old.example.com/';
    const first = t.release('1.0', content);
    await t.plan.handle({ releaseId: first.id });
    // Before 1.0's files are made, the public URL changes and 1.1 is cut.
    t.addressSettings.publicUrl = 'https://docs.example.com/';
    const second = t.release('1.1', content);
    await t.plan.handle({ releaseId: second.id });
    expect((await only(second))?.reuseGroup).not.toBe(
      (await only(first))?.reuseGroup,
    );
    await t.renderAll();
    const printed = t.renderer.extras.map((e) => e?.qrCode?.url);
    expect(printed).toContain(
      'https://old.example.com/d/tuggers/only-a/model=large/en',
    );
    expect(printed).toContain(
      'https://docs.example.com/d/tuggers/only-a/model=large/en',
    );
    // Two files: neither release was given the other's.
    const [a, b] = [await only(first), await only(second)];
    expect(a?.state).toBe('done');
    expect(b).toMatchObject({ state: 'done', reusedFrom: null });
  });

  it('fails a document that can never render at once, writes release.output-failed, and keeps the previous release’s file', async () => {
    const t = setup();
    const first = t.release('1.0');
    await t.plan.handle({ releaseId: first.id });
    await t.renderAll();
    const second = t.release('1.1', {
      ...v1,
      modules: [
        changed('a', 'en'),
        module('a', 'de'),
        module('b'),
        module('b', 'de'),
      ],
    });
    await t.plan.handle({ releaseId: second.id });
    t.renderer.fail = () =>
      new PdfAccessibilityError([problem('missing alt text')]);
    await t.renderAll();
    const failed = (await t.outputs.all(second.id)).filter(
      (o) => o.state === 'failed',
    );
    // `only-a` and `staff`, two variants, two languages.
    expect(failed).toHaveLength(8);
    expect(failed[0]?.error?.code).toBe('pdf-accessibility');
    expect(
      t.events.events.filter((e) => e.topic === 'release.output-failed'),
    ).toHaveLength(8);
    expect(t.events.events[0]?.payload).toMatchObject({
      releaseId: second.id,
      code: 'pdf-accessibility',
      product: 'tuggers',
    });
    // The previous release's outputs are untouched.
    expect(
      (await t.outputs.all(first.id)).every((o) => o.state === 'done'),
    ).toBe(true);
    // A failed output is not rendered again by a late job.
    const keys = t.renderer.keys.length;
    await t.render.handle({ outputId: failed[0]?.id as string, retries: 0 });
    expect(t.renderer.keys).toHaveLength(keys);
  });

  it('keeps a passing failure on the row, throws for a retry, and fails it with that error once the job failed for good', async () => {
    const t = setup();
    const first = t.release('1.0');
    await t.plan.handle({ releaseId: first.id });
    const [output] = await t.outputs.all(first.id);
    if (!output) throw new Error('no output');
    t.renderer.fail = () => new UnavailableError('renderer-busy', 'Busy.', 30);
    await expect(
      t.render.handle({ outputId: output.id, retries: 0 }),
    ).rejects.toThrow(UnavailableError);
    expect(await t.outputs.find(output.id)).toMatchObject({
      state: 'rendering',
      error: { code: 'renderer-busy' },
    });
    await t.fail.handle({ outputId: output.id, retries: 0 });
    expect(await t.outputs.find(output.id)).toMatchObject({
      state: 'failed',
      error: { code: 'renderer-busy' },
    });
    // Reported again (the failure handler is itself retried): told once.
    await t.fail.handle({ outputId: output.id, retries: 0 });
    expect(t.events.events).toHaveLength(1);
  });

  it('never fails a done output', async () => {
    const t = setup();
    const first = t.release('1.0');
    await t.plan.handle({ releaseId: first.id });
    await t.renderAll();
    const [output] = await t.outputs.all(first.id);
    await t.fail.handle({ outputId: output?.id as string, retries: 0 });
    expect((await t.outputs.find(output?.id as string))?.state).toBe('done');
    expect(t.events.events).toEqual([]);
  });
  it('names the release’s commit in release.output-failed, as the notifications read it (#551)', async () => {
    const t = setup();
    const first = t.release('1.0');
    await t.plan.handle({ releaseId: first.id });
    t.renderer.fail = () =>
      new PdfAccessibilityError([problem('missing alt text')]);
    await t.renderAll();
    expect(t.events.events[0]?.payload).toMatchObject({
      releaseId: first.id,
      commit: first.commit,
    });
  });

  it('tells of an output failed for good and then finished by a late file: release.output-recovered, once (#551)', async () => {
    const t = setup();
    const first = t.release('1.0');
    await t.plan.handle({ releaseId: first.id });
    const [output] = await t.outputs.all(first.id);
    const id = output?.id as string;
    // The job gives up on it while its attempt still renders: failed, told.
    const render = t.renderer.render.bind(t.renderer);
    let gaveUp = false;
    t.renderer.render = async (...args) => {
      if (!gaveUp) {
        gaveUp = true;
        await t.fail.handle({ outputId: id, retries: 0 });
        expect((await t.outputs.find(id))?.state).toBe('failed');
      }
      return render(...args);
    };
    await t.render.handle({ outputId: id, retries: 0 });
    // The late file finishes it: done, and the failure told is corrected.
    expect(await t.outputs.find(id)).toMatchObject({
      state: 'done',
      error: null,
    });
    const told = t.events.events.filter(
      (e) => (e.payload as { outputId?: string }).outputId === id,
    );
    expect(told.map((e) => e.topic)).toEqual([
      'release.output-failed',
      'release.output-recovered',
    ]);
    expect(told[1]).toMatchObject({
      key: id,
      payload: {
        releaseId: first.id,
        outputId: id,
        manualId: output?.manualId,
        commit: first.commit,
      },
    });
    // Its file again (another attempt, the same bytes): told once.
    await t.outputs.finish(id, { sha256: 'f'.repeat(64), size: 3 });
    await t.render.handle({ outputId: id, retries: 0 });
    expect(
      t.events.events.filter((e) => e.topic === 'release.output-recovered'),
    ).toHaveLength(1);
  });

  it('tells of a failed output a retry renders (#551)', async () => {
    const t = setup();
    const first = t.release('1.0');
    await t.plan.handle({ releaseId: first.id });
    t.renderer.fail = () =>
      new PdfAccessibilityError([problem('missing alt text')]);
    await t.renderAll();
    const [one] = await t.outputs.all(first.id);
    const id = one?.id as string;
    t.renderer.fail = undefined;
    await t.retry.handle({
      actor: publisher,
      releaseId: first.id,
      outputId: id,
    });
    await t.renderAll();
    expect((await t.outputs.find(id))?.state).toBe('done');
    expect(
      t.events.events
        .filter((e) => e.topic === 'release.output-recovered')
        .map((e) => e.key),
    ).toEqual([id]);
  });

  it('tells of a failed output its group’s file finishes, and of no other (#551)', async () => {
    const t = setup();
    const first = t.release('1.0');
    await t.plan.handle({ releaseId: first.id });
    // The next release, unchanged: its outputs join the first's groups.
    const second = t.release('1.1');
    await t.plan.handle({ releaseId: second.id });
    const [older] = await t.outputs.all(first.id);
    const newer = (await t.outputs.all(second.id)).find(
      (o) =>
        o.manualId === older?.manualId &&
        o.variant === older.variant &&
        o.lang === older.lang,
    );
    expect(newer?.reuseGroup).not.toBeNull();
    // The newer one fails (at the older release, then at its own) and is retried.
    t.renderer.fail = () =>
      new PdfAccessibilityError([problem('missing alt text')]);
    await t.render.handle({ outputId: newer?.id as string, retries: 0 });
    expect((await t.outputs.find(newer?.id as string))?.state).toBe('failed');
    t.renderer.fail = undefined;
    for (const job of t.jobs.jobs) {
      if (job.key === newer?.id) job.state = 'done';
    }
    await t.retry.handle({
      actor: publisher,
      releaseId: second.id,
      outputId: newer?.id as string,
    });
    // The older one's file is made, and serves the newer one too.
    await t.render.handle({ outputId: older?.id as string, retries: 0 });
    expect(await t.outputs.find(newer?.id as string)).toMatchObject({
      state: 'done',
      reusedFrom: { releaseId: first.id, outputId: older?.id },
    });
    expect(
      t.events.events
        .filter((e) => e.topic === 'release.output-recovered')
        .map((e) => e.key),
    ).toEqual([newer?.id]);
  });
});

describe('a file delete while an output finishes (#593)', () => {
  const day = 24 * 60 * 60 * 1000;
  const editor = actorWith([
    'content.read',
    'content.read.draft',
    'content.edit',
  ]);
  /** The bytes `RecordingRenderer` renders every PDF as. */
  const pdf = Buffer.from([1, 2, 3]);
  const hash = createHash('sha256').update(pdf).digest('hex');
  const ticks = () => new Promise((resolve) => setTimeout(resolve, 10));

  /**
   * A release's output still to render, and a delete of an old upload no
   * content uses whose bytes are exactly the PDF it renders, sharing the
   * render's blob store, unit of work and hash locks.
   */
  async function setUp() {
    const t = setup();
    const locks = new FakeHashLocks();
    t.outputs.locks = locks;
    const uploads = new FakeAssetUploads();
    uploads.locks = locks;
    const long = new Date(Date.now() - 2 * day);
    t.blobs.blobs.set(hash, {
      data: pdf,
      contentType: 'image/png',
      storedAt: long,
    });
    uploads.uploads.push({
      changeSetId: 'c',
      sha256: hash,
      size: pdf.byteLength,
      contentType: 'image/png',
      uploadedBy: { kind: 'user', id: 'someone' },
      uploadedAt: long,
      lastUploadedAt: long,
    });
    // What Postgres reads of `release_outputs`: the `done` outputs' files.
    const isArchived = (sha256: string) =>
      t.outputs.rows.some((r) => r.state === 'done' && r.sha256 === sha256);
    const archived = new FakeArchivedFiles();
    archived.has = async (_tx, sha256) => isArchived(sha256);
    const { quota, usage } = fakeQuota({ unit: t.unit });
    usage.apartFromMedia = async (_tx, sha256) =>
      isArchived(sha256) ? 'pdf' : undefined;
    const held = new FakeHeldBlobs();
    const repository = new FakeRepository(new FakeSnapshot());
    const remove = new DeleteAssetAction(
      t.unit,
      uploads,
      new FakeAssetRenditions(),
      new AssetReferences(
        repository,
        new FakeChangeSetStore(),
        new FakeWorkingCopyStore(),
        uploads,
        held,
        new AssetReferenceIndex(repository, new FakeAssetReferenceStore()),
      ),
      t.blobs,
      new AssetInfoReader(t.blobs),
      new FakeAuditLog(),
      held,
      quota,
      archived,
    );
    const r = t.release('1.0');
    await t.plan.handle({ releaseId: r.id });
    const output = (await t.outputs.all(r.id)).find(
      (o) => o.manualId === 'only-a' && o.lang === 'en',
    );
    if (!output) throw new Error('no output');
    /** Runs `between` once, right after the render's first put. */
    const afterPut = (between: () => Promise<void>) => {
      const put = t.blobs.put.bind(t.blobs);
      let first = true;
      t.blobs.put = async (...args) => {
        const stored = await put(...args);
        if (first) {
          first = false;
          await between();
        }
        return stored;
      };
    };
    const deleteFile = () => remove.handle({ actor: editor, hash });
    const render = () => t.render.handle({ outputId: output.id, retries: 0 });
    /** The output's file is stored, if it is done. */
    const pointsAtItsFile = async () => {
      const done = await t.outputs.find(output.id);
      expect(done).toMatchObject({ state: 'done', sha256: hash });
      expect(t.blobs.blobs.has(hash)).toBe(true);
    };
    return {
      t,
      uploads,
      usage,
      locks,
      afterPut,
      deleteFile,
      render,
      pointsAtItsFile,
    };
  }

  it('a delete that ends between the render’s put and its record: the file is stored again', async () => {
    const { t, afterPut, deleteFile, render, pointsAtItsFile } = await setUp();
    let deleted = false;
    afterPut(async () => {
      await deleteFile();
      deleted = true;
    });
    await render();
    expect(deleted).toBe(true);
    await pointsAtItsFile();
    // Stored again, so counted as an archived PDF now (#404).
    expect(t.blobs.created).toEqual([hash]);
    expect(t.storage.totals.pdfs).toEqual({ bytes: 3, files: 1 });
  });

  it('a record that comes while the delete’s last step holds the lock: it waits, then stores the file again', async () => {
    const { usage, locks, afterPut, deleteFile, render, pointsAtItsFile } =
      await setUp();
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => (resume = resolve));
    let put!: () => void;
    const stored = new Promise<void>((resolve) => (put = resolve));
    afterPut(async () => {
      put();
      await paused;
    });
    const rendering = render();
    await stored;
    // The delete's last step, past its checks under the lock, right
    // before it removes the blob: the render goes on as far as it can.
    const apart = usage.apartFromMedia.bind(usage);
    usage.apartFromMedia = async (tx, sha256) => {
      const found = await apart(tx, sha256);
      expect(locks.isHeld(hash)).toBe(true);
      resume();
      await ticks();
      return found;
    };
    await deleteFile();
    await rendering;
    await pointsAtItsFile();
  });

  it('a delete after the record: the output is seen, only the uploads go and the file stays (#429)', async () => {
    const { uploads, render, deleteFile, pointsAtItsFile } = await setUp();
    await render();
    await deleteFile();
    expect(uploads.uploads).toEqual([]);
    await pointsAtItsFile();
  });
});

describe('release output routes', () => {
  it('lists only the outputs whose manual the reader may read, and serves their files', async () => {
    const t = setup();
    const first = t.release('1.0');
    await t.plan.handle({ releaseId: first.id });
    await t.renderAll();
    const all = await t.list.handle({
      actor: READER,
      releaseId: first.id,
      filter: {},
      page,
    });
    expect(all.total).toBe(12);
    const scoped = await t.list.handle({
      actor: publicReader,
      releaseId: first.id,
      filter: {},
      page,
    });
    expect(scoped.total).toBe(8);
    // A file holds every module the manual names: a reader restricted by
    // module type or facet would get what their scope leaves out.
    for (const narrow of [
      actorWith(['content.read'], { moduleTypes: ['concept'] }),
      actorWith(['content.read'], { facets: { 'product-line': ['tuggers'] } }),
    ]) {
      expect(
        (
          await t.list.handle({
            actor: narrow,
            releaseId: first.id,
            filter: {},
            page,
          })
        ).total,
      ).toBe(0);
    }
    // A German file may fall back to English modules: a reader of German
    // only gets none; one of German and English gets those two languages.
    const inLanguages = async (languages: string[]) =>
      (
        await t.list.handle({
          actor: actorWith(['content.read'], { languages }),
          releaseId: first.id,
          filter: {},
          page,
        })
      ).items.map((o) => o.lang);
    expect(await inLanguages(['de'])).toEqual([]);
    expect(new Set(await inLanguages(['de', 'en']))).toEqual(
      new Set(['de', 'en']),
    );
    expect(scoped.items.some((o) => o.manualId === 'staff')).toBe(false);
    const filtered = await t.list.handle({
      actor: READER,
      releaseId: first.id,
      filter: { manual: 'only-a', lang: 'de', state: 'done' },
      page,
    });
    expect(filtered.items.map((o) => o.variant)).toEqual([
      'model=large',
      'model=small',
    ]);

    const staff = all.items.find((o) => o.manualId === 'staff');
    const file = await t.file.handle({
      actor: READER,
      releaseId: first.id,
      outputId: staff?.id as string,
    });
    expect(file.fileName).toBe(
      outputFileName(staff as NonNullable<typeof staff>, '1.0'),
    );
    expect(file.fileName).toMatch(/^staff_model-large_[a-z]+_1\.0\.pdf$/);
    await expect(
      t.file.handle({
        actor: publicReader,
        releaseId: first.id,
        outputId: staff?.id as string,
      }),
    ).rejects.toThrow(NotFoundError);
    await expect(
      t.list.handle({
        actor: READER,
        releaseId: newReleaseId(),
        filter: {},
        page,
      }),
    ).rejects.toThrow(NotFoundError);
  });

  it('answers 409 for the file of an output not done yet', async () => {
    const t = setup();
    const first = t.release('1.0');
    await t.plan.handle({ releaseId: first.id });
    const [output] = await t.outputs.all(first.id);
    await expect(
      t.file.handle({
        actor: READER,
        releaseId: first.id,
        outputId: output?.id as string,
      }),
    ).rejects.toThrow(ConflictError);
  });

  it('queues a failed output again for a publisher of the product, once', async () => {
    const t = setup();
    const first = t.release('1.0');
    await t.plan.handle({ releaseId: first.id });
    t.renderer.fail = () =>
      new PdfAccessibilityError([problem('missing alt text')]);
    await t.renderAll();
    const [output] = await t.outputs.all(first.id);
    const id = output?.id as string;
    await expect(
      t.retry.handle({ actor: READER, releaseId: first.id, outputId: id }),
    ).rejects.toThrow(ForbiddenError);
    // A publisher scoped to the product by its facet sees no output's
    // file, yet may queue the product's outputs again (shown below, after
    // the busy case).
    const productPublisher = {
      ...actorWith(['content.read', 'release.publish'], {
        facets: { 'product-line': ['tuggers'] },
      }),
      id: 'product-publisher',
    };
    const narrow = {
      ...actorWith(['content.read', 'release.publish'], {
        maxAudience: 'public',
      }),
      id: 'narrow',
    };
    await expect(
      t.retry.handle({ actor: narrow, releaseId: first.id, outputId: id }),
    ).rejects.toThrow(ForbiddenError);
    // The job that failed it still ending: nothing changes, try again.
    const ending = t.jobs.jobs.find((j) => j.key === id);
    if (ending) ending.state = 'running';
    await expect(
      t.retry.handle({ actor: publisher, releaseId: first.id, outputId: id }),
    ).rejects.toMatchObject({ code: 'output-busy' });
    expect((await t.outputs.find(id))?.state).toBe('failed');
    expect(t.audit.events).toEqual([]);
    if (ending) ending.state = 'done';
    const retried = await t.retry.handle({
      actor: productPublisher,
      releaseId: first.id,
      outputId: id,
    });
    expect(retried.release.id).toBe(first.id);
    // It may not read the output: only where it stands (#340).
    expect(retried).toMatchObject({ whole: false });
    expect(retried.output).toEqual({
      id,
      state: 'queued',
      attempts: 1,
      retries: 1,
    });
    // A late attempt of the first job starts nothing.
    await t.render.handle({ outputId: id, retries: 0 });
    expect((await t.outputs.find(id))?.attempts).toBe(1);
    expect(
      t.jobs.jobs.filter(
        (j) => j.key === id && j.queue === RENDER_RELEASE_OUTPUT.name,
      ),
    ).toHaveLength(2);
    expect(t.audit.events.map((e) => e.action)).toEqual([
      'release.output-retry',
    ]);
    await expect(
      t.retry.handle({ actor: publisher, releaseId: first.id, outputId: id }),
    ).rejects.toThrow(ConflictError);
    // A late report of the first job failing for good leaves the queued one alone.
    await t.fail.handle({ outputId: id, retries: 0 });
    expect((await t.outputs.find(id))?.state).toBe('queued');
    // Failing again is told again.
    await t.renderAll();
    expect(t.events.events.filter((e) => e.key === `${id}/1`)).toHaveLength(1);
    // A publisher who reads the whole manual gets the output in full.
    const again = await t.retry.handle({
      actor: publisher,
      releaseId: first.id,
      outputId: id,
    });
    expect(again.whole).toBe(true);
    expect(again.output).toMatchObject({
      id,
      manualId: output?.manualId,
      lang: output?.lang,
      state: 'queued',
      retries: 2,
      error: null,
    });
  });
});

describe('ReplanReleaseOutputsAction', () => {
  it('plans a release again for a publisher of the product, adding only what is missing', async () => {
    const t = setup();
    const first = t.release('1.0');
    const replan = t.replan;
    await expect(
      replan.handle({ actor: READER, releaseId: first.id }),
    ).rejects.toThrow(ForbiddenError);
    expect(
      await replan.handle({ actor: publisher, releaseId: first.id }),
    ).toEqual({ queued: true });
    // Its job still queued: nothing more.
    expect(
      await replan.handle({ actor: publisher, releaseId: first.id }),
    ).toEqual({ queued: false });
    expect(t.audit.events.map((e) => e.action)).toEqual([
      'release.outputs-plan',
    ]);
    await t.plan.handle({ releaseId: first.id });
    const planned = (await t.outputs.all(first.id)).length;
    const renders = t.jobs.jobs.filter(
      (j) => j.queue === RENDER_RELEASE_OUTPUT.name,
    ).length;
    await t.plan.handle({ releaseId: first.id });
    expect((await t.outputs.all(first.id)).length).toBe(planned);
    expect(
      t.jobs.jobs.filter((j) => j.queue === RENDER_RELEASE_OUTPUT.name),
    ).toHaveLength(renders);
  });
});

/** All of a stream's bytes. */
async function bytesOf(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

describe('ReleaseArchiveAction', () => {
  const archiveOf = (t: T, maxBytes = 2 ** 31) =>
    new ReleaseArchiveAction(
      t.store,
      t.outputs,
      t.history.openSnapshot,
      t.blobs,
      { maxBytes },
    );

  it('zips every done output the reader may read, each with the bytes the file route serves', async () => {
    const t = setup();
    const first = t.release('1.0');
    await t.plan.handle({ releaseId: first.id });
    await t.renderAll();
    const archive = await archiveOf(t).handle({
      actor: READER,
      releaseId: first.id,
    });
    expect(archive.fileName).toBe('tuggers_1.0.zip');
    expect(archive).toMatchObject({ files: 12, leftOut: 0 });
    const zip = await bytesOf(archive.stream);
    expect(zip.length).toBe(archive.size);
    const files = unzipSync(zip);
    const listed = await t.list.handle({
      actor: READER,
      releaseId: first.id,
      filter: {},
      page,
    });
    // In the list's order, named <manual>/<lang>/<variant>.pdf.
    expect(Object.keys(files)).toEqual(
      listed.items.map(
        (o) => `${o.manualId}/${o.lang}/${o.variant.replace('=', '-')}.pdf`,
      ),
    );
    for (const output of listed.items) {
      const { blob } = await t.file.handle({
        actor: READER,
        releaseId: first.id,
        outputId: output.id,
      });
      const name = `${output.manualId}/${output.lang}/${output.variant.replace('=', '-')}.pdf`;
      expect(
        Buffer.from(files[name] as Uint8Array).equals(
          await bytesOf(blob.stream),
        ),
      ).toBe(true);
    }
  });

  it('holds only what the reader may read, exactly as the outputs list judges it', async () => {
    const t = setup();
    const first = t.release('1.0');
    await t.plan.handle({ releaseId: first.id });
    await t.renderAll();
    const archive = await archiveOf(t).handle({
      actor: publicReader,
      releaseId: first.id,
    });
    expect(archive).toMatchObject({ files: 8, leftOut: 0 });
    const names = Object.keys(unzipSync(await bytesOf(archive.stream)));
    expect(names.some((n) => n.startsWith('staff/'))).toBe(false);
    expect(names).toHaveLength(8);
    // A reader restricted by module type or facet reads no output's file:
    // there is nothing for them, as the list shows none.
    for (const narrow of [
      actorWith(['content.read'], { moduleTypes: ['concept'] }),
      actorWith(['content.read'], { facets: { 'product-line': ['tuggers'] } }),
      actorWith(['content.read'], { languages: ['de'] }),
    ]) {
      const refused = archiveOf(t).handle({
        actor: narrow,
        releaseId: first.id,
      });
      await expect(refused).rejects.toThrow(ConflictError);
      await expect(refused).rejects.toMatchObject({
        code: 'release-archive-empty',
        meta: { total: 0, notReady: 0 },
      });
    }
    await expect(
      archiveOf(t).handle({ actor: actorWith([]), releaseId: first.id }),
    ).rejects.toThrow(ForbiddenError);
    await expect(
      archiveOf(t).handle({ actor: READER, releaseId: newReleaseId() }),
    ).rejects.toThrow(NotFoundError);
  });

  it('leaves out what is not done, counts it, and is 409 while nothing is', async () => {
    const t = setup();
    const first = t.release('1.0');
    await t.plan.handle({ releaseId: first.id });
    await expect(
      archiveOf(t).handle({ actor: READER, releaseId: first.id }),
    ).rejects.toMatchObject({
      code: 'release-archive-empty',
      meta: { total: 12, notReady: 12 },
    });
    // Render the German ones only; the English stay queued.
    for (const job of t.jobs.jobs.filter(
      (j) => j.queue === RENDER_RELEASE_OUTPUT.name && j.state === 'queued',
    )) {
      const output = await t.outputs.find(
        (job.payload as { outputId: string }).outputId,
      );
      if (output?.lang !== 'de') continue;
      job.state = 'done';
      await t.render.handle(
        job.payload as { outputId: string; retries: number },
      );
    }
    const archive = await archiveOf(t).handle({
      actor: READER,
      releaseId: first.id,
    });
    expect(archive).toMatchObject({ files: 6, leftOut: 6 });
    const names = Object.keys(unzipSync(await bytesOf(archive.stream)));
    expect(names.every((n) => n.split('/')[1] === 'de')).toBe(true);
  });

  it('refuses an archive past the configured size, before reading a file', async () => {
    const t = setup();
    const first = t.release('1.0');
    await t.plan.handle({ releaseId: first.id });
    await t.renderAll();
    const done = (await t.outputs.all(first.id)).map((o) => ({
      name: 'x',
      size: o.size as number,
    }));
    const limit = zipSize(done) - 1;
    const refused = archiveOf(t, limit).handle({
      actor: READER,
      releaseId: first.id,
    });
    await expect(refused).rejects.toThrow(UnprocessableError);
    await expect(refused).rejects.toMatchObject({
      code: 'release-archive-too-large',
      meta: { limit },
    });
  });

  it('never takes a manual without an audience for one whose audience is named "null"', async () => {
    const t = setup();
    const first = t.release('1.0');
    await t.plan.handle({ releaseId: first.id });
    await t.renderAll();
    // Two outputs in one language: one with no audience, one with an
    // audience that happens to be called "null".
    const [a, b] = t.outputs.rows.filter((o) => o.releaseId === first.id);
    t.outputs.rows.splice(
      0,
      t.outputs.rows.length,
      { ...(a as ReleaseOutput), audience: null, lang: 'en' },
      { ...(b as ReleaseOutput), audience: 'null', lang: 'en' },
    );
    const content = await t.history.openSnapshot.handle({
      actor: READER,
      ref: first.tag,
    });
    // The reader reads only the manual whose audience is "null".
    const snapshots = {
      handle: async () =>
        Object.assign(Object.create(content), {
          seesWholeManualIn: async (audience?: string) => audience === 'null',
        }),
    } as unknown as ConstructorParameters<typeof ReleaseArchiveAction>[2];
    const archive = await new ReleaseArchiveAction(
      t.store,
      t.outputs,
      snapshots,
      t.blobs,
      { maxBytes: 2 ** 31 },
    ).handle({ actor: READER, releaseId: first.id });
    expect(archive).toMatchObject({ files: 1, leftOut: 0 });
  });

  it('cuts the stream when a done output’s file is gone', async () => {
    const t = setup();
    const first = t.release('1.0');
    await t.plan.handle({ releaseId: first.id });
    await t.renderAll();
    const archive = await archiveOf(t).handle({
      actor: READER,
      releaseId: first.id,
    });
    t.blobs.blobs.clear();
    await expect(bytesOf(archive.stream)).rejects.toThrow(NotFoundError);
  });
});

describe('archive names', () => {
  const o = (manualId: string, variant: string, lang = 'en') => ({
    manualId,
    variant,
    lang,
    kind: 'pdf' as const,
  });

  it('keeps every part inside its folder: no dots, separators or other characters', () => {
    expect(
      archiveEntryNames([
        o('..', 'model=large'),
        o('a/../../etc', 'x\\y'),
        o('.hidden', ''),
        o('ünï', 'model=small', 'de-CH'),
      ]),
    ).toEqual([
      '-/en/model-large.pdf',
      'a-..-..-etc/en/x-y.pdf',
      '-hidden/en/-.pdf',
      '-n-/de-CH/model-small.pdf',
    ]);
    for (const name of archiveEntryNames([o('..', '..', '..')])) {
      expect(name.split('/').some((part) => /^\.+$/.test(part))).toBe(false);
    }
  });

  it('numbers names that would clash, ignoring case', () => {
    expect(
      archiveEntryNames([
        o('op', 'model=large'),
        o('op', 'model-large'),
        o('op', 'MODEL-LARGE'),
        o('op', 'model-large-2'),
      ]),
    ).toEqual([
      'op/en/model-large.pdf',
      'op/en/model-large-2.pdf',
      'op/en/MODEL-LARGE-3.pdf',
      'op/en/model-large-2-2.pdf',
    ]);
  });

  it('names the archive by the product and revision', () => {
    expect(archiveFileName({ product: 'tuggers', revision: '2.1' })).toBe(
      'tuggers_2.1.zip',
    );
    expect(archiveFileName({ product: 'a b/c', revision: '..' })).toBe(
      'a-b-c_-.zip',
    );
  });
});

describe('ReleaseOutputsProgressAction', () => {
  it('says the outputs are being planned until the plan job ends, then counts those the reader may read', async () => {
    const t = setup();
    const first = t.release('1.0');
    const progress = t.progress;
    const of = (actor: Actor) => progress.handle({ actor, release: first });
    await expect(
      progress.handle({ actor: actorWith([]), release: first }),
    ).rejects.toThrow(ForbiddenError);
    // No plan job (yet): nothing to say but none.
    expect(await of(READER)).toMatchObject({ state: 'done', total: 0 });
    const job = t.jobs.put(
      PLAN_RELEASE_OUTPUTS.name,
      { releaseId: first.id },
      { key: first.id },
    );
    expect(await of(READER)).toEqual({
      state: 'planning',
      total: 0,
      queued: 0,
      rendering: 0,
      done: 0,
      failed: 0,
      refused: null,
      queue: null,
    });
    await t.plan.handle({ releaseId: first.id });
    if (job) job.state = 'done';
    expect(await of(READER)).toEqual({
      state: 'rendering',
      total: 12,
      queued: 12,
      rendering: 0,
      done: 0,
      failed: 0,
      refused: null,
      queue: null,
    });
    // Counted as the outputs list shows them: no internal manual.
    expect(await of(publicReader)).toMatchObject({ total: 8, queued: 8 });
    await t.renderAll();
    expect(await of(READER)).toMatchObject({ state: 'done', done: 12 });
    // A tag that cannot be read: nothing to say.
    expect(
      await progress.handle({
        actor: READER,
        release: { ...first, tag: 'release/tuggers/none' },
      }),
    ).toBeNull();
  });
});

describe('the queue position (#497)', () => {
  it('says how many later releases’ files render first, the count only for a publisher of its product', async () => {
    const t = setup();
    const older = t.release('1.0');
    await t.plan.handle({ releaseId: older.id });
    // Nothing ahead of the newest: no position.
    expect(
      (await t.progress.handle({ actor: publisher, release: older }))?.queue,
    ).toBeNull();
    const newer = t.release('1.1', {
      ...v1,
      config: ProjectConfig.parse({
        ...config,
        outputLabels: { en: { note: 'Remark' } },
      }),
    });
    await t.plan.handle({ releaseId: newer.id });
    expect(
      await t.progress.handle({ actor: publisher, release: older }),
    ).toMatchObject({ state: 'rendering', queued: 12, queue: { ahead: 12 } });
    // Anyone else: nothing, whatever the queue holds.
    expect(
      (await t.progress.handle({ actor: publicReader, release: older }))?.queue,
    ).toBeNull();
    expect(
      (await t.progress.handle({ actor: publisher, release: newer }))?.queue,
    ).toBeNull();
    // Another product's later release is not counted (nor the caller's to know of).
    t.outputs.products.set(newer.id, {
      product: 'other',
      productFacet: newer.productFacet,
    });
    expect(
      (await t.progress.handle({ actor: publisher, release: older }))?.queue,
    ).toBeNull();
    t.outputs.products.set(newer.id, {
      product: newer.product,
      productFacet: newer.productFacet,
    });
    // Once the newer one's files are done, the older one waits for nothing.
    for (const o of await t.outputs.all(newer.id)) {
      await t.outputs.finish(o.id, { sha256: 'a'.repeat(64), size: 1 });
    }
    expect(
      (await t.progress.handle({ actor: publisher, release: older }))?.queue,
    ).toBeNull();
  });

  it('moves a queued output ahead of every release’s bulk work when its file is asked for', async () => {
    const t = setup();
    const first = t.release('1.0', {
      ...v1,
      manifests: Array.from({ length: 15 }, (_, i) =>
        manifest(`m${String(i).padStart(2, '0')}`, ['a']),
      ),
    });
    await t.plan.handle({ releaseId: first.id });
    const all = await t.outputs.all(first.id);
    expect(all).toHaveLength(60);
    // The last one waits for its turn: it has no job yet.
    const waiting = all.at(-1)!;
    expect(t.jobs.jobs.some((j) => j.key === waiting.id)).toBe(false);
    await expect(
      t.file.handle({
        actor: publisher,
        releaseId: first.id,
        outputId: waiting.id,
      }),
    ).rejects.toMatchObject({ code: 'output-not-ready' });
    expect(t.jobs.jobs.find((j) => j.key === waiting.id)?.priority).toBe(
      PROMOTED_PRIORITY,
    );
    // One that has a job already: its priority raised.
    const scheduled = all[0]!;
    await expect(
      t.file.handle({
        actor: publisher,
        releaseId: first.id,
        outputId: scheduled.id,
      }),
    ).rejects.toMatchObject({ code: 'output-not-ready' });
    expect(t.jobs.jobs.find((j) => j.key === scheduled.id)?.priority).toBe(
      PROMOTED_PRIORITY,
    );
    const ran = await t.renderAll();
    expect(ran.slice(0, 2).sort()).toEqual([waiting.id, scheduled.id].sort());
  });

  it('moves no more than PROMOTED_PER_RELEASE of a release up however many files its readers ask for', async () => {
    const t = setup();
    // Many readers, so each one's own budget (PROMOTIONS_PER_READER) is not what bounds it.
    let asked = 0;
    const reader = () => ({ ...READER, id: `reader-${asked++}` });
    const first = t.release('1.0', {
      ...v1,
      manifests: Array.from({ length: 30 }, (_, i) =>
        manifest(`m${String(i).padStart(2, '0')}`, ['a']),
      ),
    });
    await t.plan.handle({ releaseId: first.id });
    const all = await t.outputs.all(first.id);
    expect(all.length).toBeGreaterThan(
      QUEUED_PER_RELEASE + PROMOTED_PER_RELEASE,
    );
    // Every file asked for, those still waiting for their turn first: each still 409.
    for (const o of [...all].reverse()) {
      await expect(
        t.file.handle({ actor: reader(), releaseId: first.id, outputId: o.id }),
      ).rejects.toMatchObject({ code: 'output-not-ready' });
    }
    const render = t.jobs.jobs.filter(
      (j) => j.queue === RENDER_RELEASE_OUTPUT.name,
    );
    // The release's own jobs plus the few moved up: never one per file.
    expect(render).toHaveLength(QUEUED_PER_RELEASE + PROMOTED_PER_RELEASE);
    expect(render.filter((j) => j.priority === PROMOTED_PRIORITY)).toHaveLength(
      PROMOTED_PER_RELEASE,
    );
    expect(render.some((j) => j.priority === INTERACTIVE_PRIORITY)).toBe(false);
    // And every file is still made.
    await t.renderAll();
    expect(
      (await t.outputs.all(first.id)).every((o) => o.state === 'done'),
    ).toBe(true);
  });

  it('moves no more than PROMOTIONS_PER_READER up for one reader a minute; past it the file waits its turn, still 409 (#497)', async () => {
    const t = setup();
    const manifests = Array.from({ length: 15 }, (_, i) =>
      manifest(`m${String(i).padStart(2, '0')}`, ['a']),
    );
    const first = t.release('1.0', { ...v1, manifests });
    await t.plan.handle({ releaseId: first.id });
    // Those still waiting for their turn (no job yet).
    const asked = (await t.outputs.all(first.id))
      .filter(
        (o) => o.state === 'queued' && !t.jobs.jobs.some((j) => j.key === o.id),
      )
      .slice(0, PROMOTIONS_PER_READER + 2);
    expect(asked.length).toBeGreaterThan(PROMOTIONS_PER_READER);
    const ask = (o: ReleaseOutput, actor = READER) =>
      expect(
        t.file.handle({ actor, releaseId: o.releaseId, outputId: o.id }),
      ).rejects.toMatchObject({ code: 'output-not-ready' });
    for (const o of asked) await ask(o);
    const promoted = () =>
      t.jobs.jobs
        .filter((j) => j.priority === PROMOTED_PRIORITY)
        .map((j) => j.key);
    expect(promoted()).toEqual(
      asked.slice(0, PROMOTIONS_PER_READER).map((o) => o.id),
    );
    // The same file asked again moves nothing more and costs nothing.
    await ask(asked[0]!);
    expect(promoted()).toHaveLength(PROMOTIONS_PER_READER);
    // Another reader has a budget of its own.
    const other = { ...READER, id: 'another-reader' };
    const next = asked[PROMOTIONS_PER_READER]!;
    await ask(next, other);
    expect(promoted()).toContain(next.id);
    // A minute on, the first reader may move one up again.
    const later = asked[PROMOTIONS_PER_READER + 1]!;
    await ask(later);
    expect(promoted()).not.toContain(later.id);
    t.clock.now += 60_001;
    await ask(later);
    expect(promoted()).toContain(later.id);
  });

  it('keeps a reader to PROMOTIONS_PER_READER when it asks for many files at once (#497)', async () => {
    const t = setup();
    const first = t.release('1.0', {
      ...v1,
      manifests: Array.from({ length: 15 }, (_, i) =>
        manifest(`m${String(i).padStart(2, '0')}`, ['a']),
      ),
    });
    await t.plan.handle({ releaseId: first.id });
    // Fewer than the release's own bound: only the reader's budget can stop them.
    const asked = (await t.outputs.all(first.id))
      .filter(
        (o) => o.state === 'queued' && !t.jobs.jobs.some((j) => j.key === o.id),
      )
      .slice(0, PROMOTED_PER_RELEASE);
    expect(asked).toHaveLength(PROMOTED_PER_RELEASE);
    expect(PROMOTED_PER_RELEASE).toBeGreaterThan(PROMOTIONS_PER_READER);
    await Promise.all(
      asked.map((o) =>
        expect(
          t.file.handle({ actor: READER, releaseId: first.id, outputId: o.id }),
        ).rejects.toMatchObject({ code: 'output-not-ready' }),
      ),
    );
    expect(
      t.jobs.jobs.filter((j) => j.priority === PROMOTED_PRIORITY),
    ).toHaveLength(PROMOTIONS_PER_READER);
  });

  it('queues a retried output ahead of bulk work, and planning in the order asked', async () => {
    const t = setup();
    const first = t.release('1.0');
    await t.plan.handle({ releaseId: first.id });
    t.renderer.fail = () => new PdfAccessibilityError([problem('no alt')]);
    await t.renderAll();
    t.renderer.fail = undefined;
    const [failed] = await t.outputs.all(first.id);
    await t.retry.handle({
      actor: publisher,
      releaseId: first.id,
      outputId: failed!.id,
    });
    expect(t.jobs.jobs.findLast((j) => j.key === failed!.id)?.priority).toBe(
      INTERACTIVE_PRIORITY,
    );
    expect(await t.outputs.find(failed!.id)).toMatchObject({
      state: 'queued',
    });
    expect((await t.outputs.find(failed!.id))?.scheduledAt).not.toBeNull();

    // Planning again is asked for by a publisher: ahead of every release's planning.
    const second = t.release('1.1');
    expect(
      await t.replan.handle({ actor: publisher, releaseId: second.id }),
    ).toEqual({ queued: true });
    expect(t.jobs.jobs.find((j) => j.key === second.id)?.priority).toBe(
      INTERACTIVE_PRIORITY,
    );
  });

  it('says how many earlier releases are planned before one whose planning waits, only to a publisher of its product (#527)', async () => {
    const t = setup();
    const older = t.release('1.0');
    const newer = t.release('1.1');
    // Both waiting to be planned, as the release action enqueues them.
    for (const r of [older, newer]) {
      await t.jobs.enqueue(
        PLAN_RELEASE_OUTPUTS,
        { releaseId: r.id },
        { key: r.id, priority: releasePriority(r) },
      );
    }
    // Planned in the order cut: the newer one waits for the older one.
    expect(
      await t.progress.handle({ actor: publisher, release: newer }),
    ).toMatchObject({
      state: 'planning',
      total: 0,
      queue: { ahead: 0, releases: 1 },
    });
    // The oldest waits for none; anyone else is told nothing.
    expect(
      (await t.progress.handle({ actor: publisher, release: older }))?.queue,
    ).toBeNull();
    expect(
      (await t.progress.handle({ actor: publicReader, release: newer }))?.queue,
    ).toBeNull();
    // A list of releases leaves it out.
    expect(
      (
        await t.progress.handle({
          actor: publisher,
          release: newer,
          withQueue: false,
        })
      )?.queue,
    ).toBeNull();
    // Another product's earlier release is not counted.
    const other = t.release('9.0');
    const i = t.store.rows.findIndex((r) => r.id === other.id);
    t.store.rows[i] = {
      ...t.store.rows[i]!,
      product: 'other',
      publishedAt: new Date(older.publishedAt.getTime() - 1000),
    };
    await t.jobs.enqueue(
      PLAN_RELEASE_OUTPUTS,
      { releaseId: other.id },
      { key: other.id },
    );
    expect(
      (await t.progress.handle({ actor: publisher, release: newer }))?.queue,
    ).toEqual({ ahead: 0, releases: 1 });
    // Its job running, holding the turn while the older one is planned first: still told.
    const job = t.jobs.jobs.find((j) => j.key === newer.id)!;
    job.state = 'running';
    expect(
      (await t.progress.handle({ actor: publisher, release: newer }))?.queue,
    ).toEqual({ ahead: 0, releases: 1 });
    // The older one planned (it has rows), its own job still to come: nothing ahead.
    job.state = 'queued';
    await t.plan.handle({ releaseId: older.id });
    expect(
      (await t.progress.handle({ actor: publisher, release: newer }))?.queue,
    ).toBeNull();
  });

  it('does not wait for an earlier release whose planning ended without outputs (#527)', async () => {
    const t = setup();
    const older = t.release('1.0');
    const newer = t.release('1.1');
    for (const r of [older, newer]) {
      await t.jobs.enqueue(
        PLAN_RELEASE_OUTPUTS,
        { releaseId: r.id },
        { key: r.id, priority: releasePriority(r) },
      );
    }
    // The older one's planning failed for good: no rows, no open job.
    t.jobs.jobs.find((j) => j.key === older.id)!.state = 'failed';
    expect(
      (await t.progress.handle({ actor: publisher, release: newer }))?.queue,
    ).toBeNull();
  });
});

describe('releases planned newest first (#497)', () => {
  /** `a` changed in German: `only-a` and `staff` in German differ from v1. */
  const v2 = {
    ...v1,
    modules: [module('a'), changed('a', 'de'), module('b'), module('b', 'de')],
  };
  const changedInGerman = [
    'only-a/model=large/de',
    'only-a/model=small/de',
    'staff/model=large/de',
    'staff/model=small/de',
  ];
  /** The release's outputs to render (queued), as `<manual>/<variant>/<lang>`. */
  const queuedOf = async (t: T, r: Release) =>
    (await t.outputs.all(r.id))
      .filter((o) => o.state === 'queued')
      .map((o) => `${o.manualId}/${o.variant}/${o.lang}`);
  const sameOutput = (a: ReleaseOutput) => (b: ReleaseOutput) =>
    a.manualId === b.manualId && a.variant === b.variant && a.lang === b.lang;

  it('compares a release with the nearest planned one before it while the one between waits, which joins both later', async () => {
    const t = setup();
    const first = t.release('1.0');
    await t.plan.handle({ releaseId: first.id });
    await t.renderAll();
    // 1.1 and 1.2 cut while 1.0's were the last planned; 1.2 is planned first.
    const second = t.release('1.1', v2);
    const third = t.release('1.2', v2);
    await t.plan.handle({ releaseId: third.id });
    // Against 1.0: what neither changed is 1.0's file at once, the newest release's first.
    expect(await queuedOf(t, third)).toEqual(changedInGerman);
    expect(
      (await t.outputs.all(third.id)).filter((o) => o.state === 'done'),
    ).toHaveLength(8);
    // 1.1 now: against 1.0 before it and 1.2 after it, the same inputs as 1.2.
    await t.plan.handle({ releaseId: second.id });
    expect(await queuedOf(t, second)).toEqual(changedInGerman);
    const rendered = t.renderer.keys.length;
    await t.renderAll();
    // Each changed file once, at 1.1, the oldest that has it; 1.2 reuses it (#328: its date).
    expect(t.renderer.keys.slice(rendered)).toHaveLength(4);
    expect(
      t.renderer.keys.slice(rendered).every((k) => k.includes(second.commit)),
    ).toBe(true);
    for (const mine of await t.outputs.all(third.id)) {
      const theirs = (await t.outputs.all(second.id)).find(sameOutput(mine));
      expect(mine.state).toBe('done');
      expect(mine.sha256).toBe(theirs?.sha256);
      if (
        changedInGerman.includes(
          `${mine.manualId}/${mine.variant}/${mine.lang}`,
        )
      ) {
        expect(mine.reusedFrom).toEqual({
          releaseId: second.id,
          outputId: theirs?.id,
        });
      } else {
        expect(mine.reusedFrom?.releaseId).toBe(first.id);
      }
    }
  });

  it('renders each file once at the oldest release when the newer one is planned first and no earlier one is (#328)', async () => {
    const t = setup();
    const older = t.release('1.0');
    const newer = t.release('1.1');
    // The newest first: nothing before it is planned, so its files are its own groups.
    await t.plan.handle({ releaseId: newer.id });
    expect(await queuedOf(t, newer)).toHaveLength(12);
    // The older one joins them: it changed nothing they show.
    await t.plan.handle({ releaseId: older.id });
    const ran = await t.renderAll();
    expect(t.renderer.keys).toHaveLength(12);
    expect(t.renderer.keys.every((k) => k.includes(older.commit))).toBe(true);
    // The newer release's jobs went first, and made the older release's files.
    const newerIds = new Set((await t.outputs.all(newer.id)).map((o) => o.id));
    expect(ran.slice(0, 12).every((id) => newerIds.has(id))).toBe(true);
    for (const mine of await t.outputs.all(newer.id)) {
      const theirs = (await t.outputs.all(older.id)).find(sameOutput(mine));
      expect(theirs).toMatchObject({ state: 'done', reusedFrom: null });
      expect(mine).toMatchObject({
        state: 'done',
        sha256: theirs?.sha256,
        reusedFrom: { releaseId: older.id, outputId: theirs?.id },
      });
    }
  });

  it('never gives an older release a newer release’s file: one rendered before it was planned is rendered again for it (#328)', async () => {
    const t = setup();
    const older = t.release('1.0');
    const newer = t.release('1.1');
    await t.plan.handle({ releaseId: newer.id });
    await t.renderAll();
    const newerFiles = (await t.outputs.all(newer.id)).map((o) => o.sha256);
    await t.plan.handle({ releaseId: older.id });
    expect(await queuedOf(t, older)).toHaveLength(12);
    await t.renderAll();
    expect(t.renderer.keys).toHaveLength(24);
    for (const o of await t.outputs.all(older.id)) {
      expect(o).toMatchObject({ state: 'done', reusedFrom: null });
    }
    // The newer release keeps its own files.
    expect((await t.outputs.all(newer.id)).map((o) => o.sha256)).toEqual(
      newerFiles,
    );
  });

  it('joins a later release’s groups into the one it shares with an earlier release: one file for all three', async () => {
    const t = setup();
    const first = t.release('1.0');
    const second = t.release('1.1');
    const third = t.release('1.2');
    await t.plan.handle({ releaseId: first.id });
    await t.plan.handle({ releaseId: third.id });
    // 1.2's outputs in groups of their own, as when it could not be compared with 1.0
    // (`too-many-changes` across the two): planned apart.
    for (const [i, row] of t.outputs.rows.entries()) {
      if (row.releaseId === third.id) {
        t.outputs.rows[i] = { ...row, reuseGroup: row.id };
      }
    }
    // 1.1, between: the same inputs as both, so their groups are one.
    await t.plan.handle({ releaseId: second.id });
    const groups = new Set(
      t.outputs.rows
        .filter(
          (o) =>
            o.manualId === 'only-b' &&
            o.variant === 'model=small' &&
            o.lang === 'en',
        )
        .map((o) => o.reuseGroup),
    );
    expect(groups.size).toBe(1);
    await t.renderAll();
    expect(t.renderer.keys).toHaveLength(12);
    expect(t.renderer.keys.every((k) => k.includes(first.commit))).toBe(true);
    for (const r of [second, third]) {
      for (const o of await t.outputs.all(r.id)) {
        expect(o).toMatchObject({
          state: 'done',
          reusedFrom: { releaseId: first.id },
        });
      }
    }
  });

  it('compares across a maintenance line: a line’s release planned before its base joins the base’s groups (#60)', async () => {
    const t = setup();
    const base = t.release('1.0');
    const lineId = newReleaseId();
    t.lines.rows.push({
      id: lineId,
      product: 'tuggers',
      revision: '1.0',
      baseRelease: base.id,
      baseCommit: base.commit,
      branch: 'maintenance/tuggers/1.0',
      createdBy: { kind: 'user', id: 'sample-publisher' },
      createdAt: new Date(),
      closedAt: null,
      closedBy: null,
    });
    // main's next release changes `b`; the line's fix changes `a` in German.
    const onMain = t.release('2.0', {
      ...v1,
      modules: [
        module('a'),
        module('a', 'de'),
        changed('b', 'en'),
        changed('b', 'de'),
      ],
    });
    const fix = t.release('1.0.1', v2);
    t.lines.released.set(fix.id, lineId);
    // Newest first: the fix, then main's 2.0, then the base.
    await t.plan.handle({ releaseId: fix.id });
    await t.plan.handle({ releaseId: onMain.id });
    await t.plan.handle({ releaseId: base.id });
    await t.renderAll();
    // The base's files serve both: the fix where it left them, 2.0 where it did.
    const fromBase = async (r: Release) =>
      (await t.outputs.all(r.id))
        .filter((o) => o.reusedFrom?.releaseId === base.id)
        .map((o) => `${o.manualId}/${o.variant}/${o.lang}`);
    expect(await fromBase(fix)).toHaveLength(8);
    expect((await fromBase(fix)).some((k) => changedInGerman.includes(k))).toBe(
      false,
    );
    expect(await fromBase(onMain)).toEqual([
      'only-a/model=large/de',
      'only-a/model=large/en',
      'only-a/model=small/de',
      'only-a/model=small/en',
      'staff/model=large/de',
      'staff/model=large/en',
      'staff/model=small/de',
      'staff/model=small/en',
    ]);
    // 12 for the base, the fix's 4, 2.0's 4 (only-b): each once.
    expect(t.renderer.keys).toHaveLength(20);
  });
});

/**
 * Every input that changes a release's PDF bytes (#497): a change to one renders again the
 * outputs it shows in, and no change reuses every file. Branding is not among them: the editor's
 * branding never reaches a PDF (a page design's logo is content, below).
 */
describe('what a file is reused for (#497)', () => {
  const all = [
    'only-a/model=large/de',
    'only-a/model=large/en',
    'only-a/model=small/de',
    'only-a/model=small/en',
    'only-b/model=large/de',
    'only-b/model=large/en',
    'only-b/model=small/de',
    'only-b/model=small/en',
    'staff/model=large/de',
    'staff/model=large/en',
    'staff/model=small/de',
    'staff/model=small/en',
  ];
  const term = (preferred: string) =>
    `schemaVersion: 1\nstatus: approved\nlanguages:\n  de:\n    preferred: ${preferred}\n`;
  const design = (primary: string) =>
    [
      'schemaVersion: 1',
      'name: House',
      'preset: minimal',
      'colours:',
      `  primary: "${primary}"`,
      '  accent: "#b45309"',
      '  text: "#1f2328"',
      '',
    ].join('\n');
  /** v1 with a page design and its own template, a symbol and a term. */
  const base = {
    ...v1,
    pageDesigns: { house: design('#1f4e79') },
    designTemplates: { house: { 'manual.typ': '#let manual(doc) = doc\n' } },
    symbols: { 'symbols/warning.svg': new TextEncoder().encode('<svg/>') },
    terms: { pump: term('Pumpe') },
  };
  const cases: [string, Parameters<T['release']>[1], string[]][] = [
    ['nothing', base, []],
    [
      'a module, in a translation: its manuals in that language',
      {
        ...base,
        modules: [
          module('a'),
          changed('a', 'de'),
          module('b'),
          module('b', 'de'),
        ],
      },
      [
        'only-a/model=large/de',
        'only-a/model=small/de',
        'staff/model=large/de',
        'staff/model=small/de',
      ],
    ],
    [
      'a module, in the source language: its manuals in every language',
      {
        ...base,
        modules: [
          module('a'),
          module('a', 'de'),
          changed('b', 'en'),
          module('b', 'de'),
        ],
      },
      all.filter((k) => k.startsWith('only-b/')),
    ],
    [
      'a manual’s title (its manifest): that manual in every language',
      {
        ...base,
        manifests: [
          manifest('only-a', ['a']),
          { ...manifest('only-b', ['b']), title: 'Another title' },
          internalManual,
        ],
      },
      all.filter((k) => k.startsWith('only-b/')),
    ],
    [
      'a manual’s variants: that manual',
      {
        ...base,
        manifests: [
          manifest('only-a', ['a']),
          manifest('only-b', ['b']),
          { ...internalManual, variants: internalManual.variants.slice(0, 1) },
        ],
      },
      // The one variant left, rendered again; the other is gone.
      ['staff/model=small/de', 'staff/model=small/en'],
    ],
    [
      'the configuration (its labels): everything',
      {
        ...base,
        config: ProjectConfig.parse({
          ...config,
          outputLabels: { de: { note: 'Bemerkung' } },
        }),
      },
      all,
    ],
    [
      'a label in one language (#752, the configuration): everything',
      {
        ...base,
        config: ProjectConfig.parse({
          ...config,
          variantAttributes: config.variantAttributes.map((a) =>
            a.kind === 'enum'
              ? {
                  ...a,
                  values: a.values.map((v) =>
                    v.id === 'small'
                      ? { ...v, label: { en: 'Small', de: 'Klein' } }
                      : v,
                  ),
                }
              : a,
          ),
        }),
      },
      all,
    ],
    [
      'a manual’s title in one language (#752, its manifest): that manual in every language',
      {
        ...base,
        manifests: [
          manifest('only-a', ['a']),
          {
            ...manifest('only-b', ['b']),
            title: {
              en: manifest('only-b', ['b']).title as string,
              de: 'Nur B',
            },
          },
          internalManual,
        ],
      },
      all.filter((k) => k.startsWith('only-b/')),
    ],
    [
      'a page design: everything',
      { ...base, pageDesigns: { house: design('#0b3d2e') } },
      all,
    ],
    [
      'a page design’s own template: everything',
      {
        ...base,
        designTemplates: {
          house: { 'manual.typ': '#let manual(doc) = [#doc]\n' },
        },
      },
      all,
    ],
    [
      'a safety symbol: everything',
      {
        ...base,
        symbols: {
          'symbols/warning.svg': new TextEncoder().encode('<svg></svg>'),
        },
      },
      all,
    ],
    [
      'a term: everything',
      { ...base, terms: { pump: term('Förderpumpe') } },
      all,
    ],
  ];

  it.each(cases)('changing %s renders it again', async (_, next, rendered) => {
    const t = setup();
    const first = t.release('1.0', base);
    await t.plan.handle({ releaseId: first.id });
    await t.renderAll();
    const second = t.release('1.1', next);
    await t.plan.handle({ releaseId: second.id });
    const planned = await t.outputs.all(second.id);
    const key = (o: ReleaseOutput) => `${o.manualId}/${o.variant}/${o.lang}`;
    expect(planned.filter((o) => o.state === 'queued').map(key)).toEqual(
      rendered,
    );
    // The rest: the first release's very file, without a render.
    const before = t.renderer.keys.length;
    for (const o of planned.filter((p) => p.state !== 'queued')) {
      expect(o).toMatchObject({
        state: 'done',
        reusedFrom: { releaseId: first.id },
      });
    }
    await t.renderAll();
    expect(t.renderer.keys.length - before).toBe(rendered.length);
  });
});

describe('a release whose render jobs were lost (#497)', () => {
  it('gets them again from the sweep once its outputs stopped moving, and renders every file', async () => {
    const t = setup();
    const first = t.release('1.0', {
      ...v1,
      manifests: Array.from({ length: 15 }, (_, i) =>
        manifest(`m${String(i).padStart(2, '0')}`, ['a']),
      ),
    });
    await t.plan.handle({ releaseId: first.id });
    // Every job gone without ending its output (cancelled, dropped).
    const before = t.jobs.jobs.length;
    t.jobs.jobs.splice(0, before);
    expect(await t.renderAll()).toEqual([]);
    // Not stalled yet: nothing.
    expect(await t.sweep.handle({ now: new Date() })).toBe(0);
    expect(t.jobs.jobs).toHaveLength(0);
    const later = new Date(Date.now() + STALLED_AFTER_MS + 1_000);
    expect(await t.sweep.handle({ now: later })).toBe(1);
    expect(t.jobs.jobs).toHaveLength(QUEUED_PER_RELEASE);
    await t.renderAll();
    expect(
      (await t.outputs.all(first.id)).every((o) => o.state === 'done'),
    ).toBe(true);
    // Done: nothing more to look at.
    expect(await t.sweep.handle({ now: later })).toBe(0);
  });

  it('shares where the sweep stopped across servers: one that lost the window to another looks at none (#527)', async () => {
    const t = setup();
    const first = t.release('1.0', {
      ...v1,
      manifests: [manifest('m00', ['a'])],
    });
    await t.plan.handle({ releaseId: first.id });
    t.jobs.jobs.splice(0, t.jobs.jobs.length);
    const later = new Date(Date.now() + STALLED_AFTER_MS + 1_000);
    // Another server moved the cursor between this one's reading and its move.
    const read = t.outputs.sweepCursor.bind(t.outputs);
    t.outputs.sweepCursor = async () => {
      const cursor = await read();
      t.outputs.sweep = { version: cursor.version + 1 };
      return cursor;
    };
    expect(await t.sweep.handle({ now: later })).toBe(0);
    expect(t.jobs.jobs).toHaveLength(0);
    t.outputs.sweepCursor = read;
    expect(await t.sweep.handle({ now: later })).toBe(1);
    expect(t.jobs.jobs.length).toBeGreaterThan(0);
    // Fewer than a sweep's worth: the next starts from the first again.
    expect(t.outputs.sweep.after).toBeUndefined();
  });

  it('keeps waiting render jobs for a year, not the queue’s two weeks', () => {
    expect(RENDER_RELEASE_OUTPUT.retentionSeconds).toBe(365 * 86_400);
  });
});

describe('a release over the limit of outputs (#477)', () => {
  // Its planning logs the refusal (tested above): kept out of the output.
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('is failed in its progress, with the count only for a publisher of its product', async () => {
    const t = setup();
    t.settings.maxOutputs = 10;
    const first = t.release('1.0');
    await t.plan.handle({ releaseId: first.id });
    expect(
      await t.progress.handle({ actor: publisher, release: first }),
    ).toEqual({
      state: 'failed',
      total: 0,
      queued: 0,
      rendering: 0,
      done: 0,
      failed: 0,
      refused: { reason: 'too-many-outputs', wanted: 12, max: 10 },
      queue: null,
    });
    expect(
      await t.progress.handle({ actor: READER, release: first }),
    ).toMatchObject({
      state: 'failed',
      refused: { reason: 'too-many-outputs', wanted: null, max: 10 },
    });
  });

  it('is 422 too-many-outputs when planned again, from the refusal its planning recorded, and queues nothing', async () => {
    const t = setup();
    t.settings.maxOutputs = 10;
    const first = t.release('1.0');
    await t.plan.handle({ releaseId: first.id });
    const tooMany = {
      code: 'too-many-outputs',
      meta: { wanted: 12, max: 10 },
    };
    // No tag is read for it.
    const open = vi.spyOn(t.history.openSnapshot, 'handle');
    await expect(
      t.replan.handle({ actor: publisher, releaseId: first.id }),
    ).rejects.toMatchObject(tooMany);
    await expect(
      t.replan.handle({ actor: publisher, releaseId: first.id }),
    ).rejects.toThrow(UnprocessableError);
    expect(open).toHaveBeenCalledTimes(2); // the release's own read, as the actor
    // The limit is checked after who asks: a reader learns nothing.
    await expect(
      t.replan.handle({ actor: READER, releaseId: first.id }),
    ).rejects.toThrow(ForbiddenError);
    expect(t.jobs.jobs).toEqual([]);
    expect(t.audit.events).toEqual([]);
    // Raised: queued as before; the refusal no longer told, its planning (which planned
    // nothing) a failed one until it is planned again.
    t.settings.maxOutputs = 12;
    expect(
      await t.progress.handle({ actor: publisher, release: first }),
    ).toMatchObject({ state: 'failed', total: 0, refused: null });
    expect(
      await t.replan.handle({ actor: publisher, releaseId: first.id }),
    ).toEqual({ queued: true });
  });

  it('keeps the refusal when the batch that would forget it is rolled back', async () => {
    const t = setup();
    t.settings.maxOutputs = 10;
    const first = t.release('1.0');
    await t.plan.handle({ releaseId: first.id });
    t.settings.maxOutputs = 12;
    t.outputs.insertMissing = async () => {
      throw new Error('The database went away.');
    };
    await expect(t.plan.handle({ releaseId: first.id })).rejects.toThrow(
      'went away',
    );
    expect(await t.outputs.refusal(first.id)).toMatchObject({ wanted: 12 });
  });
});

describe('outputsProgress', () => {
  const none = { queued: 0, rendering: 0, done: 0, failed: 0 };
  it('is planning while the plan job is open, whatever the rows say', () => {
    for (const job of ['queued', 'running', 'retrying'] as const) {
      expect(outputsProgress(job, { ...none, done: 2 }).state).toBe('planning');
    }
  });
  it('is rendering while any output is under way, then failed or done', () => {
    expect(outputsProgress('done', { ...none, queued: 1, failed: 1 })).toEqual({
      state: 'rendering',
      total: 2,
      queued: 1,
      rendering: 0,
      done: 0,
      failed: 1,
      refused: null,
      queue: null,
    });
    expect(outputsProgress('done', { ...none, rendering: 1 }).state).toBe(
      'rendering',
    );
    expect(outputsProgress('done', { ...none, done: 3, failed: 1 }).state).toBe(
      'failed',
    );
    expect(outputsProgress(undefined, { ...none, done: 3 }).state).toBe('done');
  });
  it('tells a planning that failed for good from a release without outputs', () => {
    expect(outputsProgress('failed', none).state).toBe('failed');
    expect(outputsProgress('cancelled', none).state).toBe('failed');
    expect(outputsProgress('done', none)).toEqual({
      state: 'done',
      total: 0,
      ...none,
      refused: null,
      queue: null,
    });
    expect(outputsProgress(undefined, none).state).toBe('done');
  });
  it('is failed when planning failed for good after some batches: the set is incomplete (#477)', () => {
    expect(outputsProgress('failed', { ...none, done: 5 }).state).toBe(
      'failed',
    );
    expect(outputsProgress('cancelled', { ...none, done: 5 }).state).toBe(
      'failed',
    );
  });
  it('is failed for a refused planning, until it is planned again (#477)', () => {
    const refused = {
      reason: 'too-many-outputs' as const,
      wanted: 12,
      max: 10,
    };
    expect(outputsProgress('done', none, refused)).toEqual({
      state: 'failed',
      total: 0,
      ...none,
      refused,
      queue: null,
    });
    expect(outputsProgress('queued', none, refused)).toMatchObject({
      state: 'planning',
      refused: null,
      queue: null,
    });
  });
});

describe('outputRenderer', () => {
  it('reads up to the manual’s audience, the most restricted level for none', () => {
    expect(outputRenderer('public', config).roles[0]?.scope).toEqual({
      maxAudience: 'public',
    });
    expect(outputRenderer(null, config).roles[0]?.scope).toEqual({
      maxAudience: 'internal',
    });
  });
});

it('names the plan job by the release', () => {
  expect(PLAN_RELEASE_OUTPUTS.name).toBe('release.plan-outputs');
});

describe('offline packages (#59)', () => {
  const PNG = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
  ]);
  const sha = (bytes: Uint8Array) =>
    createHash('sha256').update(bytes).digest('hex');
  const internalImage = new Uint8Array([...PNG, 9, 9, 9]);
  const publicImage = new Uint8Array([...PNG, 7]);
  const secret: Module = {
    ...module('secret', 'en', 'Internal only.'),
    meta: { ...module('secret').meta, audience: 'internal' },
    blocks: [
      {
        type: 'paragraph',
        id: 'p',
        content: [{ type: 'text', text: 'Internal only.' }],
      },
      {
        type: 'image',
        id: 'i',
        asset: `sha256:${sha(internalImage)}`,
        alt: 'Inside',
      },
    ],
  };
  const shown: Module = {
    ...module('a'),
    blocks: [
      ...module('a').blocks,
      {
        type: 'image',
        id: 'i',
        asset: `sha256:${sha(publicImage)}`,
        alt: 'Outside',
      },
    ],
  };
  /**
   * `only-a` (public) names `a` (public, an image) and `secret` (internal, its
   * own image), which it never shows; `staff` (internal) shows both.
   */
  const content = {
    ...v1,
    modules: [
      shown,
      module('a', 'de'),
      module('b'),
      module('b', 'de'),
      secret,
      { ...secret, meta: { ...secret.meta, lang: 'de' } },
    ],
    manifests: [
      manifest('only-a', ['a', 'secret']),
      manifest('only-b', ['b']),
      { ...manifest('staff', ['a', 'secret']), audience: 'internal' },
    ],
  };

  async function built() {
    const t = setup();
    t.settings.offlinePackages = true;
    await t.blobs.put(Readable.from([internalImage]), {
      contentType: 'image/png',
      maxBytes: 1000,
    });
    await t.blobs.put(Readable.from([publicImage]), {
      contentType: 'image/png',
      maxBytes: 1000,
    });
    const r = t.release('1.0', content);
    await t.plan.handle({ releaseId: r.id });
    return { t, r };
  }

  const packageOf = async (
    t: T,
    r: Release,
    lang: string,
    audience: string,
  ) => {
    const found = (await t.outputs.all(r.id)).find(
      (o) =>
        o.kind === 'offline-package' &&
        o.lang === lang &&
        o.audience === audience,
    );
    if (!found?.sha256) throw new Error(`no package ${lang}/${audience}`);
    const blob = t.blobs.blobs.get(found.sha256);
    if (!blob) throw new Error('no blob');
    return { output: found, files: unzipSync(new Uint8Array(blob.data)) };
  };
  const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

  it('plans one per language and audience level, and builds each once every PDF is done', async () => {
    const { t, r } = await built();
    const packages = (await t.outputs.all(r.id)).filter(
      (o) => o.kind === 'offline-package',
    );
    expect(
      packages.map((o) => `${o.lang}/${o.audience}/${o.manualId}`).sort(),
    ).toEqual(['de/internal/*', 'de/public/*', 'en/internal/*', 'en/public/*']);
    const ran = await t.renderAll();
    const kinds = ran.map(
      (id) => t.outputs.rows.find((o) => o.id === id)?.kind,
    );
    // Every PDF before the first package.
    expect(kinds.indexOf('offline-package')).toBe(kinds.lastIndexOf('pdf') + 1);
    expect((await t.outputs.all(r.id)).every((o) => o.state === 'done')).toBe(
      true,
    );
  });

  it('is never moved up when asked for before it is built, and costs the reader no place (#497)', async () => {
    const { t, r } = await built();
    const reader = { ...READER, id: 'package-reader' };
    const packages = (await t.outputs.all(r.id)).filter(
      (o) => o.kind === 'offline-package',
    );
    for (const p of packages) {
      await expect(
        t.file.handle({ actor: reader, releaseId: r.id, outputId: p.id }),
      ).rejects.toMatchObject({ code: 'output-not-ready' });
    }
    expect(
      t.jobs.jobs.filter((j) => j.priority === PROMOTED_PRIORITY),
    ).toHaveLength(0);
    // The reader's whole budget is left for its PDFs.
    const pdfs = (await t.outputs.all(r.id)).filter(
      (o) => o.kind === 'pdf' && o.state === 'queued',
    );
    for (const p of pdfs.slice(0, PROMOTIONS_PER_READER)) {
      await expect(
        t.file.handle({ actor: reader, releaseId: r.id, outputId: p.id }),
      ).rejects.toMatchObject({ code: 'output-not-ready' });
    }
    expect(
      t.jobs.jobs.filter((j) => j.priority === PROMOTED_PRIORITY).length,
    ).toBe(Math.min(pdfs.length, PROMOTIONS_PER_READER));
  });

  it('holds, in a lower level’s package, no text, image or page of a module or manual above it', async () => {
    const { t, r } = await built();
    await t.renderAll();
    const pub = (await packageOf(t, r, 'en', 'public')).files;
    const names = Object.keys(pub);
    const all = names.map((n) => text(pub[n] as Uint8Array)).join('\n');
    expect(all).not.toContain('Internal only.');
    expect(all).not.toContain('Title of secret');
    expect(names.some((n) => n.includes('staff'))).toBe(false);
    expect(names.some((n) => n.includes(sha(internalImage)))).toBe(false);
    expect(names).toContain(`media/${sha(publicImage)}.png`);
    expect(names).toContain('pdf/only-a/en/model-small.pdf');
    // The internal level's holds all of it.
    const internal = (await packageOf(t, r, 'en', 'internal')).files;
    const inside = Object.keys(internal);
    expect(inside).toContain(`media/${sha(internalImage)}.png`);
    expect(inside.some((n) => n.startsWith('manuals/staff/'))).toBe(true);
    expect(inside.some((n) => n.startsWith('pdf/staff/'))).toBe(true);
    expect(
      text(internal['manuals/staff/model-small.html'] as Uint8Array),
    ).toContain('Internal only.');
  });

  it('lists every other file in its manifest with the SHA-256 and size it holds', async () => {
    const { t, r } = await built();
    await t.renderAll();
    const { output, files } = await packageOf(t, r, 'de', 'public');
    const manifest = JSON.parse(text(files['manifest.json'] as Uint8Array));
    expect(manifest).toMatchObject({
      format: 'openfolia-offline-package',
      release: { id: r.id, tag: r.tag, commit: r.commit },
      revision: '1.0',
      lang: 'de',
      audience: 'public',
      leftOut: [],
    });
    const listed = manifest.files as {
      path: string;
      size: number;
      sha256: string;
    }[];
    expect(listed.map((f) => f.path).sort()).toEqual(
      Object.keys(files)
        .filter((n) => n !== 'manifest.json')
        .sort(),
    );
    for (const f of listed) {
      const bytes = files[f.path] as Uint8Array;
      expect(f.size).toBe(bytes.length);
      expect(f.sha256).toBe(sha(bytes));
    }
    expect(output.size).toBeGreaterThan(0);
  });

  it('builds each on a job of its own, with its own time, and stops a cut-off attempt between files', async () => {
    const { t, r } = await built();
    await t.renderAll();
    const rows = await t.outputs.all(r.id);
    for (const o of rows) {
      const job = t.jobs.jobs.find((j) => j.key === o.id);
      expect(job?.queue).toBe(outputJob(o).name);
    }
    expect(BUILD_OFFLINE_PACKAGE.timeoutSeconds).toBeGreaterThan(
      RENDER_RELEASE_OUTPUT.timeoutSeconds ?? 0,
    );
    // A package queued again and its attempt cut off: it is not done, and the error is thrown for a retry.
    const pkg = rows.find((o) => o.kind === 'offline-package');
    if (!pkg) throw new Error('no package');
    const row = t.outputs.rows.find((o) => o.id === pkg.id);
    Object.assign(row as object, { state: 'queued', sha256: null, size: null });
    const signal = AbortSignal.abort(new Error('cut off'));
    await expect(
      t.render.handle({ outputId: pkg.id, retries: pkg.retries, signal }),
    ).rejects.toThrow('cut off');
    expect((await t.outputs.find(pkg.id))?.state).not.toBe('done');
  });

  it('fails one past the size limit with offline-package-too-large, and keeps the PDFs', async () => {
    const t = setup();
    t.settings.offlinePackages = true;
    const r = t.release('1.0');
    await t.plan.handle({ releaseId: r.id });
    // The PDFs first, then the limit for the packages.
    const build = (
      t.render as unknown as { packages: { settings: { maxBytes: number } } }
    ).packages;
    build.settings.maxBytes = 200;
    await t.renderAll();
    const rows = await t.outputs.all(r.id);
    expect(
      rows.filter((o) => o.kind === 'pdf').every((o) => o.state === 'done'),
    ).toBe(true);
    const packages = rows.filter((o) => o.kind === 'offline-package');
    expect(packages.length).toBeGreaterThan(0);
    for (const p of packages) {
      expect(p.state).toBe('failed');
      expect(p.error?.code).toBe('offline-package-too-large');
    }
  });

  it('is listed only to a reader of its whole level, and its file is a ZIP by its name', async () => {
    const { t, r } = await built();
    await t.renderAll();
    const seen = await t.list.handle({
      actor: publicReader,
      releaseId: r.id,
      page,
      filter: { kind: 'offline-package' },
    });
    expect(seen.items.map((o) => `${o.lang}/${o.audience}`).sort()).toEqual([
      'de/public',
      'en/public',
    ]);
    const internal = await packageOf(t, r, 'en', 'internal');
    await expect(
      t.file.handle({
        actor: publicReader,
        releaseId: r.id,
        outputId: internal.output.id,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    const own = await packageOf(t, r, 'en', 'public');
    const file = await t.file.handle({
      actor: publicReader,
      releaseId: r.id,
      outputId: own.output.id,
    });
    expect(file.fileName).toBe('offline_public_en_1.0.zip');
  });

  it('writes an SVG from content or a symbol made inert, and an XML attachment under a name that opens as nothing', async () => {
    const hostile = (label: string) =>
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="10" height="10" onload="alert('${label}')">` +
          `<script>alert('${label}')</script><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>` +
          '<rect width="10" height="10" fill="#c00" onclick="alert(2)"/><a xlink:href="javascript:alert(1)"><path d="M0 0"/></a>' +
          '<image href="https://example.com/beacon.png"/><circle r="3" fill="url(https://example.com/f)"/></svg>',
      );
    const image = hostile('image');
    const symbol = hostile('symbol');
    const xml = Buffer.from(
      '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><script>alert(3)</script></html>',
    );
    const t = setup();
    t.settings.offlinePackages = true;
    t.html.symbols = ['hot'];
    await t.blobs.put(Readable.from([image]), {
      contentType: 'image/svg+xml',
      maxBytes: 10_000,
    });
    await t.blobs.put(Readable.from([xml]), {
      contentType: 'application/xml',
      maxBytes: 10_000,
    });
    const drawn: Module = {
      ...module('a'),
      blocks: [
        ...module('a').blocks,
        { type: 'image', id: 'i', asset: `sha256:${sha(image)}`, alt: 'X' },
        {
          type: 'attachment',
          id: 'x',
          asset: `sha256:${sha(xml)}`,
          name: 'Data',
          fileName: 'data.xml',
          mediaType: 'application/xml',
          size: xml.length,
        },
      ],
    };
    const r = t.release('1.0', {
      ...v1,
      modules: [drawn, module('a', 'de')],
      config: {
        ...config,
        safetySymbols: [{ id: 'hot', label: 'Hot surface' }],
      },
      manifests: [manifest('only-a', ['a'])],
      symbols: { 'symbols/hot.svg': symbol },
    });
    await t.plan.handle({ releaseId: r.id });
    await t.renderAll();
    const { files } = await packageOf(t, r, 'en', 'public');
    const svgs = [`media/${sha(image)}.svg`, 'symbols/hot.svg'];
    for (const name of svgs) {
      const body = text(files[name] as Uint8Array);
      expect(body).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
      expect(body).toContain('<rect width="10" height="10" fill="#c00">');
      expect(body).not.toMatch(
        /script|alert|onload|onclick|javascript|foreignObject|<a[ >]|<image|example\.com/i,
      );
    }
    // The XML is kept byte for byte, as a file a browser shows no page for.
    expect(files[`media/${sha(xml)}.bin`]).toEqual(new Uint8Array(xml));
    expect(Object.keys(files).some((n) => n.endsWith('.xml'))).toBe(false);
    const page = text(files['manuals/only-a/model-small.html'] as Uint8Array);
    expect(page).toContain(`../../media/${sha(image)}.svg`);
    expect(page).toContain(`../../media/${sha(xml)}.bin`);
    expect(page).toContain('../../symbols/hot.svg');
    // The manifest lists the files as written.
    const listing = JSON.parse(text(files['manifest.json'] as Uint8Array));
    for (const name of svgs) {
      const listed = (listing.files as { path: string; sha256: string }[]).find(
        (f) => f.path === name,
      );
      expect(listed?.sha256).toBe(sha(files[name] as Uint8Array));
    }
    expect(listing.leftOut).toEqual([]);
  });

  it('leaves out an SVG it cannot make inert, and says so in the manifest', async () => {
    const broken = Buffer.from(
      '<!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>',
    );
    const t = setup();
    t.settings.offlinePackages = true;
    await t.blobs.put(Readable.from([broken]), {
      contentType: 'image/svg+xml',
      maxBytes: 10_000,
    });
    const r = t.release('1.0', {
      ...v1,
      modules: [
        {
          ...module('a'),
          blocks: [
            ...module('a').blocks,
            {
              type: 'image',
              id: 'i',
              asset: `sha256:${sha(broken)}`,
              alt: 'X',
            },
          ],
        },
        module('a', 'de'),
      ],
      manifests: [manifest('only-a', ['a'])],
    });
    await t.plan.handle({ releaseId: r.id });
    await t.renderAll();
    const { files } = await packageOf(t, r, 'en', 'public');
    expect(Object.keys(files).some((n) => n.includes(sha(broken)))).toBe(false);
    const listing = JSON.parse(text(files['manifest.json'] as Uint8Array));
    expect(listing.leftOut).toEqual([
      { file: `sha256:${sha(broken)}`, code: 'unsafe-svg' },
    ]);
  });
});
