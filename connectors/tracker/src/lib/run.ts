import { zipBundle } from '@openfolia/connector-wiki-markup';
import type { ImportApi, ImportReport } from './client.js';
import { convertItems } from './convert.js';
import type { TrackerMapping } from './mapping.js';
import type { ItemSource } from './source.js';

/** How one run ended. */
export type RunResult =
  /** Everything is in the target as it is in the source: nothing uploaded, no change set. */
  | { readonly outcome: 'nothing-new'; readonly counts: ImportReport['counts'] }
  /**
   * What it would write is held by an open change set (an earlier run's in
   * review, or someone's draft): nothing written; a run after that change
   * set is merged or abandoned picks it up.
   */
  | {
      readonly outcome: 'held';
      readonly counts: ImportReport['counts'];
      readonly held: readonly {
        readonly subject: string;
        readonly changeSetId: string;
      }[];
    }
  /** The bundle cannot be imported as it is (the reasons, at most 20): nothing written. */
  | {
      readonly outcome: 'refused';
      readonly counts: ImportReport['counts'];
      readonly reasons: readonly string[];
    }
  /** Imported into a change set, submitted for review unless the mapping says otherwise. */
  | {
      readonly outcome: 'imported';
      readonly importId: string;
      readonly changeSetId: string;
      readonly changeSetState: string;
      readonly counts: ImportReport['counts'];
    }
  /** The import's job failed: what it wrote so far is in its change set, if it made one. */
  | {
      readonly outcome: 'failed';
      readonly importId: string;
      readonly changeSetId?: string;
      readonly failure: { readonly code: string; readonly detail: string };
    };

export interface RunOptions {
  readonly source: ItemSource;
  readonly mapping: TrackerMapping;
  readonly api: ImportApi;
  /** Waits between two looks at the import's progress; default a timer. */
  readonly wait?: (ms: number) => Promise<void>;
  /** Between two looks (default 2 s). */
  readonly pollMs?: number;
  /** How long the import's job may take before the run gives up waiting (default 15 min). */
  readonly maxWaitMs?: number;
  readonly now?: () => number;
}

const MAX_REASONS = 20;
/** Lock lookups at once. */
const LOOKUPS = 8;

/** The subjects the import would write that an open change set holds. */
async function heldSubjects(
  api: ImportApi,
  report: ImportReport,
): Promise<{ subject: string; changeSetId: string }[]> {
  const subjects = report.items.flatMap((item) => {
    if (item.action !== 'create' && item.action !== 'update') return [];
    if (item.kind === 'module' && item.lang) {
      return [`module/${item.lang}/${item.id}`];
    }
    return item.kind === 'manual' ? [`manual/${item.id}`] : [];
  });
  const held: { subject: string; changeSetId: string }[] = [];
  for (let i = 0; i < subjects.length; i += LOOKUPS) {
    const batch = subjects.slice(i, i + LOOKUPS);
    const found = await Promise.all(batch.map((s) => api.lockedBy(s)));
    found.forEach((changeSetId, j) => {
      if (changeSetId) held.push({ subject: batch[j] as string, changeSetId });
    });
  }
  return held;
}

/**
 * One run: reads the items, converts them into a bundle of the import
 * format, has the API check it (a dry run, nothing stored), and only when
 * there is something to write and nothing refused, uploads it, applies it
 * into a new change set and submits that for review. The change set is
 * reviewed and merged like any other: nothing is published by the
 * connector. Existing modules are updated (`updateExisting`); ones the
 * target holds unchanged are skipped, so a run over the same items writes
 * nothing.
 */
export async function runOnce(options: RunOptions): Promise<RunResult> {
  const { source, mapping, api } = options;
  const wait = options.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const conversion = convertItems(await source.items(), mapping);
  const bundle = zipBundle(conversion);
  const fileName = `${mapping.system.replace(/[^\w.-]+/g, '-').toLowerCase()}.zip`;
  const checked = await api.check(bundle, fileName);
  if (
    checked.counts.create + checked.counts.update === 0 &&
    checked.counts.refuse === 0 &&
    checked.valid
  ) {
    return { outcome: 'nothing-new', counts: checked.counts };
  }
  if (!checked.applicable) return refused(checked);
  // An import writing what another change set holds fails part way with
  // `locked`, leaving a change set behind: look first.
  const held = await heldSubjects(api, checked);
  if (held.length > 0) {
    return { outcome: 'held', counts: checked.counts, held };
  }
  const created = await api.create(bundle, fileName);
  // The target may have changed since the check.
  if (!created.report.applicable) return refused(created.report);
  let state = await api.apply(created.id);
  const deadline = now() + (options.maxWaitMs ?? 15 * 60_000);
  while (state.state === 'applying' || state.state === 'validated') {
    if (now() > deadline) {
      throw new Error(
        `Import ${created.id} is still being applied; look at it later (GET /imports/${created.id}).`,
      );
    }
    await wait(options.pollMs ?? 2_000);
    state = await api.get(created.id);
  }
  if (state.state !== 'applied' || !state.changeSetId) {
    return {
      outcome: 'failed',
      importId: created.id,
      ...(state.changeSetId && { changeSetId: state.changeSetId }),
      failure: state.failure ?? {
        code: 'unexpected-state',
        detail: `The import ended ${state.state}.`,
      },
    };
  }
  const changeSetState = mapping.changeSet.submit
    ? await api.submit(state.changeSetId, mapping.changeSet.comment)
    : 'draft';
  return {
    outcome: 'imported',
    importId: created.id,
    changeSetId: state.changeSetId,
    changeSetState,
    counts: created.report.counts,
  };
}

function refused(report: ImportReport): RunResult {
  const reasons = [
    ...report.issues
      .filter((issue) => issue.severity === 'error')
      .map((issue) => `${issue.code}: ${issue.message}`),
    ...report.items
      .filter((item) => item.action === 'refuse')
      .flatMap((item) =>
        item.reasons.map(
          (r) => `${item.kind} ${item.id}: ${r.code}: ${r.message}`,
        ),
      ),
  ];
  return {
    outcome: 'refused',
    counts: report.counts,
    reasons: (reasons.length > 0
      ? reasons
      : [
          'The import is not applicable (too large for one change set, or nothing to write).',
        ]
    ).slice(0, MAX_REASONS),
  };
}
