import type {
  Manifest,
  Module,
  PageDesign,
  ProjectConfig,
  Term,
} from '@openfolia/content-model';
import { ConflictError } from '../../base/core/errors.js';
import type { ReadableContent } from '../../content/core/readable-content.js';
import { subjectName } from './lock.js';
import type { DraftManifest } from './working-copy.js';

/**
 * Where a page design a commit deletes is still named (#554): the configuration's `pdf.design`,
 * or a manual's `design` (`manual` its ID when the actor may read that manual, none otherwise).
 */
export type DesignUse =
  | { readonly in: 'config'; readonly design: string }
  | {
      readonly in: 'manual';
      readonly design: string;
      readonly manual?: string;
    };

/** The most places one refusal names. */
export const MAX_DESIGN_USES = 50;

/**
 * The places that name a design in `deleted` (design IDs) in `content` (a change set's head) as
 * a commit leaves it: `config` the configuration it keeps, `replaced` the files the same commit
 * writes (by subject name, `null` for a deletion), read in place of what is committed. Every
 * manual counts, whether or not the actor may read it (read past the reading filter: a check,
 * never a response); one they may not read is named without its ID, once per design.
 */
export async function designUsages(
  content: ReadableContent,
  deleted: ReadonlySet<string>,
  replaced: ReadonlyMap<
    string,
    Module | Manifest | DraftManifest | Term | PageDesign | null
  >,
  config: ProjectConfig,
): Promise<DesignUse[]> {
  if (deleted.size === 0) return [];
  const uses: DesignUse[] = [];
  const design = config.pdf.design;
  if (design !== undefined && deleted.has(design)) {
    uses.push({ in: 'config', design });
  }
  const manuals: {
    id: string;
    design: string | undefined;
    audience: string | undefined;
  }[] = [];
  for (const m of await content.manifestDesignsForCheck()) {
    if (replaced.has(subjectName({ type: 'manual', manualId: m.id }))) continue;
    manuals.push(m);
  }
  for (const file of replaced.values()) {
    // A manifest the commit writes, as written (a module has blocks, a term languages, a
    // design a preset).
    if (file === null || !('entries' in file)) continue;
    manuals.push({ id: file.id, design: file.design, audience: file.audience });
  }
  const hidden = new Set<string>();
  const named: DesignUse[] = [];
  for (const m of manuals) {
    if (m.design === undefined || !deleted.has(m.design)) continue;
    if (await content.wouldSee({ manualAudience: m.audience })) {
      named.push({ in: 'manual', design: m.design, manual: m.id });
    } else {
      hidden.add(m.design);
    }
  }
  named.sort(
    (a, b) =>
      a.design.localeCompare(b.design) ||
      (a.in === 'manual' && b.in === 'manual'
        ? (a.manual ?? '').localeCompare(b.manual ?? '')
        : 0),
  );
  uses.push(...named);
  for (const id of [...hidden].sort()) uses.push({ in: 'manual', design: id });
  return uses;
}

/**
 * 409 `design-in-use` when a design to delete is still named: `meta.designs` the designs,
 * `meta.usedIn` the places (`DesignUse`, at most `MAX_DESIGN_USES`; `meta.more` counts the
 * rest). The design stays.
 */
export function refuseDesignUsages(uses: readonly DesignUse[]): void {
  if (uses.length === 0) return;
  const designs = [...new Set(uses.map((u) => u.design))].sort();
  throw new ConflictError(
    'design-in-use',
    `The configuration or manuals still name the page ${designs.length === 1 ? 'design' : 'designs'} to delete (${designs.join(', ')}): choose another design there first.`,
    {
      designs,
      usedIn: uses.slice(0, MAX_DESIGN_USES),
      ...(uses.length > MAX_DESIGN_USES && {
        more: uses.length - MAX_DESIGN_USES,
      }),
    },
  );
}
