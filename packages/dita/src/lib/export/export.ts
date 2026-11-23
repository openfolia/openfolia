import {
  type AttributeValue,
  type Block,
  type Condition,
  evaluateCondition,
  type Manifest,
  type ManifestEntry,
  type Module,
  type ProjectConfig,
  type VariantValues,
  variantSlug,
  walk,
  blockPlaces,
  type BlockPlace,
  textIn,
} from '@openfolia/content-model';
import { MODULE_REF_CLASS } from '../conref.js';
import { fixSections } from '../topic.js';
import { ExportProfiling } from './profiling.js';
import {
  type DitaExportWarning,
  type DitaExportWarningCode,
  ExportReport,
} from './report.js';
import {
  MAX_REFERENCE_DEPTH,
  type PendingLink,
  type TopicContext,
  topicIdOf,
  TOPIC_TYPES,
  type TopicType,
  TopicWriter,
} from './topic.js';
import { cost, ditaFile, el, type El, withAttrs } from './xml.js';

/** What a DITA export is made from: one manual, at one point (a release's tag), as its audience reads it. */
export interface DitaExportInput {
  readonly config: ProjectConfig;
  readonly manifest: Manifest;
  /** The languages to export (each a folder of the package), at least one. */
  readonly languages: readonly string[];
  /** The variants a DITAVAL file is made for (and the map names), at least one; the text attributes' values are the first's. */
  readonly variants: readonly VariantValues[];
  /** Module references as content references (`conref`, the default) or their content put in (`resolved`). */
  readonly references?: 'conref' | 'resolved';
  /** A module in a language; undefined when it does not exist or may not be read. */
  module(id: string, lang: string): Module | undefined;
  /** A stored file's extension (`.png`), from its type; undefined for one not stored. */
  asset(ref: string): { readonly extension: string } | undefined;
  /** A safety symbol's artwork's extension; undefined for a symbol without artwork. */
  symbol(id: string): { readonly extension: string } | undefined;
  /** Bounds on what the export writes, all files together. */
  readonly limits?: { readonly maxNodes?: number; readonly maxChars?: number };
}

/** One file of the package: XML made for it, or a stored file (by reference) or a symbol's artwork to put in. */
export type DitaExportFile =
  | { readonly path: string; readonly text: string }
  | { readonly path: string; readonly asset: string }
  | { readonly path: string; readonly symbol: string };

export interface DitaExport {
  /** The package's files, sorted by path. */
  readonly files: readonly DitaExportFile[];
  readonly warnings: readonly DitaExportWarning[];
  /** How many warnings past `MAX_EXPORT_WARNINGS` were not kept. */
  readonly warningsDropped: number;
  /** How many topics it holds (each module once per language). */
  readonly topics: number;
}

/** The export would be larger than its bounds (`DitaExportInput.limits`). */
export class DitaExportTooLargeError extends Error {
  constructor(
    readonly nodes: number,
    readonly chars: number,
  ) {
    super(
      `The DITA export would write more than its bounds allow (${nodes} elements and texts, ${chars} characters so far).`,
    );
    this.name = 'DitaExportTooLargeError';
  }
}

/** The default bounds: elements and texts, and characters, all files together. */
export const DEFAULT_EXPORT_MAX_NODES = 2_000_000;
export const DEFAULT_EXPORT_MAX_CHARS = 256 * 1024 * 1024;

export { MAX_REFERENCE_DEPTH };

/** A path in the package: segments of letters, digits, `.`, `_` and `-`, each starting with a letter or digit (so never `..`). */
const SAFE_PATH =
  /^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*$/;

const DOCTYPES: Readonly<Record<TopicType | 'map', string>> = {
  topic: '-//OASIS//DTD DITA Topic//EN',
  concept: '-//OASIS//DTD DITA Concept//EN',
  task: '-//OASIS//DTD DITA Task//EN',
  reference: '-//OASIS//DTD DITA Reference//EN',
  troubleshooting: '-//OASIS//DTD DITA Troubleshooting//EN',
  map: '-//OASIS//DTD DITA Map//EN',
};

const SYSTEM_IDS: Readonly<Record<TopicType | 'map', string>> = {
  topic: 'topic.dtd',
  concept: 'concept.dtd',
  task: 'task.dtd',
  reference: 'reference.dtd',
  troubleshooting: 'troubleshooting.dtd',
  map: 'map.dtd',
};

/** Elements a content reference to them must hold to be valid (DITA requires them; the target's replace them). */
function stubChildren(name: string): El[] {
  switch (name) {
    case 'ul':
    case 'ol':
      return [el('li')];
    case 'dl':
      return [el('dlentry', {}, [el('dt'), el('dd')])];
    case 'table':
      return [
        el('tgroup', { cols: '1' }, [
          el('tbody', {}, [el('row', {}, [el('entry')])]),
        ]),
      ];
    case 'hazardstatement':
      return [el('messagepanel', {}, [el('typeofhazard'), el('howtoavoid')])];
    default:
      return [];
  }
}

/** The element a top-level block is written as (`TopicWriter.block`), for a content reference to it; undefined for none. */
function elementOf(
  block: Block,
  conrefTarget: (module: string) => { name: string } | undefined,
): string | undefined {
  switch (block.type) {
    case 'paragraph':
      return block.content.some((n) => n.type === 'hardBreak') ? 'lines' : 'p';
    case 'list':
      return block.ordered ? 'ol' : 'ul';
    case 'table':
      return 'table';
    case 'image':
      return block.title ? 'fig' : 'image';
    case 'attachment':
      return 'p';
    case 'safety':
      return block.blocks.every(
        (b) =>
          b.type === 'paragraph' ||
          (b.type === 'list' &&
            !b.ordered &&
            b.items.every((i) => i.blocks.length === 0)),
      )
        ? 'hazardstatement'
        : 'note';
    case 'admonition':
      return 'note';
    case 'faq':
      return 'dl';
    case 'variant':
      return 'div';
    case 'literal':
    case 'passthrough':
      return 'codeblock';
    case 'moduleRef':
      return conrefTarget(block.module)?.name;
    default:
      return undefined;
  }
}

/** Every ID in a copy of blocks prefixed (`<prefix>--<id>`), so a module's content put in twice never repeats one. */
function prefixed(blocks: readonly Block[], prefix: string): Block[] {
  const p = (id: string) => `${prefix}--${id}`;
  const copy = (block: Block): Block => {
    switch (block.type) {
      case 'section':
      case 'safety':
      case 'admonition':
      case 'faq':
      case 'variant':
        return { ...block, id: p(block.id), blocks: block.blocks.map(copy) };
      case 'list':
        return {
          ...block,
          id: p(block.id),
          items: block.items.map((i) => ({
            ...i,
            id: p(i.id),
            blocks: i.blocks.map(copy),
          })),
        };
      case 'procedure':
        return {
          ...block,
          id: p(block.id),
          steps: block.steps.map((i) => ({
            ...i,
            id: p(i.id),
            blocks: i.blocks.map(copy),
          })),
        };
      case 'table':
        return {
          ...block,
          id: p(block.id),
          rows: block.rows.map((r) => ({
            cells: r.cells.map((c) => ({ ...c, blocks: c.blocks.map(copy) })),
          })),
        };
      case 'image':
        return {
          ...block,
          id: p(block.id),
          ...(block.callouts && {
            callouts: block.callouts.map((c) => ({ ...c, id: p(c.id) })),
          }),
        };
      default:
        return { ...block, id: p(block.id) };
    }
  };
  return blocks.map(copy);
}

/** A text attribute's value in a variant (the first value whose condition holds). */
function attributeValue(
  value: AttributeValue | undefined,
  variant: VariantValues,
  versionAttributes: ReadonlySet<string>,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  return value.find(
    (v) =>
      v.when === undefined ||
      evaluateCondition(v.when, variant, { versionAttributes }),
  )?.value;
}

/** A file name for a variant's DITAVAL file: its slug in safe characters. */
function ditavalName(variant: VariantValues, taken: Set<string>): string {
  let base = variantSlug(variant)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+|-+$/g, '');
  if (base === '') base = 'all';
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
  taken.add(name);
  return name;
}

/**
 * The DITA mapping's module types read backwards (#433): the topic type a
 * module type is written as (the first `dita.moduleTypes` entry naming it,
 * else the topic type of its name, else `topic`), and the `@outputclass`
 * that tells the import its module type when the topic type alone would not
 * (a `dita.outputclasses` token naming it, else the module type's own ID).
 */
export function topicTypeFor(
  moduleType: string,
  config: ProjectConfig,
): { type: TopicType; outputclass: string | undefined } {
  const mapping = config.dita;
  const writable = new Set<string>(TOPIC_TYPES);
  let type: TopicType = 'topic';
  const mapped = Object.entries(mapping?.moduleTypes ?? {}).find(
    ([topic, ours]) => ours === moduleType && writable.has(topic),
  );
  if (mapped) type = mapped[0] as TopicType;
  else if (writable.has(moduleType)) type = moduleType as TopicType;
  const token = Object.entries(mapping?.outputclasses ?? {}).find(
    ([, ours]) => ours === moduleType,
  )?.[0];
  if (token !== undefined) return { type, outputclass: token };
  return {
    type,
    outputclass:
      importedType(type, config) === moduleType ? undefined : moduleType,
  };
}

/** The module type the import gives a topic of this type without an output class (`TopicConverter.moduleType`). */
function importedType(type: string, config: ProjectConfig): string | undefined {
  const configured = (id: string | undefined) =>
    id !== undefined && config.moduleTypes.some((t) => t.id === id)
      ? id
      : undefined;
  const mapping = config.dita;
  const mapped =
    mapping && Object.hasOwn(mapping.moduleTypes, type)
      ? configured(mapping.moduleTypes[type])
      : undefined;
  return (
    mapped ??
    configured(type) ??
    configured(mapping?.defaultModuleType) ??
    config.moduleTypes[0]?.id
  );
}

/**
 * A manual as a DITA 1.3 project (#433): per language a map
 * (`<lang>/<manual>.ditamap`) and a topic per module (`<lang>/<module>.dita`,
 * of the topic type its module type maps to), the images, attached files and
 * safety symbols they show (`images/`, `files/`, `symbols/`), and a DITAVAL
 * file per variant (`filters/<variant>.ditaval`), which the map names. The
 * content keeps every variant's: variant blocks and conditional entries carry
 * filter attributes (`ExportProfiling`), and a variant's DITAVAL file filters
 * them as the manual's variant resolves. Module references are content
 * references (`@conref`, `@conrefend`) where DITA can say them, else (and with
 * `references: 'resolved'`) their content put in. Pure and deterministic: the
 * same input makes the same files, and nothing but `input` is read.
 */
export function exportDita(input: DitaExportInput): DitaExport {
  const { config, manifest } = input;
  const mode = input.references ?? 'conref';
  const report = new ExportReport();
  const profiling = new ExportProfiling(config, manifest.variants);
  const versionAttributes = new Set(
    config.variantAttributes
      .filter((a) => a.kind === 'version')
      .map((a) => a.id),
  );
  const maxNodes = input.limits?.maxNodes ?? DEFAULT_EXPORT_MAX_NODES;
  const maxChars = input.limits?.maxChars ?? DEFAULT_EXPORT_MAX_CHARS;
  let nodes = 0;
  let chars = 0;
  const spend = (n: number, c: number) => {
    nodes += n;
    chars += c;
    if (nodes > maxNodes || chars > maxChars) {
      throw new DitaExportTooLargeError(nodes, chars);
    }
  };

  /** Charges what a file's writing adds past `credit` (the characters charged for it already). */
  const charged = (credit: number) => (chars: number) => {
    const over = chars - credit;
    credit = Math.max(0, credit - chars);
    if (over > 0) spend(0, over);
  };

  const files = new Map<string, DitaExportFile>();
  const addFile = (file: DitaExportFile) => {
    if (!SAFE_PATH.test(file.path)) {
      throw new Error(
        `Unsafe path in the DITA export: ${JSON.stringify(file.path)}`,
      );
    }
    if (!files.has(file.path)) files.set(file.path, file);
  };

  // Audience: modules above the manual's are not in it (as `resolveManual` leaves them out).
  // An audience the configuration does not hold ranks above every level: such a module is left out, as `resolveManual` leaves it.
  const rank = (id: string | undefined) => {
    if (id === undefined) return config.audiences.length - 1;
    const at = config.audiences.findIndex((a) => a.id === id);
    return at === -1 ? Infinity : at;
  };
  const maxRank =
    manifest.audience === undefined ? Infinity : rank(manifest.audience);

  // DITAVAL files, one per variant.
  const ditavals: string[] = [];
  const taken = new Set<string>();
  for (const variant of input.variants) {
    const name = ditavalName(variant, taken);
    const path = `filters/${name}.ditaval`;
    ditavals.push(path);
    spend(1, 0);
    const text = ditaFile(profiling.ditaval(variant), undefined, charged(0));
    addFile({ path, text });
  }

  // Assets and symbols, by the path topics name them by.
  const assetHref = (ref: string, kind: 'image' | 'file') => {
    const hash = /^sha256:([a-f0-9]{64})$/.exec(ref)?.[1];
    const stored = hash === undefined ? undefined : input.asset(ref);
    if (!stored || hash === undefined) return undefined;
    const ext = /^\.[a-z0-9]{1,10}$/.test(stored.extension)
      ? stored.extension
      : '.bin';
    const path = `${kind === 'image' ? 'images' : 'files'}/${hash}${ext}`;
    addFile({ path, asset: ref });
    return `../${path}`;
  };
  const symbolNames = new Map<string, string>();
  const symbolHref = (id: string) => {
    const art = input.symbol(id);
    if (!art) return undefined;
    let name = symbolNames.get(id);
    if (name === undefined) {
      const ext = /^\.[a-z0-9]{1,10}$/.test(art.extension)
        ? art.extension
        : '.bin';
      const used = new Set(symbolNames.values());
      const mapped = Object.entries(config.dita?.hazardSymbols ?? {}).find(
        ([file, ours]) =>
          ours === id &&
          SAFE_PATH.test(file) &&
          !file.includes('/') &&
          file.toLowerCase().endsWith(ext) &&
          !used.has(file),
      )?.[0];
      name = mapped ?? `${id}${ext}`;
      // A mapped file name another symbol has already: this one's own, numbered.
      for (let n = 2; used.has(name); n++) name = `${id}-${n}${ext}`;
      symbolNames.set(id, name);
    }
    const path = `symbols/${name}`;
    addFile({ path, symbol: id });
    return `../${path}`;
  };
  const keyOf = (attribute: string) =>
    Object.entries(config.dita?.textKeys ?? {}).find(
      ([, ours]) => ours === attribute,
    )?.[0] ?? attribute;

  let topics = 0;
  const source = config.languages.source;
  for (const lang of input.languages) {
    report.lang = lang;
    // Modules as read in this language (the source language's when there is no translation).
    const loaded = new Map<string, Module | null>();
    const load = (id: string): Module | undefined => {
      if (!loaded.has(id)) {
        let module = input.module(id, lang);
        if (!module && lang !== source) {
          module = input.module(id, source);
          if (module) {
            report.add(
              'missing-translation',
              { module: id },
              `The module has no translation into "${lang}"; the source language's is exported.`,
            );
          }
        }
        if (module && rank(module.meta.audience) > maxRank) module = undefined;
        loaded.set(id, module ?? null);
      }
      return loaded.get(id) ?? undefined;
    };

    // Each module's blocks with the module references DITA cannot say as content references put in.
    const expanded = new Map<string, Block[]>();
    const placesOf = new WeakMap<
      readonly Block[],
      ReadonlyMap<string, BlockPlace>
    >();
    const expanding = new Set<string>();
    const needed = new Set<string>();
    const conrefable = (blocks: readonly Block[]) => {
      const written = blocks.filter((b) => b.type !== 'pageBreak');
      return (
        written.length > 0 &&
        written.every((b) => b.type !== 'section' && b.type !== 'procedure')
      );
    };
    const expand = (module: Module, depth: number): Block[] => {
      const found = expanded.get(module.id);
      if (found) return found;
      expanding.add(module.id);
      const inner = (blocks: readonly Block[]): Block[] =>
        blocks.flatMap((block): Block[] => {
          switch (block.type) {
            case 'moduleRef': {
              const target = load(block.module);
              if (!target) {
                report.add(
                  'module-not-exported',
                  { module: module.id, block: block.id },
                  `The module "${block.module}" it refers to is missing or above the manual's audience; the reference is left out.`,
                );
                return [];
              }
              if (expanding.has(target.id) || depth >= MAX_REFERENCE_DEPTH) {
                report.add(
                  'module-reference-cycle',
                  { module: module.id, block: block.id },
                  `The reference to "${block.module}" leads back to itself or nests deeper than ${MAX_REFERENCE_DEPTH}; it is left out.`,
                );
                return [];
              }
              const content = expand(target, depth + 1);
              if (block.block !== undefined) {
                // One block of it (#223): put in, inside the variant blocks around it, since a
                // content reference names a whole module's topic here.
                let places = placesOf.get(content);
                if (!places) {
                  // Once per expanded module, its walk counted (#223).
                  places = blockPlaces(content);
                  placesOf.set(content, places);
                  spend(places.size, 0);
                }
                const place = places.get(block.block);
                if (!place) {
                  report.add(
                    'module-not-exported',
                    { module: module.id, block: block.id },
                    `The module "${block.module}" has no block "${block.block}"; the reference is left out.`,
                  );
                  return [];
                }
                if (mode === 'conref') {
                  report.add(
                    'module-reference-resolved',
                    { module: module.id, block: block.id },
                    `The reference names one block of "${block.module}", which a content reference to its topic cannot bring in alone; the block is put in.`,
                  );
                }
                let one: Block = place.block;
                for (const around of [...place.within].reverse()) {
                  one = { ...around, blocks: [one] };
                }
                const copy = prefixed([one], block.id);
                let count = 0;
                for (const _ of walk(copy)) count++;
                spend(count, 0);
                return copy;
              }
              if (mode === 'resolved' || !conrefable(content)) {
                if (mode === 'conref') {
                  report.add(
                    'module-reference-resolved',
                    { module: module.id, block: block.id },
                    `The module "${block.module}" holds sections or steps, which a content reference cannot bring in here; its content is put in.`,
                  );
                }
                const copy = prefixed(content, block.id);
                let count = 0;
                for (const _ of walk(copy)) count++;
                spend(count, 0);
                return copy;
              }
              needed.add(target.id);
              return [block];
            }
            case 'section':
              return [{ ...block, blocks: fixSections(inner(block.blocks)) }];
            case 'safety':
            case 'admonition':
            case 'faq':
            case 'variant':
              return [{ ...block, blocks: inner(block.blocks) } as Block];
            case 'list':
              return [
                {
                  ...block,
                  items: block.items.map((i) => ({
                    ...i,
                    blocks: inner(i.blocks),
                  })),
                },
              ];
            case 'procedure':
              return [
                {
                  ...block,
                  steps: block.steps.map((i) => ({
                    ...i,
                    blocks: inner(i.blocks),
                  })),
                },
              ];
            case 'table':
              return [
                {
                  ...block,
                  rows: block.rows.map((r) => ({
                    cells: r.cells.map((c) => ({
                      ...c,
                      blocks: inner(c.blocks),
                    })),
                  })),
                },
              ];
            default:
              return [block];
          }
        });
      const blocks = fixSections(inner(module.blocks));
      expanding.delete(module.id);
      expanded.set(module.id, blocks);
      return blocks;
    };

    // The manual's modules, in order, then the modules content references name.
    const inManual: string[] = [];
    const walkEntries = (entries: readonly ManifestEntry[]) => {
      for (const entry of entries) {
        if ('module' in entry) {
          if (!inManual.includes(entry.module)) inManual.push(entry.module);
        } else walkEntries(entry.entries);
      }
    };
    walkEntries(manifest.entries);
    const written = new Set<string>();
    for (const id of inManual) {
      const module = load(id);
      if (!module) {
        report.add(
          'module-not-exported',
          { module: id },
          `The module is missing, or above the manual's audience; it is left out of the map.`,
        );
        continue;
      }
      expand(module, 0);
      written.add(id);
    }
    for (const id of needed) written.add(id);

    // The element a content reference to a module is: its first top-level block's, empty.
    const stubName = new Map<string, { name: string } | undefined>();
    // Followed without recursion through references whose first block is a reference, at most `MAX_REFERENCE_DEPTH` deep.
    const targetOf = (id: string): { name: string } | undefined => {
      const chain: string[] = [];
      let current = id;
      let found: { name: string } | undefined;
      for (;;) {
        if (stubName.has(current)) {
          found = stubName.get(current);
          break;
        }
        if (chain.length > MAX_REFERENCE_DEPTH || chain.includes(current))
          break;
        chain.push(current);
        const first = (expanded.get(current) ?? []).find(
          (b) => b.type !== 'pageBreak',
        );
        if (first === undefined) break;
        if (first.type === 'moduleRef') {
          current = first.module;
          continue;
        }
        const name = elementOf(first, () => undefined);
        found = name === undefined ? undefined : { name };
        break;
      }
      for (const member of chain) stubName.set(member, found);
      return found;
    };

    const links: { link: PendingLink; from: string }[] = [];
    const anchors = new Map<string, Map<string, string>>();
    const sectionTopics = new Map<string, ReadonlyMap<string, string>>();
    const trees = new Map<string, { root: El; type: TopicType }>();
    const raw = new Map<string, number>();
    for (const id of [...written].sort()) {
      const module = load(id) as Module;
      const own: PendingLink[] = [];
      const ctx: TopicContext = {
        profiling,
        report,
        assetHref,
        symbolHref,
        keyOf,
        links: own,
        conref: (target, where) => {
          const blocks = (expanded.get(target) ?? []).filter(
            (b) => b.type !== 'pageBreak',
          );
          const stub = targetOf(target);
          if (!stub || blocks.length === 0) return undefined;
          const forbidden = [...walk(blocks)].some(
            ({ node }) =>
              'type' in node &&
              ((where.inNote &&
                (node.type === 'admonition' || node.type === 'safety')) ||
                (where.inTable && node.type === 'table')),
          );
          if (forbidden) return undefined;
          const at = (b: Block) =>
            `${target}.dita#${topicIdOf(target)}/${b.id}`;
          const first = blocks[0] as Block;
          const last = blocks[blocks.length - 1] as Block;
          return el(
            stub.name,
            {
              conref: at(first),
              conrefend: last === first ? undefined : at(last),
              // The import reads it back as the module reference (`MODULE_REF_CLASS`).
              // With the first block's own (a code block's language), which a content reference's attributes would override.
              outputclass:
                first.type === 'literal' && first.language
                  ? `${MODULE_REF_CLASS} language-${first.language}`
                  : MODULE_REF_CLASS,
            },
            stubChildren(stub.name),
          );
        },
        inline: (ref) => {
          report.add(
            'module-reference-resolved',
            { module: id, block: ref.id },
            `A content reference to "${ref.module}" cannot stand here (a note or table it holds would be inside another); its content is put in.`,
          );
          const copy = prefixed(expanded.get(ref.module) ?? [], ref.id);
          let count = 0;
          for (const _ of walk(copy)) count++;
          spend(count, 0);
          return copy;
        },
      };
      const { type, outputclass } = topicTypeFor(module.meta.type, config);
      const rootAttrs: [string, string][] = [['xml:lang', module.meta.lang]];
      if (module.meta.audience !== undefined) {
        const audience = profiling.audience(module.meta.audience);
        if (audience) rootAttrs.push([audience[0], audience[1]]);
        else {
          report.add(
            'metadata',
            { module: id },
            `The audience "${module.meta.audience}" has no DITA value in the mapping (\`dita.profiling\`); it is left out.`,
          );
        }
      }
      if (outputclass !== undefined)
        rootAttrs.push(['outputclass', outputclass]);
      const writer = new TopicWriter(ctx, module);
      const { root, written: wroteAs } = writer.write(
        type,
        expanded.get(id) ?? [],
        rootAttrs,
      );
      // Its characters before escaping now (a lower bound, so a topic past the bound is never written),
      // the rest as it is written (`write`).
      const size = cost(root);
      spend(size.nodes, size.chars);
      raw.set(id, size.chars);
      anchors.set(id, writer.anchors);
      sectionTopics.set(id, writer.topics);
      trees.set(id, { root, type: wroteAs });
      for (const link of own) links.push({ link, from: id });
    }

    // Cross-references: into a topic of the package, else their text.
    for (const { link, from } of links) {
      const { element, module, block } = link;
      if (!written.has(module)) {
        report.add(
          'xref-outside',
          { module: from },
          `A cross-reference to "${module}", which is not in the manual, is its text.`,
        );
        element.name = 'ph';
        element.attrs.length = 0;
        if ((element as unknown as El).children.length === 0) {
          (element as unknown as { children: El['children'] }).children = [
            load(module)?.meta.title ?? module,
          ];
        }
        continue;
      }
      const topic = topicIdOf(module);
      const holder =
        block === undefined ? undefined : anchors.get(module)?.get(block);
      const ownTopic =
        block === undefined ? undefined : sectionTopics.get(module)?.get(block);
      const fragment =
        ownTopic ??
        (block === undefined || holder === undefined
          ? topic
          : `${holder}/${block}`);
      element.attrs.push(['href', `${module}.dita#${fragment}`]);
    }

    for (const [id, { root, type }] of trees) {
      const text = ditaFile(
        root,
        { publicId: DOCTYPES[type], systemId: SYSTEM_IDS[type] },
        charged(raw.get(id) ?? 0),
      );
      addFile({ path: `${lang}/${id}.dita`, text });
      topics++;
    }

    // The map.
    const condition = (
      when: Condition | undefined,
    ): ReadonlyArray<readonly [string, string]> => {
      if (when === undefined) return [];
      const { attrs, fidelity } = profiling.attributes(when);
      if (fidelity !== 'exact') {
        report.add(
          fidelity === 'shipped'
            ? 'condition-shipped'
            : 'condition-approximated',
          { module: manifest.id },
          fidelity === 'shipped'
            ? 'An entry’s condition is written as the values the manual’s shipped variants hold.'
            : 'An entry’s condition has no form as DITA filter attributes; it is written as the values of the variants it holds in, which a DITAVAL file includes in more variants than the condition does.',
        );
      }
      return attrs;
    };
    const mapEntries = (entries: readonly ManifestEntry[]): El[] =>
      entries.flatMap((entry): El[] => {
        if ('module' in entry) {
          if (!written.has(entry.module) || !inManual.includes(entry.module))
            return [];
          return [
            withAttrs(
              el('topicref', { href: `${entry.module}.dita` }),
              condition(entry.when),
            ),
          ];
        }
        const children = mapEntries(entry.entries);
        if (children.length === 0) return [];
        return [
          withAttrs(
            el('topichead', {}, [
              el('topicmeta', {}, [
                el('navtitle', {}, [textIn(entry.title, lang, source)]),
              ]),
              ...children,
            ]),
            condition(entry.when),
          ),
        ];
      });
    const keydefs: El[] = [];
    for (const attribute of Object.keys(manifest.attributes).sort()) {
      const values = input.variants.map((v) =>
        attributeValue(manifest.attributes[attribute], v, versionAttributes),
      );
      if (new Set(values).size > 1) {
        report.add(
          'text-attribute-variants',
          { module: manifest.id },
          `The text attribute "${attribute}" differs between the variants exported; the key holds the first variant's value.`,
        );
      }
      const value = values[0];
      if (value === undefined) continue;
      keydefs.push(
        el('keydef', { keys: keyOf(attribute) }, [
          el('topicmeta', {}, [
            el('keywords', {}, [el('keyword', {}, [value])]),
          ]),
        ]),
      );
    }
    const mapAttrs: [string, string][] = [['xml:lang', lang]];
    if (manifest.audience !== undefined) {
      const audience = profiling.audience(manifest.audience);
      if (audience) mapAttrs.push([audience[0], audience[1]]);
    }
    const map = withAttrs(
      el('map', { id: topicIdOf(manifest.id) }, [
        el('title', {}, [textIn(manifest.title, lang, source)]),
        ...ditavals.map((path) => el('ditavalref', { href: `../${path}` })),
        ...keydefs,
        ...mapEntries(manifest.entries),
      ]),
      mapAttrs,
    );
    const mapSize = cost(map);
    spend(mapSize.nodes, mapSize.chars);
    const text = ditaFile(
      map,
      { publicId: DOCTYPES.map, systemId: SYSTEM_IDS.map },
      charged(mapSize.chars),
    );
    addFile({ path: `${lang}/${manifest.id}.ditamap`, text });
  }
  report.lang = undefined;

  return {
    files: [...files.values()].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    ),
    warnings: report.list(),
    warningsDropped: report.truncated,
    topics,
  };
}

export type { DitaExportWarning, DitaExportWarningCode };
