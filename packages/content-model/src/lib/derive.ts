import type { Block, SafetySeverity } from './blocks.js';
import type { Condition } from './condition.js';
import type { ProjectConfig } from './config.js';
import type { Manifest, ManifestEntry, NoticeRule } from './manifest.js';
import type { Module } from './module.js';
import { SAFETY_SEVERITIES } from './safety.js';
import type { Issue } from './validate.js';

/**
 * Derived manuals (#451): a manual whose entries are gathered from another manual by a rule
 * (`kind: derived`, `DerivedRule`), such as a safety leaflet made of the safety modules of an
 * operating manual. Nothing here names a module type: which types count as safety is
 * configuration (`moduleTypes[].safety`). Schema-free, so `@openfolia/content-model/core` has it.
 */

/** Whether a manifest is a derived manual's: `kind: derived`. */
export function isDerived(manifest: Pick<Manifest, 'kind'>): boolean {
  return manifest.kind === 'derived';
}

/** The IDs of the module types the configuration marks `safety: true`, in their configured order. */
export function safetyTypes(
  config: Pick<ProjectConfig, 'moduleTypes'>,
): string[] {
  return config.moduleTypes.filter((t) => t.safety).map((t) => t.id);
}

/** The module types a derived manual's rule gathers: its own, else the configured safety types. */
export function gatheredTypes(
  rule: Pick<NonNullable<Manifest['rule']>, 'moduleTypes'>,
  config: Pick<ProjectConfig, 'moduleTypes'>,
): string[] {
  return rule.moduleTypes ? [...rule.moduleTypes] : safetyTypes(config);
}

/** How a derived manual's gathered notices are grouped (#670, `NoticeRule.groupBy`). */
export const NOTICE_GROUPINGS = ['module', 'level'] as const;
export type NoticeGrouping = (typeof NOTICE_GROUPINGS)[number];

/** The grouping of a notice gathering that names none: by source module. */
export const DEFAULT_NOTICE_GROUPING: NoticeGrouping = 'module';

/** A notice gathering with nothing set (#670): grouped by source module, every level. */
export const DEFAULT_NOTICE_RULE: Readonly<NoticeRule> = {
  groupBy: DEFAULT_NOTICE_GROUPING,
};

/** A derived manual's notice gathering (#670, `rule.notices`); none for whole modules or an assembled manual. */
export function noticeRuleOf(
  manifest: Pick<Manifest, 'kind' | 'rule'>,
): NoticeRule | undefined {
  return manifest.kind === 'derived' ? manifest.rule?.notices : undefined;
}

/** The hazard levels a notice gathering takes, in its groups' order: its own, else all, most severe first. */
export function noticeLevels(
  rule: Pick<NoticeRule, 'levels'>,
): SafetySeverity[] {
  return rule.levels ? [...rule.levels] : [...SAFETY_SEVERITIES];
}

/**
 * The modules blocks refer to (`moduleRef`), anywhere in them (variant blocks whatever their
 * condition), each once, in order.
 */
export function referencedModuleIds(blocks: readonly Block[]): string[] {
  const ids = new Set<string>();
  const visit = (list: readonly Block[]) => {
    for (const block of list) {
      if (block.type === 'moduleRef') ids.add(block.module);
      for (const child of childBlocks(block)) visit(child);
    }
  };
  visit(blocks);
  return [...ids];
}

/**
 * The hazard levels of the safety messages blocks hold themselves: each outermost `safety` block
 * (one inside another goes with it), anywhere else in them (variant blocks whatever their
 * condition), module references not followed.
 */
export function noticeLevelsIn(blocks: readonly Block[]): Set<SafetySeverity> {
  const found = new Set<SafetySeverity>();
  const visit = (list: readonly Block[]) => {
    for (const block of list) {
      if (block.type === 'safety') found.add(block.severity);
      else for (const child of childBlocks(block)) visit(child);
    }
  };
  visit(blocks);
  return found;
}

/**
 * Reads the modules a derived manual's gathering needs (`DeriveInput.module`), in the source
 * language: `ids` (`sourceModuleIds`, with the front and back matter), and with
 * `followReferences` (a notice gathering) the modules they refer to, and those theirs, each
 * once. `read` gives `undefined` for a module that does not exist or cannot be read (not
 * gathered; its own checks say so); `atOnce` modules are read at a time.
 */
export async function readGatheringModules(
  ids: readonly string[],
  read: (id: string) => Promise<Module | undefined>,
  options: { followReferences: boolean; atOnce: number },
): Promise<Map<string, Module>> {
  const found = new Map<string, Module>();
  const seen = new Set<string>(ids);
  let wave = [...seen];
  while (wave.length > 0) {
    const next: string[] = [];
    for (let i = 0; i < wave.length; i += options.atOnce) {
      await Promise.all(
        wave.slice(i, i + options.atOnce).map(async (id) => {
          const module = await read(id);
          if (!module) return;
          found.set(id, module);
          if (!options.followReferences) return;
          for (const ref of referencedModuleIds(module.blocks)) {
            if (seen.has(ref)) continue;
            seen.add(ref);
            next.push(ref);
          }
        }),
      );
    }
    wave = next;
  }
  return found;
}

export interface DeriveInput {
  /** The derived manual's manifest, as stored (its entries, if any, are not read). */
  manifest: Manifest;
  /**
   * Its source manual's manifest, as stored: `undefined` when there is none, `'unreadable'`
   * when its file cannot be read.
   */
  source: Manifest | 'unreadable' | undefined;
  config: Pick<ProjectConfig, 'moduleTypes' | 'audiences'>;
  /**
   * A module's type (its source-language file's `meta.type`); `undefined` when there is no such
   * module or its file cannot be read (its own checks say so): it is not gathered.
   */
  moduleType: (id: string) => string | undefined;
  /**
   * For a notice gathering (#670, `rule.notices`): a module's source-language file
   * (`readGatheringModules`), for the source's modules, the front and back matter and the
   * modules they refer to; `undefined` when there is none or it cannot be read. Without it a
   * notice gathering finds no notices.
   */
  module?: (id: string) => Module | undefined;
}

/** A module the rule gathered, with where it came from. */
export interface GatheredModule {
  module: string;
  /** Its type, as `moduleType` gave it. */
  type: string;
  /** The condition it is included under in the source (its groups' and its own); none: always. */
  when?: Condition;
}

export interface DeriveResult {
  /**
   * The manifest with its entries gathered: the front matter, the gathered modules in the
   * source manual's order (each once, with the source's conditions), then the back matter.
   * Everything else is its own, so it prints back to its file. An assembled manifest is given
   * back as it is.
   */
  manifest: Manifest;
  /**
   * The text attributes to resolve it with: the source's, its own over them (its own alone
   * when the source cannot be read). Resolve `{ ...manifest, attributes }`.
   */
  attributes: Manifest['attributes'];
  /** The modules gathered from the source, in order (front and back matter not among them). */
  gathered: GatheredModule[];
  /** What deriving found (`unknown-source-manual`, `safety-module-excluded`, …). */
  issues: Issue[];
}

/**
 * Gathers a derived manual's entries from its source manual by its rule, so resolution, checks,
 * translation status and the outputs read it as any manual. Every module entry of the source
 * (in groups too) whose type is one of `gatheredTypes` is gathered, unless the rule excludes it
 * or names it as front or back matter: in the source's order, once (the first place it is
 * included), under the condition it is included with there (a module included in several
 * places under different conditions is included when any holds; once without one, always).
 * Groups are not kept: a derived manual is flat. Module references inside a module are not
 * followed: a module a gathered one refers to is resolved inside it, as anywhere.
 *
 * Issues: `unknown-source-manual` (an error: no source, or one that cannot be read; only the
 * front and back matter are left), `derived-source` (an error: the source is a derived manual
 * itself, or this one; nothing is gathered), `no-gathered-types` (an error: no rule types and
 * none configured as safety), `safety-module-excluded` (a warning, `at` the module: a module of
 * a configured safety type in the source that the rule leaves out), `unknown-excluded-module` (a
 * warning: an excluded module the source does not include), `empty-derived-manual` (a
 * warning: nothing was gathered) and `derived-audience-wider` (an error: the manual is for a
 * wider audience than its source; nothing is gathered, nor the source's text attributes).
 *
 * A notice gathering (#670, `rule.notices`) gathers, the same way, each source module (of the
 * rule's `moduleTypes`, else of any type) that holds a safety notice of a gathered level, in
 * its own blocks or a module's it refers to (`input.module`); `resolveManual` then gives such a
 * module's notices only. In place of `safety-module-excluded` it reports
 * `safety-notice-excluded` (`noticesLeftOut`), and `no-gathered-types` does not apply.
 */
export function deriveManifest(input: DeriveInput): DeriveResult {
  const { manifest, source, config, moduleType } = input;
  const rule = manifest.rule;
  if (manifest.kind !== 'derived' || !rule) {
    return {
      manifest,
      attributes: manifest.attributes,
      gathered: [],
      issues: [],
    };
  }
  const issues: Issue[] = [];
  const own = new Set([...rule.front, ...rule.back]);
  const matter = (ids: readonly string[]) => ids.map((id) => ({ module: id }));
  const done = (
    gathered: GatheredModule[],
    attributes: Manifest['attributes'] = manifest.attributes,
  ): DeriveResult => {
    const placed = new Set<string>();
    const once = (entries: ManifestEntry[]) =>
      entries.filter((e) => {
        const id = (e as { module: string }).module;
        if (placed.has(id)) return false;
        placed.add(id);
        return true;
      });
    return {
      attributes,
      manifest: {
        ...manifest,
        entries: once([
          ...matter(rule.front),
          ...gathered.map((g) => ({
            module: g.module,
            ...(g.when && { when: g.when }),
          })),
          ...matter(rule.back),
        ]),
      },
      gathered,
      issues,
    };
  };

  if (source === undefined || source === 'unreadable') {
    issues.push({
      severity: 'error',
      code: 'unknown-source-manual',
      // One wording for a source that does not exist, cannot be read or is hidden from the
      // reader (the API passes a hidden one as missing): none tells them apart.
      message: `the source manual "${rule.source}" is missing or cannot be read; only the front and back matter are included`,
    });
    return done([]);
  }
  // An update guide's entries are its steps (#906): no assembled manual to gather from either.
  if (source.kind !== undefined || source.id === manifest.id) {
    issues.push({
      severity: 'error',
      code: 'derived-source',
      message:
        source.id === manifest.id
          ? 'the manual is derived from itself; nothing is gathered'
          : `the source manual "${rule.source}" is ${source.kind === 'derived' ? 'a derived manual itself' : 'an update guide'}; a derived manual is made from an assembled one, so nothing is gathered`,
    });
    return done([]);
  }
  const attributes = { ...source.attributes, ...manifest.attributes };
  // As readers are let in (`allowsManual` in the API): a manual without an audience is for the
  // last, most restricted level; one the configuration does not hold, past every level.
  const level = (audience: string | undefined) => {
    if (audience === undefined) return config.audiences.length - 1;
    const at = config.audiences.findIndex((a) => a.id === audience);
    return at === -1 ? config.audiences.length : at;
  };
  // Gathered for a wider audience, the source's text would reach readers it is not for (its
  // attributes, which modules it holds): nothing is gathered, for any reader or output.
  if (level(manifest.audience) < level(source.audience)) {
    issues.push({
      severity: 'error',
      code: 'derived-audience-wider',
      message: `the manual is for a wider audience than its source manual "${rule.source}"; a derived manual is for its source's audience or a narrower one, so nothing is gathered`,
    });
    return done([]);
  }
  const notices = rule.notices;
  // A notice gathering searches the modules of the rule's types, else of every type.
  const types = notices
    ? rule.moduleTypes && new Set(rule.moduleTypes)
    : new Set(gatheredTypes(rule, config));
  if (types?.size === 0) {
    issues.push({
      severity: 'error',
      code: 'no-gathered-types',
      message:
        'the rule names no module types and the configuration marks none as safety (`moduleTypes[].safety`); nothing is gathered',
    });
    return done([], attributes);
  }
  const reach = notices && noticeReach(input.module);
  const levels = new Set(notices ? noticeLevels(notices) : []);
  /** Whether a module, or one it refers to, holds a notice of a gathered level. */
  const holdsNotice = (id: string) =>
    reach !== undefined &&
    [...reach.from(id)].some((m) =>
      [...reach.levels(m)].some((l) => levels.has(l)),
    );

  const safety = new Set(safetyTypes(config));
  const excluded = new Set(rule.exclude);
  const gathered = new Map<string, GatheredModule>();
  const leftOut = new Set<string>();
  const named = new Set<string>();
  /** A notice gathering's source modules it searches, and those it leaves out. */
  const searched = new Set<string>();
  const passed = new Set<string>();
  const visit = (
    entries: readonly ManifestEntry[],
    around: Condition | undefined,
  ) => {
    for (const entry of entries) {
      const when = both(around, entry.when);
      if ('entries' in entry) {
        visit(entry.entries, when);
        continue;
      }
      const id = entry.module;
      named.add(id);
      if (own.has(id)) continue;
      const type = moduleType(id);
      if (type === undefined) continue;
      const left =
        excluded.has(id) || (types !== undefined && !types.has(type));
      if (notices) {
        (left ? passed : searched).add(id);
        if (left || !holdsNotice(id)) continue;
      } else if (left) {
        if (safety.has(type)) leftOut.add(id);
        continue;
      }
      const found = gathered.get(id);
      if (found) found.when = either(found.when, when);
      else gathered.set(id, { module: id, type, ...(when && { when }) });
    }
  };
  // The source's first inclusion of a module decides its place: one met
  // unconditionally first stays unconditional.
  visit(source.entries, undefined);

  for (const id of leftOut) {
    issues.push({
      severity: 'warning',
      code: 'safety-module-excluded',
      message: excluded.has(id)
        ? `the safety module "${id}" of the source manual is excluded by the rule`
        : `the safety module "${id}" of the source manual is of a type the rule does not gather`,
      at: id,
    });
  }
  if (reach) {
    issues.push(
      ...noticesLeftOut(reach, levels, {
        whole: own,
        searched,
        passed,
      }),
    );
  }
  for (const id of rule.exclude) {
    if (!named.has(id)) {
      issues.push({
        severity: 'warning',
        code: 'unknown-excluded-module',
        message: `the rule excludes the module "${id}", which the source manual does not include`,
        at: id,
      });
    }
  }
  if (gathered.size === 0) {
    issues.push(emptyDerivedManual(rule.source, notices !== undefined));
  }
  return done([...gathered.values()], attributes);
}

/** What a notice gathering knows of the modules it reads: their own notices' levels and what they refer to. */
interface NoticeReach {
  /** The hazard levels of a module's own notices (`noticeLevelsIn`); none for one not read. */
  levels(id: string): ReadonlySet<SafetySeverity>;
  /** A module and every module it refers to, through theirs too, each once. */
  from(id: string): ReadonlySet<string>;
}

function noticeReach(
  module: ((id: string) => Module | undefined) | undefined,
): NoticeReach {
  const levels = new Map<string, Set<SafetySeverity>>();
  const reached = new Map<string, Set<string>>();
  const read = (id: string) => module?.(id);
  return {
    levels(id) {
      let found = levels.get(id);
      if (!found) {
        found = noticeLevelsIn(read(id)?.blocks ?? []);
        levels.set(id, found);
      }
      return found;
    },
    from(id) {
      let found = reached.get(id);
      if (found) return found;
      found = new Set<string>();
      const pending = [id];
      while (pending.length > 0) {
        const next = pending.pop() as string;
        if (found.has(next)) continue;
        found.add(next);
        pending.push(...referencedModuleIds(read(next)?.blocks ?? []));
      }
      reached.set(id, found);
      return found;
    },
  };
}

/**
 * The `safety-notice-excluded` warnings of a notice gathering (#670), each `at` the module
 * holding the notices (never the module through which it is reached, so a warning names only
 * the module it is about): a module whose notices of a gathered level are reached only through
 * source modules the rule leaves out (excluded, or of a type it does not search), and a module
 * whose notices, reached through a searched one, include a level the rule does not gather. The
 * front and back matter show whole, notices and all.
 */
function noticesLeftOut(
  reach: NoticeReach,
  levels: ReadonlySet<SafetySeverity>,
  modules: {
    whole: ReadonlySet<string>;
    searched: ReadonlySet<string>;
    passed: ReadonlySet<string>;
  },
): Issue[] {
  const all = (ids: ReadonlySet<string>) => {
    const found = new Set<string>();
    for (const id of ids) for (const m of reach.from(id)) found.add(m);
    return found;
  };
  const whole = all(modules.whole);
  const searched = all(modules.searched);
  const issues: Issue[] = [];
  for (const id of all(modules.passed)) {
    if (whole.has(id) || searched.has(id)) continue;
    if (![...reach.levels(id)].some((l) => levels.has(l))) continue;
    issues.push({
      severity: 'warning',
      code: 'safety-notice-excluded',
      message: `the safety notices of the module "${id}" are left out: the rule excludes, or does not search the type of, every module of the source manual that includes them`,
      at: id,
    });
  }
  for (const id of searched) {
    if (whole.has(id)) continue;
    const other = [...reach.levels(id)].filter((l) => !levels.has(l));
    if (other.length === 0) continue;
    issues.push({
      severity: 'warning',
      code: 'safety-notice-excluded',
      message: `the module "${id}" holds safety notices of a level the rule does not gather (${other.join(', ')})`,
      at: id,
    });
  }
  return issues;
}

/**
 * The `empty-derived-manual` warning for a derived manual of `source`: what `deriveManifest`
 * gives when its rule gathers nothing, and what a reader is told when it gathers nothing they
 * may see (the API filters gathered entries per reader).
 */
export function emptyDerivedManual(source: string, notices = false): Issue {
  return {
    severity: 'warning',
    code: 'empty-derived-manual',
    message: notices
      ? `the rule gathers no safety notice from the source manual "${source}"`
      : `the rule gathers no module from the source manual "${source}"`,
  };
}

/**
 * The module IDs a derived manual needs read to be derived: its source's module entries, each
 * once, in order (their types decide what is gathered).
 */
export function sourceModuleIds(source: Manifest): string[] {
  const ids = new Set<string>();
  const visit = (entries: readonly ManifestEntry[]) => {
    for (const entry of entries) {
      if ('entries' in entry) visit(entry.entries);
      else ids.add(entry.module);
    }
  };
  visit(source.entries);
  return [...ids];
}

/** The blocks a block holds (none for a module reference: it is another module's). */
function childBlocks(block: Block): readonly (readonly Block[])[] {
  switch (block.type) {
    case 'section':
    case 'safety':
    case 'admonition':
    case 'faq':
    case 'variant':
      return [block.blocks];
    case 'list':
      return block.items.map((i) => i.blocks);
    case 'procedure':
      return block.steps.map((i) => i.blocks);
    case 'table':
      return block.rows.flatMap((r) => r.cells.map((c) => c.blocks));
    default:
      return [];
  }
}

/** Both conditions (none: the other). */
function both(
  a: Condition | undefined,
  b: Condition | undefined,
): Condition | undefined {
  if (!a) return b;
  if (!b) return a;
  return { op: 'all', of: [a, b] };
}

/** Either condition: none (always) when either is none. */
function either(
  a: Condition | undefined,
  b: Condition | undefined,
): Condition | undefined {
  if (!a || !b) return undefined;
  if (JSON.stringify(a) === JSON.stringify(b)) return a;
  return {
    op: 'any',
    of: [...(a.op === 'any' ? a.of : [a]), ...(b.op === 'any' ? b.of : [b])],
  };
}
