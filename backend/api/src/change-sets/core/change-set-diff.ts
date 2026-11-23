import type {
  Block,
  Item,
  Manifest,
  Module,
  PageDesign,
  ProjectConfig,
  Term,
} from '@openfolia/content-model';
import type { LockSubject } from './lock.js';
import type { TemplateFileContent } from './working-copy.js';

/** How a module, a manual or a block differs from the change set's base. */
export const CHANGE_KINDS = ['added', 'changed', 'removed'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

/** A block, list item or procedure step that differs, by its ID. */
export interface BlockChange {
  readonly blockId: string;
  readonly change: ChangeKind;
}

/**
 * A subject a change set changes, as the reader sees it at the base commit
 * and at the head: `fields` names the module's metadata (`title`, `type`,
 * `audience`, …), the manifest's members, the configuration's members
 * (`configFields`) or the term's members (a language as
 * `languages/<lang>`) that differ, `blocks` the blocks (modules only). Both are empty for one added or
 * removed, and for a file one side has that cannot be read (`unreadable`).
 */
export interface SubjectChange {
  readonly subject: LockSubject;
  readonly change: ChangeKind;
  readonly fields: readonly string[];
  readonly blocks: readonly BlockChange[];
  readonly unreadable: boolean;
}

/** One side of a subject: what the reader sees, a broken file, or nothing. */
export type Side<T> = T | 'unreadable' | undefined;

/**
 * How `subject` changed from `before` to `after`, each as the reader sees
 * it (one they may not see is `undefined`, exactly like a missing one).
 * `undefined` when there is nothing to show: neither side is there, or
 * both are the same.
 */
/** What one side of a subject holds: its kind's content. */
export type SubjectContent =
  Module | Manifest | ProjectConfig | Term | PageDesign | TemplateFileContent;

export function subjectChange(
  subject: LockSubject,
  before: Side<SubjectContent>,
  after: Side<SubjectContent>,
): SubjectChange | undefined {
  if (before === undefined && after === undefined) return undefined;
  const change: ChangeKind =
    before === undefined
      ? 'added'
      : after === undefined
        ? 'removed'
        : 'changed';
  const unreadable = before === 'unreadable' || after === 'unreadable';
  const none = { subject, change, fields: [], blocks: [], unreadable };
  if (change !== 'changed' || unreadable) return none;
  if (canonical(before) === canonical(after)) return undefined;
  switch (subject.type) {
    case 'module': {
      const [b, a] = [before as Module, after as Module];
      return {
        ...none,
        fields: differing(b.meta, a.meta),
        blocks: diffBlocks(b.blocks, a.blocks),
      };
    }
    case 'manual': {
      const [b, a] = [before as Manifest, after as Manifest];
      return { ...none, fields: differing(b, a, ['id', 'schemaVersion']) };
    }
    case 'config':
      return {
        ...none,
        fields: configFields(before as ProjectConfig, after as ProjectConfig),
      };
    case 'term': {
      const [b, a] = [before as Term, after as Term];
      return {
        ...none,
        fields: [
          ...differing(b, a, ['id', 'schemaVersion', 'languages']),
          ...differing(b.languages, a.languages).map((l) => `languages/${l}`),
        ].sort(),
      };
    }
    case 'design': {
      // The settings that differ, by their top-level member (`colours`, `regions`, …).
      const [b, a] = [before as PageDesign, after as PageDesign];
      return { ...none, fields: differing(b, a, ['id', 'schemaVersion']) };
    }
    case 'template':
      // A template file is text (#396): changed, with no fields of its own.
      return none;
  }
}

/**
 * The configuration's members that differ. A list of items with IDs
 * (`moduleTypes`, `audiences`, `variantAttributes`, …) names each item
 * added, removed or changed as `<member>/<id>` (`variantAttributes/model`),
 * and the member alone when only the order changed; any other member
 * (`languages`, `outputLabels`, `maxHeadingLevel`) by its name.
 */
export function configFields(
  before: ProjectConfig,
  after: ProjectConfig,
): string[] {
  const fields: string[] = [];
  const [b, a] = [
    before as unknown as Record<string, unknown>,
    after as unknown as Record<string, unknown>,
  ];
  for (const key of differing(b, a)) {
    const [x, y] = [b[key], a[key]];
    const items = (list: unknown) =>
      Array.isArray(list) &&
      list.every(
        (item) =>
          item !== null &&
          typeof item === 'object' &&
          typeof (item as { id?: unknown }).id === 'string',
      )
        ? new Map(
            (list as { id: string }[]).map((item) => [
              item.id,
              canonical(item),
            ]),
          )
        : undefined;
    const [xs, ys] = [items(x), items(y)];
    if (!xs || !ys) {
      fields.push(key);
      continue;
    }
    const ids = [...new Set([...xs.keys(), ...ys.keys()])].filter(
      (id) => xs.get(id) !== ys.get(id),
    );
    if (ids.length === 0) fields.push(key);
    else fields.push(...ids.map((id) => `${key}/${id}`));
  }
  return fields.sort();
}

/**
 * The blocks, list items and procedure steps that differ, by ID: `added`
 * (only `after` has the ID), `removed` (only `before`), `changed` (its own
 * content or its parent differs). A container's own content holds the IDs
 * of the nodes inside it, in order, but not their content: an edit inside
 * a section is the inner block's alone; adding, removing or reordering
 * what a container holds changes the container too. A table's own content
 * is its layout (rows and cells, with the IDs of each cell's blocks), so a
 * row added above leaves the blocks below unchanged. An unchanged block
 * keeps its ID and is never listed. In `after`'s order, then the removed
 * ones in `before`'s.
 */
export function diffBlocks(
  before: readonly Block[],
  after: readonly Block[],
): BlockChange[] {
  const [old, now] = [nodes(before), nodes(after)];
  const changes: BlockChange[] = [];
  for (const [blockId, own] of now) {
    const was = old.get(blockId);
    if (was === undefined) changes.push({ blockId, change: 'added' });
    else if (was !== own) changes.push({ blockId, change: 'changed' });
  }
  for (const blockId of old.keys()) {
    if (!now.has(blockId)) changes.push({ blockId, change: 'removed' });
  }
  return changes;
}

/** Every node with an ID, in document order, with its own content and parent. */
function nodes(blocks: readonly Block[]): Map<string, string> {
  const found = new Map<string, string>();
  const ids = (list: readonly { id: string }[]) => list.map((n) => n.id);
  const add = (id: string, parent: string, own: unknown) => {
    // A duplicate ID is a validation error; the first one counts.
    if (!found.has(id)) found.set(id, canonical({ parent, own }));
  };
  const visitItems = (items: readonly Item[], parent: string) => {
    for (const { blocks: inner, ...own } of items) {
      add(own.id, parent, { ...own, blocks: ids(inner) });
      visitBlocks(inner, own.id);
    }
  };
  const visitBlocks = (list: readonly Block[], parent: string) => {
    for (const block of list) {
      switch (block.type) {
        case 'section':
        case 'safety':
        case 'admonition':
        case 'faq':
        case 'variant': {
          add(block.id, parent, { ...block, blocks: ids(block.blocks) });
          visitBlocks(block.blocks, block.id);
          break;
        }
        case 'list': {
          add(block.id, parent, { ...block, items: ids(block.items) });
          visitItems(block.items, block.id);
          break;
        }
        case 'procedure': {
          add(block.id, parent, { ...block, steps: ids(block.steps) });
          visitItems(block.steps, block.id);
          break;
        }
        case 'table': {
          add(block.id, parent, {
            ...block,
            rows: block.rows.map((row) => ({
              cells: row.cells.map((cell) => ({
                ...cell,
                blocks: ids(cell.blocks),
              })),
            })),
          });
          for (const row of block.rows) {
            for (const cell of row.cells) visitBlocks(cell.blocks, block.id);
          }
          break;
        }
        default:
          add(block.id, parent, block);
      }
    }
  };
  visitBlocks(blocks, '');
  return found;
}

/** The members of `a` and `b` (but `ignored`) whose values differ, sorted. */
function differing(
  a: object,
  b: object,
  ignored: readonly string[] = [],
): string[] {
  const [x, y] = [a as Record<string, unknown>, b as Record<string, unknown>];
  return [...new Set([...Object.keys(x), ...Object.keys(y)])]
    .filter(
      (key) =>
        !ignored.includes(key) && canonical(x[key]) !== canonical(y[key]),
    )
    .sort();
}

/** JSON with object members in sorted order (undefined ones left out). */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([k1], [k2]) =>
            k1 < k2 ? -1 : k1 > k2 ? 1 : 0,
          ),
        )
      : v,
  );
}
