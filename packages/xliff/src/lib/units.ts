import {
  configUnits,
  designUnits,
  type LabelledConfig,
  TITLE_UNIT,
  type Manifest,
  manifestUnits,
  variantSlug,
  normalizeBlock,
  normalizeModule,
  regionSourceText,
  type PageDesign,
  type RegionBlocks,
  type Translatable,
  plainTextOf,
  sourceHash,
  translatableUnits,
  type Block,
  type Item,
  type Module,
  type SourceHash,
  type TranslatableUnit,
} from '@openfolia/content-model';

/** A translatable unit with what a translator is told about it. */
export interface XliffUnit extends TranslatableUnit {
  readonly sourceHash: SourceHash;
  /**
   * Where the unit sits in its module: each enclosing block and the
   * unit's own, as `<type>#<id>` (`item` for a list item or step,
   * `callout` for a callout's legend, after its image), outer first.
   */
  readonly path: readonly string[];
}

/**
 * The translatable units of `module` (`translatableUnits`), in document
 * order, each with its source hash and its path; only those `include`
 * names (block IDs), when given.
 */
export function xliffUnitsOf(
  module: Module,
  include?: ReadonlySet<string>,
): XliffUnit[] {
  const paths = pathsOf(normalizeModule(module).blocks);
  return translatableUnits(module)
    .filter((unit) => !include || include.has(unit.blockId))
    .map((unit) => ({
      ...unit,
      sourceHash: sourceHash(unit),
      path: pathOf(paths, unit, unit.blockId, unit.image),
    }));
}

/**
 * The translatable units of a page design's region text (#568, `designUnits`), in the source
 * language `source`, each with its source hash and its path (`region#<slot>` first); only those
 * `include` names (unit keys, `<slot>.<block>`), when given. A unit's `blockId` is its key.
 */
export function xliffUnitsOfDesign(
  design: PageDesign,
  source: string,
  include?: ReadonlySet<string>,
): XliffUnit[] {
  const bySlot = new Map<string, Map<string, string[]>>();
  return designUnits(design, source)
    .filter((unit) => !include || include.has(unit.blockId))
    .map((unit) => {
      let paths = bySlot.get(unit.slot);
      if (!paths) {
        const text = design.regions[unit.slot] as Translatable<RegionBlocks>;
        paths = pathsOf(
          (regionSourceText(text, source) ?? []).map(normalizeBlock),
        );
        bySlot.set(unit.slot, paths);
      }
      return {
        ...unit,
        sourceHash: sourceHash(unit),
        path: [
          `region#${unit.slot}`,
          ...pathOf(paths, unit, unit.block, unit.image),
        ],
      };
    });
}

/**
 * The translatable units of a manifest (`manifestUnits`: its title and groups' titles, #731, its
 * cover images' alternative text, #656), in the source language `source`, each with its source
 * hash and its path (`title#manual`, `group#<key's hex>`, `coverImage#default`, or
 * `coverImage#<variant slug>` for a variant's own); only those `include` names (unit keys), when
 * given. A unit's `blockId` is its key.
 */
export function xliffUnitsOfManifest(
  manifest: Pick<Manifest, 'title' | 'entries' | 'coverImage'>,
  source: string,
  include?: ReadonlySet<string>,
): XliffUnit[] {
  return manifestUnits(manifest, source)
    .filter((unit) => !include || include.has(unit.blockId))
    .map(({ variant, ...unit }) => ({
      ...unit,
      sourceHash: sourceHash(unit),
      path: [
        unit.kind === 'section'
          ? unit.blockId === TITLE_UNIT
            ? 'title#manual'
            : `group#${unit.blockId.slice('group.'.length)}`
          : `coverImage#${variant === undefined ? 'default' : variantSlug(variant)}`,
      ],
    }));
}

/**
 * The configuration's translatable units (#731, `configUnits`: its labels), in the source
 * language, each with its source hash and its path (`label#<unit key>`); only those `include`
 * names, when given.
 */
export function xliffUnitsOfConfig(
  config: LabelledConfig & { languages: { source: string } },
  include?: ReadonlySet<string>,
): XliffUnit[] {
  return configUnits(config, config.languages.source)
    .filter((unit) => !include || include.has(unit.blockId))
    .map((unit) => ({
      ...unit,
      sourceHash: sourceHash(unit),
      path: [`label#${unit.blockId}`],
    }));
}

/** A unit's path: its block's (or, for a callout's legend, its image's and then its own). */
function pathOf(
  paths: ReadonlyMap<string, string[]>,
  unit: Pick<TranslatableUnit, 'kind'>,
  id: string,
  image: string | undefined,
): string[] {
  return image !== undefined
    ? [...(paths.get(image) ?? [`image#${image}`]), `callout#${id}`]
    : (paths.get(id) ?? [`${unit.kind}#${id}`]);
}

/** Where each block and item of `blocks` sits, by ID: each enclosing one and its own, outer first. */
function pathsOf(blocks: readonly Block[]): Map<string, string[]> {
  const paths = new Map<string, string[]>();
  const visit = (blocks: readonly Block[], above: readonly string[]) => {
    for (const block of blocks) {
      const here = [...above, `${block.type}#${block.id}`];
      paths.set(block.id, here);
      switch (block.type) {
        case 'section':
        case 'safety':
        case 'admonition':
        case 'faq':
        case 'variant':
          visit(block.blocks, here);
          break;
        case 'list':
          items(block.items, here);
          break;
        case 'procedure':
          items(block.steps, here);
          break;
        case 'table':
          for (const row of block.rows) {
            for (const cell of row.cells) visit(cell.blocks, here);
          }
          break;
        default:
          break;
      }
    }
  };
  const items = (list: readonly Item[], above: readonly string[]) => {
    for (const item of list) {
      const here = [...above, `item#${item.id}`];
      paths.set(item.id, here);
      visit(item.blocks, here);
    }
  };
  visit(blocks, []);
  return paths;
}

const segmenters = new Map<string, Intl.Segmenter>();

/**
 * How many words a unit's text has in `lang`, as a translation provider
 * counts them roughly: the word-like segments of each part's plain text
 * (`Intl.Segmenter`, so a language written without spaces counts too).
 * An attribute reference, a cross-reference without text and a keyboard
 * shortcut count as their plain text does.
 */
export function wordCount(
  unit: Pick<TranslatableUnit, 'parts'>,
  lang: string,
): number {
  let segmenter = segmenters.get(lang);
  if (!segmenter) {
    segmenter = new Intl.Segmenter(lang, { granularity: 'word' });
    segmenters.set(lang, segmenter);
  }
  let words = 0;
  for (const part of unit.parts) {
    for (const segment of segmenter.segment(plainTextOf(part.content).text)) {
      if (segment.isWordLike) words++;
    }
  }
  return words;
}
