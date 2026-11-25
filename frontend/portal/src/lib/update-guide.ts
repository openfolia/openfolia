import {
  compareVersions,
  type Condition,
  type UpdateChoice,
  VERSION_PATTERN,
} from '@openfolia/content-model/core';

/**
 * An update guide's choice (#907) in the page's address and back, shared by the page (its
 * defaults) and its script (`scripts/update-guide.ts`). Schema-free, so the script's bundle
 * holds no schema library.
 */

/** What the choice is made from: the guide's versions (oldest first), levels and options. */
export interface GuideShape {
  readonly versions: readonly string[];
  /** Level IDs, least restricted first. */
  readonly levels: readonly string[];
  /** Each option's ID and its values' IDs. */
  readonly options: readonly {
    readonly id: string;
    readonly values: readonly string[];
  }[];
}

/** What the pickers show: the range, the level, and each option set (an option not set is absent). */
export interface FullChoice extends UpdateChoice {
  readonly level: string | undefined;
  readonly options: Readonly<Record<string, string>>;
}

/** A guide's shape from the snapshot's guide, whose levels and values carry labels. */
export const guideShape = (guide: {
  versions: readonly string[];
  levels: readonly { id: string }[];
  options: readonly { id: string; values: readonly { id: string }[] }[];
}): GuideShape => ({
  versions: guide.versions,
  levels: guide.levels.map((l) => l.id),
  options: guide.options.map((o) => ({
    id: o.id,
    values: o.values.map((v) => v.id),
  })),
});

/**
 * The choice a guide opens with: from its second-newest version to its newest, at the first
 * (least restricted) level, no option set (a step's condition on an option not set is false, so
 * only the steps for every setup show).
 */
export function guideDefaults(g: GuideShape): FullChoice {
  return {
    from: g.versions[g.versions.length - 2] ?? '',
    to: g.versions[g.versions.length - 1] ?? '',
    level: g.levels[0],
    options: {},
  };
}

const sameVersion = (a: string, b: string) =>
  VERSION_PATTERN.test(a) &&
  VERSION_PATTERN.test(b) &&
  compareVersions(a, b) === 0;

/**
 * The choice an address asks for (`?from=2.0&to=4.0&level=internal&opt=cluster:yes`). Each
 * part that is not one the guide offers falls back to its default (a range as a whole: `from` a
 * version before `to`; a `to` alone before the default `from` starts at the version before it),
 * and `invalid` says one did.
 */
export function parseChoice(
  guide: GuideShape,
  params: URLSearchParams,
): { choice: FullChoice; invalid: boolean } {
  const defaults = guideDefaults(guide);
  let invalid = false;
  const known = (v: string | null) =>
    v === null ? undefined : guide.versions.find((x) => sameVersion(x, v));
  let from = defaults.from;
  let to = defaults.to;
  const rawFrom = params.get('from');
  const rawTo = params.get('to');
  if (rawFrom !== null || rawTo !== null) {
    const t = rawTo === null ? defaults.to : known(rawTo);
    const before =
      t === undefined
        ? undefined
        : guide.versions[guide.versions.indexOf(t) - 1];
    const f =
      rawFrom !== null
        ? known(rawFrom)
        : t !== undefined && compareVersions(defaults.from, t) >= 0
          ? before
          : defaults.from;
    if (f !== undefined && t !== undefined && compareVersions(f, t) < 0) {
      from = f;
      to = t;
    } else invalid = true;
  }
  let level = defaults.level;
  const rawLevel = params.get('level');
  if (rawLevel !== null) {
    if (guide.levels.includes(rawLevel)) level = rawLevel;
    else invalid = true;
  }
  const options: Record<string, string> = {};
  for (const raw of params.getAll('opt')) {
    const [id = '', value] = raw.split(':', 2);
    const option = guide.options.find((o) => o.id === id);
    if (option && value !== undefined && option.values.includes(value))
      options[id] = value;
    else invalid = true;
  }
  return { choice: { from, to, level, options }, invalid };
}

/** The address's query for a choice: only what differs from the defaults. */
export function choiceQuery(guide: GuideShape, choice: FullChoice): string {
  const defaults = guideDefaults(guide);
  const params = new URLSearchParams();
  if (choice.from !== defaults.from || choice.to !== defaults.to) {
    params.set('from', choice.from);
    params.set('to', choice.to);
  }
  if (choice.level !== undefined && choice.level !== defaults.level)
    params.set('level', choice.level);
  for (const option of guide.options) {
    const value = choice.options[option.id];
    if (value !== undefined) params.append('opt', `${option.id}:${value}`);
  }
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

/**
 * The choice that shows one step (a search result leads to it, #907): the jump to its version
 * from the version before it, its level, and the options its condition names when it is a
 * plain list of values (`cluster in (yes)`); other options stay as `base` has them.
 */
export function choiceForStep(
  guide: GuideShape,
  base: FullChoice,
  step: {
    version: string;
    level: string | undefined;
    when: Condition | undefined;
  },
): FullChoice {
  const to = guide.versions.find((v) => sameVersion(v, step.version));
  const at = to === undefined ? -1 : guide.versions.indexOf(to);
  const options = { ...base.options };
  const pick = (c: Condition) => {
    if (c.op === 'in') {
      const option = guide.options.find((o) => o.id === c.attr);
      const value = c.values.find((v) => option?.values.includes(v));
      if (option && value !== undefined) options[c.attr] = value;
    } else if (c.op === 'all') c.of.forEach(pick);
  };
  if (step.when) pick(step.when);
  return {
    from: at > 0 ? guide.versions[at - 1]! : base.from,
    to: at > 0 ? to! : base.to,
    level:
      step.level !== undefined && guide.levels.includes(step.level)
        ? step.level
        : base.level,
    options,
  };
}
