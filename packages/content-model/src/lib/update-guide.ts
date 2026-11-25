import type { Condition } from './condition.js';
import { VERSION_PATTERN } from './condition-check.js';
import { compareVersions, evaluateCondition } from './condition-eval.js';

// Update guides (#906), without a schema: `@openfolia/content-model/core` has them for a screen
// (the portal's page, the editor's preview), the full entry for the API and the renderers.

/**
 * When a step of an update guide is done, in the order a reader goes through them: `before` the
 * update, `during` it, `after` it.
 */
export const UPDATE_PHASES = ['before', 'during', 'after'] as const;
export type UpdatePhase = (typeof UPDATE_PHASES)[number];

/** Whether `value` is one of `UPDATE_PHASES`. */
export function isUpdatePhase(value: unknown): value is UpdatePhase {
  return (UPDATE_PHASES as readonly unknown[]).includes(value);
}

/**
 * What resolving reads of a step: an update guide manifest's step (`UpdateStep`) or the API's
 * step resource (`GET /manuals/{id}/update-guide/{lang}/steps`) alike.
 *
 * - `version`: the release that needs it (a dotted version); the step applies to a jump from
 *   `from` to `to` when `from < version <= to`.
 * - `phase`: one of `UPDATE_PHASES`.
 * - `level`: the least restricted audience level (configuration's `audiences`) it is for; a reader
 *   at that level or a more restricted one sees it. Absent: every level.
 * - `when`: a condition on the reader's options (enum variant attributes). Absent: every setup.
 */
export interface UpdateStepFacts {
  version?: string | undefined;
  phase: string;
  level?: string | null | undefined;
  when?: Condition | null | undefined;
}

/** What a reader picks: the version they are on, the one they go to, their level and options. */
export interface UpdateChoice {
  from: string;
  to: string;
  /** An audience level's ID. Absent: every level (the most restricted reader's view). */
  level?: string | undefined;
  /** Enum variant attribute ID → value, e.g. `{ "cluster": "yes" }`. Absent: none set. */
  options?: Readonly<Record<string, string>> | undefined;
}

/** A step of a resolved jump, with the version that brought it. */
export interface UpdateGuideStep<S> {
  step: S;
  /** The step's place among the guide's steps (manifest order), from 0. */
  index: number;
  version: string;
}

export type UpdateGuideResult<S> =
  /**
   * The steps the jump crosses, per phase (always all three, in `UPDATE_PHASES` order, possibly
   * empty), each ordered by version, then by manifest order. `reason` is set when the range is
   * empty by construction: `not-forward`, `from` is `to` or after it.
   */
  | {
      status: 'resolved';
      phases: { phase: UpdatePhase; steps: UpdateGuideStep<S>[] }[];
      count: number;
      reason?: 'not-forward';
    }
  /**
   * Refused: `from` or `to` is no version of the guide (`unknown-version`), or the level is no
   * configured level (`unknown-level`); `value` names it.
   */
  | {
      status: 'refused';
      reason: 'unknown-version' | 'unknown-level';
      value: string;
    };

/**
 * Whether a step's version is a dotted version (`VERSION_PATTERN`); a step without one, or with
 * another, is never part of a jump (`update-step-version`, an error).
 */
export function validStepVersion(
  version: string | undefined,
): version is string {
  return version !== undefined && VERSION_PATTERN.test(version);
}

/**
 * The steps a reader updating from `choice.from` to `choice.to` needs, for their level and
 * options (#906): every step whose version `v` has `from < v <= to` (compared with
 * `compareVersions`: `2.10` is after `2.9`, `2.3` is `2.3.0`), whose level is the reader's or a
 * less restricted one (`levels`, the configured audience IDs, least restricted first), and whose
 * condition holds for the options (an attribute not set is false, as anywhere). Grouped by phase,
 * each ordered by version, then by manifest order. `from` and `to` must be versions of the guide
 * (numerically equal to one of `versions`); `from >= to` resolves to no step, with
 * `reason: 'not-forward'`. Steps without a dotted version or with an unknown phase are left out
 * (`validateManifest` reports them).
 */
export function resolveUpdateGuide<S extends UpdateStepFacts>(
  guide: { versions: readonly string[]; steps: readonly S[] },
  choice: UpdateChoice,
  levels: readonly string[],
): UpdateGuideResult<S> {
  for (const value of [choice.from, choice.to]) {
    const known =
      VERSION_PATTERN.test(value) &&
      guide.versions.some(
        (v) => VERSION_PATTERN.test(v) && compareVersions(v, value) === 0,
      );
    if (!known) return { status: 'refused', reason: 'unknown-version', value };
  }
  const rank =
    choice.level === undefined
      ? levels.length - 1
      : levels.indexOf(choice.level);
  if (choice.level !== undefined && rank < 0) {
    return { status: 'refused', reason: 'unknown-level', value: choice.level };
  }
  const phases = UPDATE_PHASES.map((phase) => ({
    phase,
    steps: [] as UpdateGuideStep<S>[],
  }));
  if (compareVersions(choice.from, choice.to) >= 0) {
    return { status: 'resolved', phases, count: 0, reason: 'not-forward' };
  }
  const options = choice.options ?? {};
  let count = 0;
  for (const { step, index, version } of orderedSteps(guide.steps)) {
    if (
      compareVersions(choice.from, version) >= 0 ||
      compareVersions(version, choice.to) > 0
    )
      continue;
    if (step.level != null) {
      const own = levels.indexOf(step.level);
      // A level not configured is for no reader (fails closed, as an audience does).
      if (own < 0 || own > rank) continue;
    }
    if (step.when != null && !evaluateCondition(step.when, options)) continue;
    const group = phases[UPDATE_PHASES.indexOf(step.phase as UpdatePhase)];
    group?.steps.push({ step, index, version });
    count += 1;
  }
  return { status: 'resolved', phases, count };
}

/**
 * A guide's valid steps (a dotted version, a known phase) ordered by version, then by manifest
 * order, each with its place in `steps`. Phases are not ordered here: `resolveUpdateGuide` groups
 * by phase, the PDF by version and then phase (`byVersionAndPhase`).
 */
export function orderedSteps<S extends UpdateStepFacts>(
  steps: readonly S[],
): UpdateGuideStep<S>[] {
  const valid: UpdateGuideStep<S>[] = [];
  steps.forEach((step, index) => {
    if (validStepVersion(step.version) && isUpdatePhase(step.phase))
      valid.push({ step, index, version: step.version });
  });
  // Stable: equal versions keep manifest order.
  return valid.sort((a, b) => compareVersions(a.version, b.version));
}

/**
 * The whole guide, as its PDF prints it: per version (ascending; equal versions such as `2.3` and
 * `2.3.0` are one), per phase (in `UPDATE_PHASES` order, only those with steps), the steps in
 * manifest order. Only valid steps (`orderedSteps`).
 */
export function byVersionAndPhase<S extends UpdateStepFacts>(
  steps: readonly S[],
): {
  version: string;
  phases: { phase: UpdatePhase; steps: UpdateGuideStep<S>[] }[];
}[] {
  const versions: {
    version: string;
    phases: { phase: UpdatePhase; steps: UpdateGuideStep<S>[] }[];
  }[] = [];
  for (const entry of orderedSteps(steps)) {
    let last = versions[versions.length - 1];
    if (!last || compareVersions(last.version, entry.version) !== 0) {
      last = { version: entry.version, phases: [] };
      versions.push(last);
    }
    const phase = entry.step.phase as UpdatePhase;
    let group = last.phases.find((p) => p.phase === phase);
    if (!group) {
      group = { phase, steps: [] };
      last.phases.push(group);
    }
    group.steps.push(entry);
  }
  for (const v of versions)
    v.phases.sort(
      (a, b) => UPDATE_PHASES.indexOf(a.phase) - UPDATE_PHASES.indexOf(b.phase),
    );
  return versions;
}

/**
 * The module entries an update guide's manifest holds (`Manifest.entries`), made from its steps
 * when it is read: one per step, valid ones in the PDF's order (`byVersionAndPhase`), then the
 * others in manifest order; never printed. Without conditions: the guide holds every step, the
 * reader's options pick among them. So everything that reads a manual's entries (the module
 * index, translation status, releases) reads an update guide's modules.
 */
export function updateGuideEntries(
  steps: readonly (UpdateStepFacts & { module: string })[],
): { module: string }[] {
  const placed = byVersionAndPhase(steps).flatMap((v) =>
    v.phases.flatMap((p) => p.steps),
  );
  const seen = new Set(placed.map((s) => s.index));
  return [
    ...placed.map((s) => ({ module: s.step.module })),
    ...steps.flatMap((step, i) =>
      seen.has(i) ? [] : [{ module: step.module }],
    ),
  ];
}
