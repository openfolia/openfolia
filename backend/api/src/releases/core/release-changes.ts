import type {
  ManifestEntry,
  Module,
  ProjectConfig,
} from '@openfolia/content-model';
import type { Actor } from '../../access/core/actor.js';
import type { ChangeSetBranches } from '../../change-sets/core/change-set-branches.js';
import {
  type BlockChange,
  type ChangeKind,
  type Side,
  subjectChange,
} from '../../change-sets/core/change-set-diff.js';
import { subjectOfPath } from '../../change-sets/core/commit.js';
import { seenOnBoth } from '../../change-sets/core/diff-sides.js';
import { changedPathsWithin } from '../../change-sets/core/review-scope.js';
import { UnprocessableError } from '../../base/core/errors.js';
import type { ReadableContent } from '../../content/core/readable-content.js';

/** A module that changed in a manual, in one language. */
export interface ReleaseModuleChange {
  readonly moduleId: string;
  readonly change: ChangeKind;
  /** Its metadata fields that differ (`title`, `type`, …); empty when added or removed. */
  readonly fields: readonly string[];
  /** Its blocks that differ, by block ID (#23's block diff). */
  readonly blocks: readonly BlockChange[];
}

/**
 * One manual in one language that a release changed (#138), against the
 * product's previous release: `added` (new, or the product's first
 * release), `removed`, or `changed` (its manifest, or a module it names in
 * that language).
 */
export interface ReleaseChange {
  readonly manualId: string;
  readonly lang: string;
  readonly change: ChangeKind;
  /** The manifest's members that differ (`title`, `entries`, …); empty unless changed. */
  readonly fields: readonly string[];
  /** The modules it names that changed in this language, by ID; empty unless changed. */
  readonly modules: readonly ReleaseModuleChange[];
}

/**
 * Who works out what a release changed, once per pair of releases: a
 * reader of all released content. What a person sees of it is then
 * filtered from that (`changesFor`), never read again from Git.
 */
export const RELEASE_READER: Actor = Object.freeze({
  kind: 'service',
  // Outside the `UserId` format (":"), so no user can have this ID.
  id: 'service:releases',
  roles: Object.freeze([
    Object.freeze({
      id: 'release-reader',
      name: 'Releases (read-only)',
      permissions: Object.freeze(['content.read']),
      scope: Object.freeze({}),
    }),
  ]),
}) as Actor;

/** A manual on one side of a release diff: what deciding who sees it needs. */
export interface ManualSide {
  readonly audience: string | undefined;
  /**
   * The modules its manifest names, anywhere in it; in a `ReleaseDiff`,
   * only those that changed (`changedModules`).
   */
  readonly modules: readonly string[];
}

/** A module file that differs between two releases, in one language. */
export interface ModuleSides {
  /** Each side's module without its blocks (what visibility is judged by); `'unreadable'` for a broken file. */
  readonly before: Side<Module>;
  readonly after: Side<Module>;
  readonly fields: readonly string[];
  readonly blocks: readonly BlockChange[];
}

/**
 * What a release changed against the previous one, as `RELEASE_READER`
 * sees it (everything): the manuals on each side, the manifests and the
 * module files that differ, with what decides who may see each. Immutable
 * for a pair of commits, so it is worked out once and kept.
 */
export interface ReleaseDiff {
  /**
   * The manuals that may have changed for some reader: on one side only,
   * with a manifest that differs, or naming a module that changed. One on
   * both sides, its manifest the same and naming no changed module, is
   * the same for every reader and left out.
   */
  readonly manuals: ReadonlyMap<string, ManualSides>;
  /** By `<lang>\0<moduleId>`. */
  readonly modules: ReadonlyMap<string, ModuleSides>;
  /** The IDs of the modules among `modules`, in any language: to pass over a manual naming none of them at once. */
  readonly changedModules: ReadonlySet<string>;
}

/** A manual in a release diff: on which sides it is, and what differs. */
export interface ManualSides {
  readonly before?: ManualSide;
  readonly after?: ManualSide;
  /** The manifest's members that differ; undefined when it does not. */
  readonly fields?: readonly string[];
}

/**
 * What a pair of releases too large to compare is worked out as: more
 * files changed than a review reads (`MAX_REVIEWED_PATHS`, counted over the
 * whole repository). Kept like a diff, so it is decided once.
 */
export const TOO_MANY_CHANGES = 'too-many-changes';

/** How many modules are read at once while diffing. */
const READ_AT_ONCE = 16;

/**
 * What `head` changed against `base` (undefined for a product's first
 * release), both opened as `RELEASE_READER`: every manual on either side
 * (a broken manifest is left out), and every manifest and module file
 * that differs (`changedPathsWithin`: 422 `too-many-changes` past what a
 * review reads), with the block diff of a change set. A release holds the
 * whole repository (#40), so every manual counts, whatever the product.
 */
export async function releaseDiff(
  branches: Pick<ChangeSetBranches, 'changedPaths'>,
  head: ReadableContent,
  base: ReadableContent | undefined,
): Promise<ReleaseDiff | typeof TOO_MANY_CHANGES> {
  let changed: { path: string }[] = [];
  if (base) {
    // First, so a pair too large costs no manifest read.
    try {
      changed = await changedPathsWithin(branches, base.commit, head.commit);
    } catch (error) {
      if (
        error instanceof UnprocessableError &&
        error.code === TOO_MANY_CHANGES
      ) {
        return TOO_MANY_CHANGES;
      }
      throw error;
    }
  }
  const [after, before] = await Promise.all([
    manualsOf(head),
    base ? manualsOf(base) : new Map<string, ManualSide>(),
  ]);
  const modules = new Map<string, ModuleSides>();
  const manifests = new Map<string, readonly string[]>();
  if (base) {
    const subjects = changed.flatMap(({ path }) => {
      const subject = subjectOfPath(path);
      return subject?.type === 'module' || subject?.type === 'manual'
        ? [subject]
        : [];
    });
    for (let i = 0; i < subjects.length; i += READ_AT_ONCE) {
      await Promise.all(
        subjects.slice(i, i + READ_AT_ONCE).map(async (subject) => {
          const [b, a] = [
            await seenOnBoth(base, head, subject),
            await seenOnBoth(head, base, subject),
          ];
          const change = subjectChange(subject, b, a);
          if (!change) return;
          if (subject.type === 'module') {
            modules.set(moduleKey(subject.lang, subject.moduleId), {
              before: withoutBlocks(b as Side<Module>),
              after: withoutBlocks(a as Side<Module>),
              fields: change.fields,
              blocks: change.blocks,
            });
          } else if (subject.type === 'manual') {
            manifests.set(subject.manualId, change.fields);
          }
        }),
      );
    }
  }
  const changedModules = changedModulesOf(modules.keys());
  const manuals = new Map<string, ManualSides>();
  // A side names only the changed modules among its own: all that
  // `changesFor` looks at.
  const changedOf = (side: ManualSide | undefined) =>
    side && {
      ...side,
      modules: side.modules.filter((m) => changedModules.has(m)),
    };
  for (const id of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const manual: ManualSides = {
      ...(before.has(id) && { before: changedOf(before.get(id)) }),
      ...(after.has(id) && { after: changedOf(after.get(id)) }),
      ...(manifests.has(id) && { fields: manifests.get(id) }),
    };
    if (!unchanged(manual, changedModules)) manuals.set(id, manual);
  }
  return { manuals, modules, changedModules };
}

/**
 * Whether `manual` is the same on both sides for every reader: there on
 * both, its manifest the same, naming no changed module on either.
 */
function unchanged(
  manual: ManualSides,
  changedModules: ReadonlySet<string>,
): boolean {
  return (
    manual.before !== undefined &&
    manual.after !== undefined &&
    manual.fields === undefined &&
    !manual.before.modules.some((m) => changedModules.has(m)) &&
    !manual.after.modules.some((m) => changedModules.has(m))
  );
}

function changedModulesOf(keys: Iterable<string>): Set<string> {
  return new Set([...keys].map((key) => key.slice(key.indexOf('\0') + 1)));
}

/**
 * The version of `StoredReleaseDiff`'s shape and of what `releaseDiff`
 * works out. Raise it whenever either changes, including the module
 * metadata a kept side holds (`Module` without its blocks, which
 * `changesFor` judges visibility by) or what of it access reads
 * (`moduleTarget`): kept diffs of another version are not read, and are
 * worked out again.
 */
export const RELEASE_DIFF_FORMAT = 1;

/** A `ReleaseDiff` as plain JSON (`ReleaseDiffStore`), or `TOO_MANY_CHANGES`. */
export type StoredReleaseDiff =
  | typeof TOO_MANY_CHANGES
  | {
      readonly manuals: readonly (readonly [string, ManualSides])[];
      /** By language and module ID (JSON in Postgres holds no `\0`). */
      readonly modules: readonly (readonly [
        lang: string,
        moduleId: string,
        sides: ModuleSides,
      ])[];
    };

/** `diff` as it is kept. */
export function storedDiff(
  diff: ReleaseDiff | typeof TOO_MANY_CHANGES,
): StoredReleaseDiff {
  if (diff === TOO_MANY_CHANGES) return diff;
  return {
    manuals: [...diff.manuals],
    modules: [...diff.modules].map(([key, sides]) => {
      const at = key.indexOf('\0');
      return [key.slice(0, at), key.slice(at + 1), sides] as const;
    }),
  };
}

/** The diff `stored` keeps. */
export function fromStoredDiff(
  stored: StoredReleaseDiff,
): ReleaseDiff | typeof TOO_MANY_CHANGES {
  if (stored === TOO_MANY_CHANGES) return stored;
  const modules = new Map(
    stored.modules.map(
      ([lang, moduleId, sides]) => [moduleKey(lang, moduleId), sides] as const,
    ),
  );
  return {
    manuals: new Map(stored.manuals),
    modules,
    changedModules: changedModulesOf(modules.keys()),
  };
}

/**
 * What the reader sees of `diff`, `head` and `base` opened as them (both
 * release tags: `content.read`): one `ReleaseChange` per manual and
 * language, in manual ID and language order. A manual is there on a side
 * only when they may see it there, and listed in a language only when they
 * may read it in that language; a module only on the sides they may see
 * it (a module that leaves their scope reads as `removed`, as for a change
 * set). So nothing outside their scope is named or counted. Reads no
 * module from Git: only a manifest whose `entries` changed is compared
 * again as they see it (`seenOnBoth`), unless `everything` (they see all
 * of it, as `RELEASE_READER` does).
 */
export async function changesFor(
  diff: ReleaseDiff,
  head: ReadableContent,
  base: ReadableContent | undefined,
  everything: boolean,
): Promise<ReleaseChange[]> {
  const [headLangs, baseLangs] = await Promise.all([
    languagesOf(head),
    base ? languagesOf(base) : [],
  ]);
  const changes: ReleaseChange[] = [];
  const whole = async (
    content: ReadableContent,
    manualId: string,
    side: ManualSide,
    langs: readonly string[],
    change: ChangeKind,
  ) => {
    for (const lang of langs) {
      if (await content.seesManualIn(side.audience, lang)) {
        changes.push({ manualId, lang, change, fields: [], modules: [] });
      }
    }
  };
  for (const [id, manual] of diff.manuals) {
    // Unchanged on both sides, for everyone: nothing to judge.
    if (unchanged(manual, diff.changedModules)) continue;
    const seenBefore =
      base !== undefined &&
      manual.before !== undefined &&
      (await base.wouldSee({ manualAudience: manual.before.audience }));
    const seenAfter =
      manual.after !== undefined &&
      (await head.wouldSee({ manualAudience: manual.after.audience }));
    if (seenAfter && !seenBefore) {
      await whole(head, id, manual.after as ManualSide, headLangs, 'added');
      continue;
    }
    if (seenBefore && !seenAfter) {
      await whole(
        base as ReadableContent,
        id,
        manual.before as ManualSide,
        baseLangs,
        'removed',
      );
      continue;
    }
    if (!seenBefore || !seenAfter || !base) continue;
    const [before, after] = [
      manual.before as ManualSide,
      manual.after as ManualSide,
    ];
    let fields = manual.fields;
    if (fields?.includes('entries') && !everything) {
      // Its entries as the reader sees them: one naming only what is
      // hidden from them did not change for them.
      const subject = { type: 'manual', manualId: id } as const;
      fields = subjectChange(
        subject,
        await seenOnBoth(base, head, subject),
        await seenOnBoth(head, base, subject),
      )?.fields;
    }
    const named = [...new Set([...before.modules, ...after.modules])]
      .filter((m) => diff.changedModules.has(m))
      .sort();
    for (const lang of headLangs) {
      if (!(await head.seesManualIn(after.audience, lang))) continue;
      const modules: ReleaseModuleChange[] = [];
      for (const moduleId of named) {
        const sides = diff.modules.get(moduleKey(lang, moduleId));
        const seen = sides && (await moduleSeen(sides, lang, base, head));
        if (seen) modules.push({ moduleId, ...seen });
      }
      if (modules.length === 0 && fields === undefined) continue;
      changes.push({
        manualId: id,
        lang,
        change: 'changed',
        fields: fields ?? [],
        modules,
      });
    }
  }
  return changes.sort(
    (a, b) =>
      a.manualId.localeCompare(b.manualId) || a.lang.localeCompare(b.lang),
  );
}

/** The distinct manuals among `changes`. */
export function changedManuals(changes: readonly ReleaseChange[]): string[] {
  return [...new Set(changes.map((c) => c.manualId))];
}

/** How a module changed as the reader sees its two sides; undefined for not at all. */
async function moduleSeen(
  sides: ModuleSides,
  lang: string,
  base: ReadableContent,
  head: ReadableContent,
): Promise<Omit<ReleaseModuleChange, 'moduleId'> | undefined> {
  const sees = async (content: ReadableContent, side: Side<Module>) =>
    side === undefined
      ? false
      : side === 'unreadable'
        ? content.wouldSee({ brokenModuleIn: lang })
        : content.wouldSee({ module: side });
  const [before, after] = [
    await sees(base, sides.before),
    await sees(head, sides.after),
  ];
  if (before && after) {
    return { change: 'changed', fields: sides.fields, blocks: sides.blocks };
  }
  if (before) return { change: 'removed', fields: [], blocks: [] };
  if (after) return { change: 'added', fields: [], blocks: [] };
  return undefined;
}

/** The manuals in `content` (but broken ones), by ID. */
async function manualsOf(
  content: ReadableContent,
): Promise<Map<string, ManualSide>> {
  const found = new Map<string, ManualSide>();
  for (const listing of await content.manuals()) {
    if ('error' in listing) continue;
    found.set(listing.id, {
      audience: listing.manifest.audience,
      modules: [...new Set(moduleIdsOf(listing.manifest.entries))],
    });
  }
  return found;
}

async function languagesOf(content: ReadableContent): Promise<string[]> {
  const config: ProjectConfig = await content.config();
  return [config.languages.source, ...config.languages.targets];
}

function withoutBlocks(side: Side<Module>): Side<Module> {
  return side === undefined || side === 'unreadable'
    ? side
    : { ...side, blocks: [] };
}

function moduleIdsOf(entries: readonly ManifestEntry[]): string[] {
  return entries.flatMap((e) =>
    'module' in e ? [e.module] : moduleIdsOf(e.entries),
  );
}

const moduleKey = (lang: string, id: string) => `${lang}\0${id}`;
