import {
  DEFAULT_NOTICE_RULE,
  evaluateCondition,
  noticeLevels,
  SAFETY_SEVERITIES,
  safetyTypes,
  type NoticeGrouping,
  type NoticeRule,
  type SafetySeverity,
} from '@openfolia/content-model/core';

import { DERIVED_CHECKS } from '../checks/checks-model';
import type { ProjectConfig } from '../content/browser-model';
import type { DerivedRule, Issue } from './manual-draft';
import type { OutlineRow } from './manual-outline';

/**
 * A derived manual's rule (#451) as the manual builder edits it (#669): pure changes of the rule,
 * which source manuals it may gather from, what it gathers per variant and the issues about it.
 * Whether a module type is a safety type is configuration (`moduleTypes[].safety`), never named
 * here.
 */

/** The issues about the rule, blocking ones first (the API's order otherwise). */
export function ruleIssues(issues: readonly Issue[]): readonly Issue[] {
  const about = issues.filter((i) => DERIVED_CHECKS.has(i.code));
  return [
    ...about.filter((i) => i.severity === 'error'),
    ...about.filter((i) => i.severity !== 'error'),
  ];
}

/** Where the rule puts a module of its own: before or after the gathered ones. */
export type Matter = 'front' | 'back';

/**
 * An audience's place among the levels, as readers are let in (`deriveManifest`): none is the
 * last, most restricted level; one not configured lies past every level.
 */
export function audienceLevel(
  audience: string | undefined,
  config: Pick<ProjectConfig, 'audiences'>,
): number {
  if (audience === undefined) return config.audiences.length - 1;
  const at = config.audiences.findIndex((a) => a.id === audience);
  return at === -1 ? config.audiences.length : at;
}

/** A manual as the source picker knows it. */
export interface SourceCandidate {
  readonly id: string;
  readonly kind?: 'derived' | undefined;
  readonly audience?: string | undefined;
}

/**
 * Whether a derived manual for `audience` may gather from `source`: an assembled manual, not the
 * derived one itself, for the same audience or a wider one (a derived manual is for its source's
 * audience or a narrower one, `derived-audience-wider`). The API refuses the rest all the same.
 */
export function mayGatherFrom(
  source: SourceCandidate,
  manual: { readonly id: string; readonly audience?: string | undefined },
  config: Pick<ProjectConfig, 'audiences'>,
): boolean {
  if (source.id === manual.id || source.kind === 'derived') return false;
  return (
    audienceLevel(manual.audience, config) >=
    audienceLevel(source.audience, config)
  );
}

/**
 * The module types the rule gathers: its own, else the configured safety types. A notice
 * gathering (#676) searches its own, else every type: `searchesEveryType`.
 */
export function gatheredTypeIds(
  rule: DerivedRule,
  config: Pick<ProjectConfig, 'moduleTypes'>,
): readonly string[] {
  return rule.moduleTypes ?? safetyTypes(config);
}

/** What a rule gathers (#670, #676): whole modules, or the safety notices of the source's modules. */
export type Gathering = 'modules' | 'notices';

export function gatheringOf(rule: DerivedRule): Gathering {
  return rule.notices ? 'notices' : 'modules';
}

/**
 * Gathers whole modules (the rule without a `notices` member, as before #670) or notices (the
 * default notice gathering, `DEFAULT_NOTICE_RULE`). The same rule when it gathers so already.
 */
export function setGathering(
  rule: DerivedRule,
  gathering: Gathering,
): DerivedRule {
  if (gatheringOf(rule) === gathering) return rule;
  if (gathering === 'notices') {
    return { ...rule, notices: { ...DEFAULT_NOTICE_RULE } };
  }
  const { notices: _before, ...rest } = rule;
  return rest;
}

/** Groups a notice gathering's notices by source module or by hazard level (nothing otherwise). */
export function setGrouping(
  rule: DerivedRule,
  groupBy: NoticeGrouping,
): DerivedRule {
  if (!rule.notices || rule.notices.groupBy === groupBy) return rule;
  return { ...rule, notices: { ...rule.notices, groupBy } };
}

/**
 * The hazard levels a notice gathering takes, in their groups' order (at least one, each once).
 * Every level, most severe first, is what none means: the rule then names none. Nothing for a
 * rule gathering whole modules, or with no level.
 */
export function setLevels(
  rule: DerivedRule,
  levels: readonly SafetySeverity[],
): DerivedRule {
  const notices = rule.notices;
  const chosen = [...new Set(levels)];
  if (!notices || chosen.length === 0) return rule;
  const { levels: _before, ...rest } = notices;
  const every =
    chosen.length === SAFETY_SEVERITIES.length &&
    chosen.every((level, i) => level === SAFETY_SEVERITIES[i]);
  return { ...rule, notices: every ? rest : { ...rest, levels: chosen } };
}

/** A hazard level as the levels list shows it: whether the rule gathers it. */
export interface LevelRow {
  readonly id: SafetySeverity;
  readonly gathered: boolean;
}

/**
 * Every hazard level, those gathered first in their groups' order (`noticeLevels`), then the
 * others most severe first.
 */
export function levelRows(notices: Pick<NoticeRule, 'levels'>): LevelRow[] {
  const gathered = noticeLevels(notices);
  return [
    ...gathered.map((id) => ({ id, gathered: true })),
    ...SAFETY_SEVERITIES.filter((l) => !gathered.includes(l)).map((id) => ({
      id,
      gathered: false,
    })),
  ];
}

/** The levels gathered of `rows`, in their order. */
export function gatheredLevels(rows: readonly LevelRow[]): SafetySeverity[] {
  return rows.filter((r) => r.gathered).map((r) => r.id);
}

/** A new rule gathering from `source`: the configured safety types, nothing excluded or added. */
export function newRule(
  source: string,
  moduleTypes?: readonly string[],
): DerivedRule {
  return {
    source,
    ...(moduleTypes && moduleTypes.length > 0
      ? { moduleTypes: [...moduleTypes] }
      : {}),
    exclude: [],
    front: [],
    back: [],
  };
}

export function setSource(rule: DerivedRule, source: string): DerivedRule {
  return { ...rule, source };
}

/** The types it gathers; none: the configured safety types. */
export function setTypes(
  rule: DerivedRule,
  types: readonly string[],
): DerivedRule {
  const { moduleTypes: _before, ...rest } = rule;
  return types.length > 0
    ? { ...rest, moduleTypes: [...new Set(types)] }
    : rest;
}

/** Leaves a gathered module out (once). */
export function exclude(rule: DerivedRule, moduleId: string): DerivedRule {
  return rule.exclude.includes(moduleId)
    ? rule
    : { ...rule, exclude: [...rule.exclude, moduleId] };
}

/** Gathers an excluded module again. */
export function include(rule: DerivedRule, moduleId: string): DerivedRule {
  return { ...rule, exclude: rule.exclude.filter((id) => id !== moduleId) };
}

/** Adds a module of its own before or after the gathered ones (once, in one place). */
export function addMatter(
  rule: DerivedRule,
  where: Matter,
  moduleId: string,
): DerivedRule {
  if (rule.front.includes(moduleId) || rule.back.includes(moduleId)) {
    return rule;
  }
  return { ...rule, [where]: [...rule[where], moduleId] };
}

export function removeMatter(
  rule: DerivedRule,
  where: Matter,
  moduleId: string,
): DerivedRule {
  return { ...rule, [where]: rule[where].filter((id) => id !== moduleId) };
}

/** Where a module of the outline comes from: the rule's front or back matter, or gathered. */
export function originOf(
  rule: DerivedRule,
  moduleId: string,
): Matter | 'gathered' {
  if (rule.front.includes(moduleId)) return 'front';
  if (rule.back.includes(moduleId)) return 'back';
  return 'gathered';
}

/**
 * Whether a row of the gathered outline is in a variant: its condition holds for the variant's
 * values (a row without one is in every variant), as the PDF of that variant has it.
 */
export function inVariant(
  row: Pick<OutlineRow, 'when'>,
  values: Readonly<Record<string, string>> | undefined,
  config: Pick<ProjectConfig, 'variantAttributes'> | null,
): boolean {
  if (!row.when || !values) return true;
  const versionAttributes = new Set(
    (config?.variantAttributes ?? [])
      .filter((a) => a.kind === 'version')
      .map((a) => a.id),
  );
  return evaluateCondition(row.when, values, { versionAttributes });
}
