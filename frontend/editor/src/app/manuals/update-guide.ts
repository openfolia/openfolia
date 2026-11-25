import {
  byVersionAndPhase,
  compareVersions,
  isUpdatePhase,
  resolveUpdateGuide,
  UPDATE_PHASES,
  VERSION_PATTERN,
  type UpdateChoice,
  type UpdateGuideResult,
  type UpdatePhase,
} from '@openfolia/content-model/core';

import type { Schema } from '../api';

// An update guide's steps as the manual builder edits them (#908): every change is the whole new
// guide, as the manifest holds it (`guide`, #906); the API checks it on each save.

/** An update guide's own part: the version attribute, the versions and the steps (#906). */
export type UpdateGuide = NonNullable<Schema<'DraftManifest'>['guide']>;
export type UpdateStep = UpdateGuide['steps'][number];

/** A step with its place in the guide's steps (manifest order), from 0. */
export interface PlacedStep {
  readonly step: UpdateStep;
  readonly index: number;
}

/** The steps of one phase of one version, in manifest order. */
export interface PhaseGroup {
  readonly phase: UpdatePhase;
  readonly steps: readonly PlacedStep[];
}

/** A version of the guide with the steps it brings, per phase (only phases that have steps). */
export interface VersionGroup {
  readonly version: string;
  readonly phases: readonly PhaseGroup[];
  readonly count: number;
}

/**
 * The guide's steps as the builder lists them: by version, then by phase (the PDF's order,
 * `byVersionAndPhase`), and first the steps no version or phase places yet (`unplaced`: no dotted
 * version, or an unknown phase), in manifest order.
 */
export function stepGroups(steps: readonly UpdateStep[]): {
  readonly unplaced: readonly PlacedStep[];
  readonly versions: readonly VersionGroup[];
} {
  const versions = byVersionAndPhase(steps).map((v) => ({
    version: v.version,
    phases: v.phases.map((p) => ({
      phase: p.phase,
      steps: p.steps.map((s) => ({ step: s.step, index: s.index })),
    })),
    count: v.phases.reduce((n, p) => n + p.steps.length, 0),
  }));
  const placed = new Set(
    versions.flatMap((v) =>
      v.phases.flatMap((p) => p.steps.map((s) => s.index)),
    ),
  );
  const unplaced = steps.flatMap((step, index) =>
    placed.has(index) ? [] : [{ step, index }],
  );
  return { unplaced, versions };
}

/** `versions` with `version` in its place (oldest first), unless one equal to it is there. */
export function withVersion(
  versions: readonly string[],
  version: string,
): string[] {
  if (versions.some((v) => compareVersions(v, version) === 0)) {
    return [...versions];
  }
  const at = versions.findIndex((v) => compareVersions(v, version) > 0);
  return at < 0
    ? [...versions, version]
    : [...versions.slice(0, at), version, ...versions.slice(at)];
}

/** The guide's version equal to `version` (`2.3` for `2.3.0`), else `version` itself. */
export function knownVersion(guide: UpdateGuide, version: string): string {
  return (
    guide.versions.find((v) => compareVersions(v, version) === 0) ?? version
  );
}

/**
 * The guide with `step` in place of the one at `index` (null: added last), its version added to
 * the guide's versions when it is a new one.
 */
export function putStep(
  guide: UpdateGuide,
  index: number | null,
  step: UpdateStep,
): UpdateGuide {
  const steps =
    index === null || index >= guide.steps.length
      ? [...guide.steps, step]
      : guide.steps.map((s, i) => (i === index ? step : s));
  const versions =
    step.version !== undefined && VERSION_PATTERN.test(step.version)
      ? withVersion(guide.versions, step.version)
      : [...guide.versions];
  return { ...guide, versions, steps };
}

/** The guide without the step at `index`. */
export function removeStep(guide: UpdateGuide, index: number): UpdateGuide {
  return { ...guide, steps: guide.steps.filter((_, i) => i !== index) };
}

/** The guide with `step` back at `index` (a removal's undo). */
export function restoreStep(
  guide: UpdateGuide,
  index: number,
  step: UpdateStep,
): UpdateGuide {
  const at = Math.min(Math.max(index, 0), guide.steps.length);
  return {
    ...guide,
    steps: [...guide.steps.slice(0, at), step, ...guide.steps.slice(at)],
  };
}

/**
 * The guide with one group's steps in a new order: `order` holds the group's step indices as they
 * should now come; they take the places the group's steps held, every other step stays.
 */
export function reorderSteps(
  guide: UpdateGuide,
  order: readonly number[],
): UpdateGuide {
  const places = [...order].sort((a, b) => a - b);
  const steps = [...guide.steps];
  places.forEach((place, i) => {
    const from = guide.steps[order[i] as number];
    if (from) steps[place] = from;
  });
  return { ...guide, steps };
}

/**
 * Whether `version` may be taken out of the guide's versions: no step needs it, and two versions
 * stay (a reader picks a from and a to).
 */
export function versionRemovable(guide: UpdateGuide, version: string): boolean {
  if (guide.versions.length <= 2) return false;
  // Without the first version, the second is first: a step of it would then be in no update.
  const first =
    compareVersions(guide.versions[0] ?? version, version) === 0
      ? guide.versions[1]
      : undefined;
  return !guide.steps.some(
    (s) =>
      s.version !== undefined &&
      VERSION_PATTERN.test(s.version) &&
      (compareVersions(s.version, version) === 0 ||
        (first !== undefined && compareVersions(s.version, first) <= 0)),
  );
}

/** The guide without `version` among its versions. */
export function removeVersion(
  guide: UpdateGuide,
  version: string,
): UpdateGuide {
  return {
    ...guide,
    versions: guide.versions.filter((v) => v !== version),
  };
}

/** The issues of the step at `index` (the checks name it `guide.steps.<index>`). */
export function stepIssues<I extends { readonly at?: string | undefined }>(
  issues: readonly I[],
  index: number,
): I[] {
  const at = `guide.steps.${index}`;
  return issues.filter((issue) => issue.at === at);
}

/**
 * The versions a step can be for: every version but the first (a step applies when
 * `from < version`, so one for the first version is never shown).
 */
export function stepVersions(guide: UpdateGuide): string[] {
  return guide.versions.slice(1);
}

/** What the step form holds: `version` as picked or typed, `phase` empty until picked. */
export interface StepForm {
  readonly module: string;
  readonly version: string;
  readonly phase: string;
  /** An audience level's ID; empty: every level. */
  readonly level: string;
  readonly when: UpdateStep['when'] | null;
}

/** Why the step form cannot be saved, per field (translation keys); empty: it can. */
export interface StepFormProblems {
  readonly module?: string;
  readonly version?: string;
  readonly phase?: string;
}

/**
 * The step form's problems: a module is chosen; the version is a dotted version (`2.3`) after the
 * guide's first one (no update would show it otherwise); the phase is one of `UPDATE_PHASES`.
 */
export function stepFormProblems(
  form: StepForm,
  guide: UpdateGuide,
): StepFormProblems {
  const version = form.version.trim();
  const first = guide.versions[0];
  return {
    ...(form.module
      ? {}
      : { module: 'editor.manuals.guide.form.moduleMissing' }),
    ...(version === ''
      ? { version: 'editor.manuals.guide.form.versionMissing' }
      : !VERSION_PATTERN.test(version)
        ? { version: 'editor.manuals.guide.form.versionInvalid' }
        : first !== undefined && compareVersions(version, first) <= 0
          ? { version: 'editor.manuals.guide.form.versionTooEarly' }
          : {}),
    ...(isUpdatePhase(form.phase)
      ? {}
      : { phase: 'editor.manuals.guide.form.phaseMissing' }),
  };
}

/** The step the form describes (call only once `stepFormProblems` finds none). */
export function stepOf(form: StepForm, guide: UpdateGuide): UpdateStep {
  return {
    module: form.module,
    version: knownVersion(guide, form.version.trim()),
    phase: form.phase,
    ...(form.level ? { level: form.level } : {}),
    ...(form.when ? { when: form.when } : {}),
  };
}

/** The form for an existing step (or a new one for `module`). */
export function formOf(
  step: Partial<UpdateStep> & { module: string },
): StepForm {
  return {
    module: step.module,
    version: step.version ?? '',
    phase: step.phase ?? '',
    level: step.level ?? '',
    when: step.when ?? null,
  };
}

/**
 * The versions a reader goes from and to, as the preview offers them, and the reader's choice
 * first shown: the whole guide, from its first version to its last.
 */
export function defaultChoice(guide: UpdateGuide): UpdateChoice {
  return {
    from: guide.versions[0] ?? '',
    to: guide.versions[guide.versions.length - 1] ?? '',
  };
}

/**
 * The preview (#908): the steps a reader gets for `choice`, resolved exactly as the portal does
 * (`resolveUpdateGuide`, with the configured audience levels in order).
 */
export function previewOf(
  guide: UpdateGuide,
  choice: UpdateChoice,
  levels: readonly string[],
): UpdateGuideResult<UpdateStep> {
  return resolveUpdateGuide(guide, choice, levels);
}

/** The enum attributes the guide's conditions name: the options a reader picks (as the API's). */
export function optionIds(steps: readonly UpdateStep[]): Set<string> {
  const ids = new Set<string>();
  const collect = (condition: NonNullable<UpdateStep['when']>): void => {
    if (condition.op === 'all' || condition.op === 'any')
      condition.of.forEach(collect);
    else if (condition.op === 'not') collect(condition.of);
    else ids.add(condition.attr);
  };
  for (const step of steps) if (step.when) collect(step.when);
  return ids;
}

/** The phases in a reader's order, for the form's choice. */
export const PHASES = UPDATE_PHASES;

/**
 * The versions a new guide offers, as typed (separated by commas or spaces): each a dotted
 * version, put oldest first, each once (`2.3` and `2.3.0` are one), at least two. Else the
 * problem (a translation key) and, for an invalid one, the value.
 */
export function parseVersions(
  text: string,
):
  | { readonly versions: string[] }
  | { readonly problem: string; readonly value?: string } {
  const typed = text.split(/[\s,;]+/).filter((v) => v !== '');
  const invalid = typed.find((v) => !VERSION_PATTERN.test(v));
  if (invalid !== undefined) {
    return { problem: 'editor.manuals.new.versionsInvalid', value: invalid };
  }
  const versions = [...typed]
    .sort(compareVersions)
    .filter(
      (v, i, all) => i === 0 || compareVersions(all[i - 1] as string, v) < 0,
    );
  return versions.length < 2
    ? { problem: 'editor.manuals.new.versionsTooFew' }
    : { versions };
}
