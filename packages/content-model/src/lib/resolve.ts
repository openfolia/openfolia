import type { Block, Callout, Image, Item, Safety } from './blocks.js';
import { noticeLevels, noticeRuleOf } from './derive.js';
import { walk } from './walk.js';
import { blockPlaces, type BlockPlace } from './block-places.js';
import {
  Expansion,
  ExpansionTooLargeError,
  MAX_EXPANDED_CHARS,
  MAX_EXPANDED_NODES,
  MAX_EXPANDED_TABLE_CELLS,
  MAX_NESTING_DEPTH,
} from './expansion.js';
import { calloutNumbers, imagesById } from './callouts.js';
import type { ProjectConfig } from './config.js';
import type { CalloutRef, Inline } from './inline.js';
import type { AttributeValue, Manifest, ManifestEntry } from './manifest.js';
import type { Module } from './module.js';
import { resolveOutputLabels } from './labels.js';
import { languageDirection, type TextDirection } from './direction.js';
import { normalizeInline } from './normalize.js';
import { evaluateCondition, type VariantValues } from './variant.js';
import type { Condition } from './condition.js';
import type { Term, TermDefinition, TermStatus } from './term.js';
import { linkedTermIds } from './term-links.js';
import { crossReferencedModules } from './module-references.js';
import { textIn } from './localized-text.js';
import { byVersionAndPhase, type UpdatePhase } from './update-guide.js';

export interface ResolveInput {
  manifest: Manifest;
  variant: VariantValues;
  lang: string;
  config: ProjectConfig;
  /** Loads a module in a language; returns undefined when that file does not exist. */
  loadModule: (id: string, lang: string) => Module | undefined;
  /**
   * Whether the reader may see a module (e.g. their roles' scope). One it
   * may not is left out before anything else is checked or reported about
   * it, with an `outside-scope` issue. Default: every module.
   */
  visible?: (module: Module) => boolean;
  /**
   * Loads a term (`terms/<id>.yaml`); undefined when there is none (or its
   * file cannot be read). Default: none, so no term link has a term.
   */
  loadTerm?: (id: string) => Term | undefined;
}

/**
 * A term the manual links (#245), in the manual's language or, when the
 * term has none, in the source language (`lang` says which, as a module's
 * entry does): what a term link shows and the glossary lists.
 */
export interface ResolvedTerm {
  id: string;
  /** The language `preferred` and `definition` are in. */
  lang: string;
  preferred: string;
  definition?: TermDefinition;
  status: TermStatus;
}

/**
 * One manual for one variant, language and audience: conditions applied,
 * module references inlined, text attributes filled in (one without a
 * value stays an `attribute` node, reported as an issue). Block IDs are
 * qualified with their module (`module--block`) so they are unique across
 * the manual; `origins` maps them back.
 */
export interface ResolvedManual {
  id: string;
  title: string;
  lang: string;
  variant: VariantValues;
  entries: ResolvedEntry[];
  /** Output block ID → the module and block it came from. */
  origins: Record<string, { module: string; block: string }>;
  /** `module` or `module#block` → the output ID to link to (first occurrence). */
  anchors: Record<string, string>;
  /**
   * The terms the manual's content links, as `loadTerm` gives them, in the
   * manual's language or its fallback: alphabetical by the preferred variant
   * in the manual's language (`Intl.Collator`), ties by ID. A term link
   * whose term is not here (none, or in neither language) is plain text.
   * `resolveManual` always sets it; absent (a manual made by hand): none.
   */
  terms?: ResolvedTerm[];
  /** The manifest asks for a glossary (`glossary: true`): the renderers add one listing `terms`. */
  glossary?: boolean;
  /**
   * The text direction of each language the manual holds (its own and the source language a
   * missing translation falls back to), from the configuration (`languageDirection`).
   * `resolveManual` always sets it; a language not listed (a manual made by hand) takes its
   * script's (`directionOf`).
   */
  directions?: Readonly<Record<string, TextDirection>>;
  /**
   * Callout numbers (#498): output image ID → callout ID → its number in
   * this variant. Each image's `callouts` in the manual are the ones the
   * variant shows, in number order (without their conditions, and with
   * `calloutOrder: 'manual'`, so `numberCallouts` gives the same numbers),
   * and a callout reference names its image by output ID. A reference
   * whose callout is hidden or missing keeps its own IDs and has no number
   * here (reported as `hidden-callout` or `unknown-callout`).
   * `calloutNumber` reads it. `resolveManual` always sets it; absent: none.
   */
  callouts?: Record<string, Record<string, number>>;
  /**
   * The title of each module a cross-reference links to that is no entry of the manual (one
   * outside it, or one it holds only through a module reference), by module ID, in the
   * manual's language or its fallback (#796): what a cross-reference without its own text
   * reads as, instead of the module's ID. Only modules the reader may see (`visible`) and the
   * manual's audience allows; any other one keeps its ID. `resolveManual` always sets it;
   * absent (a manual made by hand): none.
   */
  xrefTitles?: Record<string, string>;
  /**
   * An update guide's steps (#906), as `entries` holds them: per step the reader may see (its
   * module resolved), in the PDF's order (by version, then phase, then manifest order), with what
   * the step says of itself and its module entry (the same object as in `entries`). Set only for
   * an update guide.
   */
  updateSteps?: ResolvedUpdateStep[];
}

/** A step of a resolved update guide (#906, `ResolvedManual.updateSteps`). */
export interface ResolvedUpdateStep {
  /** Its place among the guide's steps (manifest order), from 0. */
  index: number;
  version: string;
  phase: UpdatePhase;
  level?: string;
  when?: Condition;
  entry: Extract<ResolvedEntry, { kind: 'module' }>;
}

export type ResolvedEntry =
  | {
      kind: 'module';
      module: string;
      title: string;
      lang: string;
      blocks: Block[];
    }
  | { kind: 'group'; title: string; entries: ResolvedEntry[] };

/** The image a callout reference names in a resolved manual when its callout has no number there. */
export const UNRESOLVED_CALLOUT_IMAGE = '_';

export interface ResolveIssue {
  severity: 'error' | 'warning';
  code:
    | 'missing-module'
    | 'missing-translation'
    | 'module-cycle'
    | 'above-audience'
    | 'unknown-audience'
    /** Left out: the reader may not see the module (`ResolveInput.visible`). */
    | 'outside-scope'
    | 'missing-variant-attribute'
    | 'missing-text-attribute'
    | 'xref-outside-manual'
    | 'xref-unknown-block'
    /**
     * A module reference to one block of a module (#223) names a block that module does not
     * have (`target` names both); nothing is included in its place.
     */
    | 'module-ref-unknown-block'
    /** A callout reference to an image or callout of its module that this variant leaves out. */
    | 'hidden-callout'
    /** A callout reference to an image or callout its module does not have. */
    | 'unknown-callout'
    /** The configuration and the shipped defaults have no output label in the manual's language; English is used. */
    | 'missing-label'
    /** Reported by loaders (not by resolveManual): a module file exists but cannot be read. */
    | 'invalid-module'
    /**
     * The manual expands past `MAX_EXPANDED_NODES` or `MAX_EXPANDED_CHARS`, or its blocks and
     * module references nest deeper than `MAX_NESTING_DEPTH` (#679): nothing of it is
     * resolved, and it is the only issue.
     */
    | 'expansion-too-large';
  message: string;
  module?: string;
  /**
   * Where in the content it was found, when that is a block: the module the
   * block is in (for a module reference, the referring module, not the one
   * referred to) and the block's (or list item's) own ID, unqualified.
   */
  at?: IssueAt;
  /**
   * What a cross-reference links to (`xref-outside-manual`, `xref-unknown-block`), or the block
   * a module reference to one block names (`module-ref-unknown-block`).
   */
  target?: { module: string; block?: string };
}

/** A block of a module, by their own IDs. */
export interface IssueAt {
  module: string;
  block: string;
}

/**
 * Content a condition left out for this variant: what a preview lists as
 * hidden. Only the outermost hidden content is listed (nothing inside it),
 * each once, in document order, and only what the reader may see (`visible`,
 * the manual's audience): a module entry left out by its condition is listed
 * only when the reader could otherwise read the module.
 */
export type HiddenContent =
  | {
      /** A variant block of a module the manual includes. */
      kind: 'block';
      module: string;
      /** The variant block's own ID, unqualified. */
      block: string;
      when: Condition;
      /** The variant block's content, unresolved (for a label). */
      blocks: Block[];
    }
  | {
      /** A module entry of the manifest. */
      kind: 'module';
      module: string;
      /** The module's title, in the manual's language or its fallback. */
      title: string;
      when: Condition;
    }
  | {
      /** A group of the manifest, with everything in it. */
      kind: 'group';
      title: string;
      when: Condition;
    };

export interface ResolveResult {
  manual: ResolvedManual;
  issues: ResolveIssue[];
  /** What the variant's conditions left out (see `HiddenContent`). */
  hidden: HiddenContent[];
}

/**
 * What one inclusion of a module (an entry, or a module reference) needs to
 * number its callout references: its own images, as resolved, and the
 * references met, numbered once all of the module's blocks are resolved
 * (a reference may come before its image).
 */
interface CalloutScope {
  module: Module;
  images: Map<string, { outputId: string; numbers: Map<string, number> }>;
  refs: { node: CalloutRef; at: IssueAt }[];
}

export function resolveManual(input: ResolveInput): ResolveResult {
  const { manifest, variant, lang, config, loadModule, visible, loadTerm } =
    input;
  const issues: ResolveIssue[] = [];
  const origins: ResolvedManual['origins'] = {};
  const anchors: ResolvedManual['anchors'] = {};
  const versionAttributes = new Set(
    config.variantAttributes
      .filter((a) => a.kind === 'version')
      .map((a) => a.id),
  );
  const hidden: HiddenContent[] = [];
  const hiddenKeys = new Set<string>();
  const hide = (key: string, content: HiddenContent) => {
    if (hiddenKeys.has(key)) return;
    hiddenKeys.add(key);
    hidden.push(content);
  };
  const calloutTable: Record<string, Record<string, number>> = {};
  const reported = new Set<string>();
  const report = (issue: ResolveIssue) => {
    const at = issue.at ? `${issue.at.module}#${issue.at.block}` : '';
    const key = `${issue.code}|${issue.module ?? ''}|${at}|${issue.message}`;
    if (!reported.has(key)) issues.push(issue);
    reported.add(key);
  };

  // Audience filtering fails closed: an audience that is not configured
  // never lets content through.
  /** Position in the configured order (0 = least restricted); undefined if not configured. */
  const audienceRank = (id: string | undefined): number | undefined => {
    if (id === undefined) return config.audiences.length - 1;
    const rank = config.audiences.findIndex((a) => a.id === id);
    return rank === -1 ? undefined : rank;
  };
  let maxAudience = Infinity;
  if (manifest.audience !== undefined) {
    const rank = audienceRank(manifest.audience);
    if (rank === undefined) {
      report({
        severity: 'error',
        code: 'unknown-audience',
        message: `the manual's audience "${manifest.audience}" is not configured; every module is left out`,
      });
    }
    maxAudience = rank ?? -1;
  }

  const matches = (
    condition: Condition | undefined,
    module?: string,
    block?: string,
  ) =>
    condition === undefined ||
    evaluateCondition(condition, variant, {
      versionAttributes,
      onMissing: (attr) =>
        report({
          severity: 'error',
          code: 'missing-variant-attribute',
          message: `the variant does not set "${attr}", which a condition uses; tests on it are unknown, and content whose condition is unknown is left out`,
          ...(module ? { module } : {}),
          ...(module && block ? { at: { module, block } } : {}),
        }),
    });

  // Text attribute values for this variant.
  const textValues = new Map<string, string>();
  for (const [name, value] of Object.entries(manifest.attributes)) {
    const resolved = attributeValue(value, (when) => matches(when));
    if (resolved !== undefined) textValues.set(name, resolved);
  }

  const seen = (module: Module | undefined) =>
    module !== undefined && (!visible || visible(module));
  /**
   * What `load` finds for a module, looked up once per resolution (#679): one resolution has
   * one variant, language and reader (`visible`), so a module's lookup is the same wherever
   * it is referred to. Never kept past the call.
   */
  type Lookup =
    | { kind: 'own' | 'fallback' | 'hidden'; module: Module }
    | { kind: 'missing' };
  const lookups = new Map<string, Lookup>();
  const lookup = (id: string): Lookup => {
    const known = lookups.get(id);
    if (known) return known;
    const module = loadModule(id, lang);
    let found: Lookup;
    if (seen(module)) found = { kind: 'own', module: module as Module };
    else {
      // A translation the reader may not see counts as missing: the fallback
      // is used if the reader may see it, exactly as if there were none.
      const fallback =
        lang === config.languages.source
          ? undefined
          : loadModule(id, config.languages.source);
      const either = module ?? fallback;
      found = seen(fallback)
        ? { kind: 'fallback', module: fallback as Module }
        : either
          ? { kind: 'hidden', module: either }
          : { kind: 'missing' };
    }
    lookups.set(id, found);
    return found;
  };
  const load = (id: string, at?: IssueAt): Module | undefined => {
    const found = lookup(id);
    if (found.kind === 'own') return found.module;
    if (found.kind === 'fallback') {
      report({
        severity: 'warning',
        code: 'missing-translation',
        message: `no "${lang}" translation; using "${found.module.meta.lang}"`,
        module: id,
      });
      return found.module;
    }
    // Hidden (here or in the source language): `allowed` reports it as
    // outside the scope, and nothing else about it.
    if (found.kind === 'hidden') return found.module;
    report({
      severity: 'error',
      code: 'missing-module',
      message: `module "${id}" does not exist`,
      module: id,
      ...(at ? { at } : {}),
    });
    return undefined;
  };

  /**
   * `allowed`'s answers, by module (one per ID, `lookup`): what it reports, it reports the
   * first time.
   */
  const allowedModules = new Map<string, boolean>();
  const allowed = (module: Module): boolean => {
    let answer = allowedModules.get(module.id);
    if (answer === undefined) {
      answer = allows(module);
      allowedModules.set(module.id, answer);
    }
    return answer;
  };
  const allows = (module: Module): boolean => {
    // First: nothing else about a module the reader may not see is reported.
    if (visible && !visible(module)) {
      report({
        severity: 'warning',
        code: 'outside-scope',
        message: 'left out: outside what the reader may see',
        module: module.id,
      });
      return false;
    }
    const rank = audienceRank(module.meta.audience);
    if (rank === undefined) {
      report({
        severity: 'error',
        code: 'unknown-audience',
        message: `left out: audience "${module.meta.audience}" is not configured`,
        module: module.id,
      });
      return false;
    }
    if (rank <= maxAudience) return true;
    report({
      severity: 'warning',
      code: 'above-audience',
      message: `left out: audience "${module.meta.audience ?? 'default (most restricted)'}" is above "${manifest.audience}"`,
      module: module.id,
    });
    return false;
  };

  /** What the manual has expanded to so far, held to the limits of #679 (`Expansion`). */
  const expansion = new Expansion();
  const grow = (nodes: number, chars = 0) => expansion.grow(nodes, chars);
  const weigh = (module: Module) => expansion.weigh(module);
  const nested = <T>(go: () => T): T => expansion.nested(go);
  /**
   * Per module, its blocks by ID (`blockPlaces`), for the module references to one block of it
   * (#223): worked out once per module and resolution, however often its blocks are included.
   */
  const placesByModule = new Map<Module, ReadonlyMap<string, BlockPlace>>();
  /**
   * The block a module reference to one block of `module` names (#223), when this variant shows
   * it: one the module does not have is `module-ref-unknown-block`; one inside a variant block
   * the variant leaves out is not included, and the outermost such variant block is listed in
   * `hidden` (when `listHidden` says its blocks are worth listing).
   */
  const reachBlock = (
    module: Module,
    id: string,
    at: IssueAt,
    listHidden: (blocks: readonly Block[]) => boolean = () => true,
  ): Block | undefined => {
    let places = placesByModule.get(module);
    if (!places) {
      places = blockPlaces(module.blocks);
      placesByModule.set(module, places);
    }
    const place = places.get(id);
    if (!place) {
      report({
        severity: 'error',
        code: 'module-ref-unknown-block',
        message: `refers to the block "${id}" of "${module.id}", which does not exist`,
        module: module.id,
        at,
        target: { module: module.id, block: id },
      });
      return undefined;
    }
    for (const variant of place.within) {
      if (matches(variant.when, module.id, variant.id)) continue;
      if (listHidden(variant.blocks)) {
        hide(`block|${module.id}#${variant.id}`, {
          kind: 'block',
          module: module.id,
          block: variant.id,
          when: variant.when,
          blocks: variant.blocks,
        });
      }
      return undefined;
    }
    return place.block;
  };
  /**
   * Per `module--block`, the suffix its next copy tries first: `origins` only grows, so a
   * suffix taken once stays taken, and each copy starts where the last stopped (#679: a block
   * included once per path is qualified in time linear in its copies).
   */
  const nextCopy = new Map<string, number>();
  /** `content`: false for a block a link to the whole module should not land on (a page break). */
  const qualify = (module: string, block: string, content = true): string => {
    const base = `${module}--${block}`;
    let id = base;
    if (id in origins) {
      let n = nextCopy.get(base) ?? 2;
      while (`${base}--${n}` in origins) n++;
      id = `${base}--${n}`;
      nextCopy.set(base, n + 1);
    }
    origins[id] = { module, block };
    anchors[`${module}#${block}`] ??= id;
    // A module placed one block at a time is not in the manual for a link to it (#223).
    if (content && !placingPart.has(module)) anchors[module] ??= id;
    return id;
  };
  /** The modules one block of which is being placed now (#223): never nested in themselves. */
  const placingPart = new Set<string>();
  /** The modules of which a manual holds one block or more, by references to one block (#223). */
  const placedInPart = new Set<string>();

  const inline = <T extends Inline>(
    nodes: readonly T[],
    module: string,
    block: string,
    scope: CalloutScope,
  ): T[] =>
    normalizeInline(
      nodes.map((node) => {
        if (node.type === 'calloutRef') {
          // A copy of its own: numbered (its image's output ID) when the module is done.
          const ref: CalloutRef = { ...node };
          scope.refs.push({ node: ref, at: { module, block } });
          return ref as T;
        }
        if (node.type !== 'attribute') return node;
        const value = textValues.get(node.name);
        if (value !== undefined) grow(0, value.length);
        if (value === undefined) {
          report({
            severity: 'error',
            code: 'missing-text-attribute',
            message: `no value for {${node.name}} in this variant`,
            module,
            at: { module, block },
          });
        }
        // One without a value stays a reference, for a renderer to show
        // (the editor's preview as a chip, others as `{name}`).
        return value === undefined
          ? node
          : { type: 'text' as const, text: value };
      }) as T[],
    );

  const resolveBlocks = (
    blocks: readonly Block[],
    module: string,
    stack: readonly string[],
    scope: CalloutScope,
  ): Block[] =>
    nested(() =>
      blocks.flatMap((block): Block[] => {
        if (block.type === 'variant') {
          if (matches(block.when, module, block.id))
            return resolveBlocks(block.blocks, module, stack, scope);
          hide(`block|${module}#${block.id}`, {
            kind: 'block',
            module,
            block: block.id,
            when: block.when,
            blocks: block.blocks,
          });
          return [];
        }
        if (block.type === 'moduleRef') {
          return include(
            block.module,
            stack,
            { module, block: block.id },
            block.block,
          );
        }
        return [resolveBlock(block, module, stack, scope)];
      }),
    );

  /** A module's blocks, its callout references numbered. */
  const resolveModule = (module: Module, stack: readonly string[]): Block[] => {
    weigh(module);
    const scope: CalloutScope = { module, images: new Map(), refs: [] };
    const blocks = resolveBlocks(module.blocks, module.id, stack, scope);
    numberCalloutRefs(scope);
    return blocks;
  };

  const numberCalloutRefs = (scope: CalloutScope): void => {
    let own: Map<string, Image> | undefined;
    for (const { node, at } of scope.refs) {
      const image = scope.images.get(node.block);
      if (image?.numbers.has(node.callout)) {
        node.block = image.outputId;
        continue;
      }
      own ??= imagesById(scope.module.blocks);
      const exists = own
        .get(node.block)
        ?.callouts?.some((c) => c.id === node.callout);
      const named = node.block;
      // `_`: a valid block ID that no output ID is (those are `<module>--<block>`), so it reads
      // as no number; its own ID could equal another module's output ID (`front--img`).
      node.block = UNRESOLVED_CALLOUT_IMAGE;
      report(
        exists
          ? {
              severity: 'warning',
              code: 'hidden-callout',
              message: `refers to the callout "${node.callout}" on "${named}", which this variant leaves out`,
              module: at.module,
              at,
            }
          : {
              severity: 'error',
              code: 'unknown-callout',
              message: `refers to the callout "${node.callout}" on "${named}", which does not exist`,
              module: at.module,
              at,
            },
      );
    }
  };

  /**
   * What a module reference places: module `id` whole, or with `block` (#223) only that block of
   * it, its variants applied. A cycle is one of modules: a reference to one block of a module on
   * the way here (the referring module itself included) is one, whichever block it names.
   */
  const include = (
    id: string,
    stack: readonly string[],
    at: IssueAt,
    block?: string,
  ): Block[] => {
    grow(1);
    if (stack.includes(id)) {
      const message = `module reference cycle: ${[...stack, id].join(' → ')}`;
      // Each path round is an issue of its own: its message counts as text.
      grow(0, message.length);
      report({
        severity: 'error',
        code: 'module-cycle',
        message,
        module: id,
        at,
      });
      return [];
    }
    const module = load(id, at);
    if (!module || !allowed(module)) return [];
    if (block === undefined) return resolveModule(module, [...stack, id]);
    const target = reachBlock(module, block, at);
    return target ? resolveOneBlock(module, target, [...stack, id]) : [];
  };

  /** One block of a module (#223), as its module's inclusion would give it, counted on its own. */
  const resolveOneBlock = (
    module: Module,
    block: Block,
    stack: readonly string[],
  ): Block[] => {
    expansion.weighBlock(block);
    const scope: CalloutScope = { module, images: new Map(), refs: [] };
    placingPart.add(module.id);
    placedInPart.add(module.id);
    try {
      const blocks = resolveBlocks([block], module.id, stack, scope);
      numberCalloutRefs(scope);
      return blocks;
    } finally {
      placingPart.delete(module.id);
    }
  };

  const resolveItem = (
    item: Item,
    module: string,
    stack: readonly string[],
    scope: CalloutScope,
  ): Item => ({
    id: qualify(module, item.id),
    content: inline(item.content, module, item.id, scope),
    blocks: resolveBlocks(item.blocks, module, stack, scope),
  });

  /** An image with the callouts the variant shows, in number order. */
  const resolveImage = (
    block: Image,
    id: string,
    module: string,
    scope: CalloutScope,
  ): Image => {
    const { title, callouts, ...rest } = block;
    delete rest.calloutOrder;
    const numbers = calloutNumbers(block, (when) =>
      matches(when, module, block.id),
    );
    const shown = (callouts ?? [])
      .filter((c) => numbers.has(c.id))
      .sort((a, b) => (numbers.get(a.id) ?? 0) - (numbers.get(b.id) ?? 0))
      .map((callout): Callout => {
        const out: Callout = {
          ...callout,
          legend: inline(callout.legend, module, block.id, scope),
        };
        delete out.when;
        return out;
      });
    scope.images.set(block.id, { outputId: id, numbers });
    const table: Record<string, number> = Object.create(null) as Record<
      string,
      number
    >;
    for (const [callout, number] of numbers) table[callout] = number;
    calloutTable[id] = table;
    return {
      ...rest,
      id,
      ...(title ? { title: inline(title, module, block.id, scope) } : {}),
      ...(shown.length > 0
        ? { callouts: shown, calloutOrder: 'manual' as const }
        : {}),
    };
  };

  const resolveBlock = (
    block: Exclude<Block, { type: 'variant' | 'moduleRef' }>,
    module: string,
    stack: readonly string[],
    scope: CalloutScope,
  ): Block => {
    const id = qualify(module, block.id, block.type !== 'pageBreak');
    switch (block.type) {
      case 'paragraph':
        return {
          ...block,
          id,
          content: inline(block.content, module, block.id, scope),
        };
      case 'section':
        return {
          ...block,
          id,
          title: inline(block.title, module, block.id, scope),
          blocks: resolveBlocks(block.blocks, module, stack, scope),
        };
      case 'list':
        return {
          ...block,
          id,
          items: block.items.map((i) => resolveItem(i, module, stack, scope)),
        };
      case 'procedure':
        return {
          ...block,
          id,
          ...(block.title
            ? { title: inline(block.title, module, block.id, scope) }
            : {}),
          steps: block.steps.map((i) => resolveItem(i, module, stack, scope)),
        };
      case 'table':
        return {
          ...block,
          id,
          ...(block.title
            ? { title: inline(block.title, module, block.id, scope) }
            : {}),
          rows: block.rows.map((row) => ({
            cells: row.cells.map((cell) => ({
              ...cell,
              blocks: resolveBlocks(cell.blocks, module, stack, scope),
            })),
          })),
        };
      case 'image':
        return resolveImage(block, id, module, scope);
      case 'safety':
        return {
          ...block,
          id,
          hazard: inline(block.hazard, module, block.id, scope),
          blocks: resolveBlocks(block.blocks, module, stack, scope),
        };
      case 'faq':
        return {
          ...block,
          id,
          question: inline(block.question, module, block.id, scope),
          blocks: resolveBlocks(block.blocks, module, stack, scope),
        };
      case 'admonition':
        return {
          ...block,
          id,
          blocks: resolveBlocks(block.blocks, module, stack, scope),
        };
      case 'attachment':
      case 'literal':
      case 'passthrough':
      case 'pageBreak':
        return { ...block, id };
      default:
        return block satisfies never;
    }
  };

  /**
   * A manifest entry its condition left out. A module is listed only when the
   * reader could read it here (visible, in the language or its fallback, and
   * within the manual's audience), and nothing is reported about it.
   */
  const hideEntry = (entry: ManifestEntry, when: Condition) => {
    if ('entries' in entry) {
      hide(`group|${hidden.length}`, {
        kind: 'group',
        title: textIn(entry.title, lang, config.languages.source),
        when,
      });
      return;
    }
    const found = lookup(entry.module);
    if (found.kind !== 'own' && found.kind !== 'fallback') return;
    const { module } = found;
    const rank = audienceRank(module.meta.audience);
    if (rank === undefined || rank > maxAudience) return;
    hide(`module|${entry.module}`, {
      kind: 'module',
      module: entry.module,
      title: module.meta.title,
      when,
    });
  };

  // A derived manual gathering notices (#670): its gathered modules give their safety
  // messages only, its front and back matter themselves.
  const notices = noticeRuleOf(manifest);
  const levels = new Set(notices ? noticeLevels(notices) : []);
  const rule = manifest.rule;
  const whole = new Set(notices && rule ? [...rule.front, ...rule.back] : []);
  /** The notices gathered so far (`module#block`): one reached again is not repeated. */
  const gathered = new Set<string>();
  /** What the modules searched for notices hold besides (`module#block`): a link to it is outside the manual. */
  const passedOver = new Set<string>();
  /**
   * The modules searched for notices so far (#679). One searched again (another path to it)
   * has nothing left to give: its notices, and those of the modules it refers to, are
   * gathered already, and each is given once.
   */
  const searched = new Set<string>();

  /** Whether blocks hold a safety message of a gathered level, the variant's or not. */
  const holdsNotice = (blocks: readonly Block[]): boolean => {
    // Asked again for each reference to one block inside a hidden variant (#223): once each.
    const known = noticeHolders.get(blocks);
    if (known !== undefined) return known;
    let holds = false;
    for (const { node } of walk(blocks)) {
      if (
        'type' in node &&
        node.type === 'safety' &&
        levels.has(node.severity)
      ) {
        holds = true;
        break;
      }
    }
    noticeHolders.set(blocks, holds);
    return holds;
  };
  const noticeHolders = new WeakMap<readonly Block[], boolean>();

  /**
   * A module's safety messages of the gathered levels, in document order, wherever they are in
   * it (sections, lists, steps, tables, notes), through the variant blocks this variant shows
   * and the module references it holds (to the modules the reader may see, as `include`), each
   * once, resolved as anywhere (IDs `module--block`, the module that holds it).
   */
  const resolveNotices = (
    module: Module,
    stack: readonly string[],
    only?: Block,
  ): Block[] => {
    // One block of it (#223): searched each time, counted as included (its notices are given
    // once all the same); the whole module once.
    if (only) {
      expansion.weighBlock(only);
    } else {
      if (searched.has(module.id)) return [];
      searched.add(module.id);
      weigh(module);
    }
    const own = only ? [only] : module.blocks;
    const scope: CalloutScope = { module, images: new Map(), refs: [] };
    for (const { node } of walk(own)) {
      passedOver.add(`${module.id}#${node.id}`);
    }
    const found: Block[] = [];
    const visit = (blocks: readonly Block[]): void =>
      nested(() => {
        for (const block of blocks) {
          if (block.type === 'variant') {
            if (matches(block.when, module.id, block.id)) visit(block.blocks);
            else if (holdsNotice(block.blocks)) {
              hide(`block|${module.id}#${block.id}`, {
                kind: 'block',
                module: module.id,
                block: block.id,
                when: block.when,
                blocks: block.blocks,
              });
            }
          } else if (block.type === 'moduleRef') {
            const at = { module: module.id, block: block.id };
            if (stack.includes(block.module)) {
              include(block.module, stack, at);
              continue;
            }
            grow(1);
            const referred = load(block.module, at);
            if (!referred || !allowed(referred)) continue;
            const one =
              block.block === undefined
                ? undefined
                : reachBlock(referred, block.block, at, holdsNotice);
            if (block.block !== undefined && !one) continue;
            found.push(
              ...resolveNotices(referred, [...stack, block.module], one),
            );
          } else if (block.type === 'safety') {
            const key = `${module.id}#${block.id}`;
            if (!levels.has(block.severity) || gathered.has(key)) continue;
            gathered.add(key);
            found.push(resolveBlock(block, module.id, stack, scope));
          } else {
            for (const child of childBlocks(block)) visit(child);
          }
        }
      });
    if (only) {
      // Placed one block at a time, as `resolveOneBlock` places it.
      placingPart.add(module.id);
      placedInPart.add(module.id);
    }
    try {
      visit(own);
    } finally {
      if (only) placingPart.delete(module.id);
    }
    numberCalloutRefs(scope);
    return found;
  };

  const resolveEntries = (entries: readonly ManifestEntry[]): ResolvedEntry[] =>
    entries.flatMap((entry): ResolvedEntry[] => {
      if (!matches(entry.when)) {
        if (entry.when) hideEntry(entry, entry.when);
        return [];
      }
      if ('entries' in entry) {
        const children = resolveEntries(entry.entries);
        return children.length > 0
          ? [
              {
                kind: 'group',
                title: textIn(entry.title, lang, config.languages.source),
                entries: children,
              },
            ]
          : [];
      }
      const module = load(entry.module);
      if (!module || !allowed(module)) return [];
      const blocks =
        notices && !whole.has(module.id)
          ? resolveNotices(module, [module.id])
          : resolveModule(module, [module.id]);
      if (notices && !whole.has(module.id)) {
        if (blocks.length === 0) return [];
        // A link to the module lands on its first notice, its own or a referred module's.
        if (blocks[0]) anchors[module.id] ??= blocks[0].id;
      }
      return [
        {
          kind: 'module',
          module: module.id,
          title: module.meta.title,
          lang: module.meta.lang,
          blocks,
        },
      ];
    });

  const outputLabels = resolveOutputLabels(lang, config.outputLabels);
  const updateSteps: ResolvedUpdateStep[] = [];
  const phaseLabels: Record<UpdatePhase, string> = {
    before: outputLabels.labels.updateBefore,
    during: outputLabels.labels.updateDuring,
    after: outputLabels.labels.updateAfter,
  };
  const assemble = (): ResolvedEntry[] => {
    const guide = manifest.kind === 'update-guide' ? manifest.guide : undefined;
    if (guide) {
      // An update guide (#906): the whole guide, every step whatever its condition
      // (the reader's choice picks among them), a group per version, in it a group per phase.
      // A step's level is an audience level: one above the manual's audience, or not configured,
      // is for no reader of it (fails closed, as an audience does).
      const forReaders = (level: string | undefined) => {
        if (level === undefined) return true;
        const rank = audienceRank(level);
        return rank !== undefined && rank <= maxAudience;
      };
      return byVersionAndPhase(guide.steps).flatMap(
        ({ version, phases }): ResolvedEntry[] => {
          const under = phases.flatMap(({ phase, steps }): ResolvedEntry[] => {
            const modules = steps.flatMap(({ step, index }) =>
              !forReaders(step.level)
                ? []
                : resolveEntries([{ module: step.module }]).flatMap((entry) => {
                    if (entry.kind !== 'module') return [];
                    updateSteps.push({
                      index,
                      version,
                      phase,
                      ...(step.level !== undefined && { level: step.level }),
                      ...(step.when !== undefined && { when: step.when }),
                      entry,
                    });
                    return [entry];
                  }),
            );
            return modules.length > 0
              ? [{ kind: 'group', title: phaseLabels[phase], entries: modules }]
              : [];
          });
          return under.length > 0
            ? [
                {
                  kind: 'group',
                  title: `${outputLabels.labels.updateVersion} ${version}`,
                  entries: under,
                },
              ]
            : [];
        },
      );
    }
    if (notices?.groupBy === 'level' && rule) {
      // A group per level, in the rule's order, titled with its output label; under it, per
      // source module, that module's notices of the level. The front and back matter around them.
      const back = new Set(rule.back);
      const front: ResolvedEntry[] = [];
      const after: ResolvedEntry[] = [];
      const body: Extract<ResolvedEntry, { kind: 'module' }>[] = [];
      for (const entry of manifest.entries) {
        const resolved = resolveEntries([entry]);
        if ('module' in entry && back.has(entry.module))
          after.push(...resolved);
        else if ('module' in entry && whole.has(entry.module))
          front.push(...resolved);
        else for (const r of resolved) if (r.kind === 'module') body.push(r);
      }
      const groups = [...levels].flatMap((level): ResolvedEntry[] => {
        const under = body.flatMap((e) => {
          const blocks = e.blocks.filter(
            (b) => (b as Safety).severity === level,
          );
          return blocks.length > 0 ? [{ ...e, blocks }] : [];
        });
        return under.length > 0
          ? [
              {
                kind: 'group',
                title: outputLabels.labels[level],
                entries: under,
              },
            ]
          : [];
      });
      return [...front, ...groups, ...after];
    }
    return resolveEntries(manifest.entries);
  };
  let entries: ResolvedEntry[];
  try {
    entries = assemble();
  } catch (error) {
    if (!(error instanceof ExpansionTooLargeError)) throw error;
    return tooLarge(input, error.depth);
  }
  checkXrefs(
    entries,
    anchors,
    origins,
    report,
    notices && passedOver,
    placedInPart,
  );
  // What a cross-reference to a module that is no entry reads as (#796): its title. Looked up
  // without a report: a link to a module is no inclusion of it.
  const entryModules = new Set<string>();
  const linked = new Set<string>();
  const visitEntries = (list: readonly ResolvedEntry[]): void => {
    for (const entry of list) {
      if (entry.kind === 'group') visitEntries(entry.entries);
      else {
        entryModules.add(entry.module);
        for (const id of crossReferencedModules(entry.blocks)) linked.add(id);
      }
    }
  };
  visitEntries(entries);
  const xrefTitles: Record<string, string> = {};
  for (const id of linked) {
    if (entryModules.has(id)) continue;
    const found = lookup(id);
    if (found.kind !== 'own' && found.kind !== 'fallback') continue;
    const rank = audienceRank(found.module.meta.audience);
    if (rank === undefined || rank > maxAudience) continue;
    xrefTitles[id] = found.module.meta.title;
  }
  const { missing } = outputLabels;
  if (missing.length > 0) {
    report({
      severity: 'warning',
      code: 'missing-label',
      message: `No output labels in "${lang}" for ${missing.join(', ')}; English is used.`,
    });
  }

  return {
    manual: {
      id: manifest.id,
      title: textIn(manifest.title, lang, config.languages.source),
      lang,
      variant,
      entries,
      origins,
      anchors,
      terms: resolveTerms(entries, lang, config.languages.source, loadTerm),
      glossary: manifest.glossary === true,
      directions: {
        [lang]: languageDirection(lang, config),
        [config.languages.source]: languageDirection(
          config.languages.source,
          config,
        ),
      },
      callouts: calloutTable,
      xrefTitles,
      ...(manifest.kind === 'update-guide' && { updateSteps }),
    },
    issues,
    hidden,
  };
}

/**
 * A manual past one of the limits of #679 (`MAX_EXPANDED_NODES`, `MAX_EXPANDED_CHARS`,
 * `MAX_NESTING_DEPTH`): nothing of it, and one error saying why (what
 * resolving found before it stopped is left out: it would be part of a list).
 */
function tooLarge(
  { manifest, variant, lang, config }: ResolveInput,
  depth: boolean,
): ResolveResult {
  return {
    manual: {
      id: manifest.id,
      title: textIn(manifest.title, lang, config.languages.source),
      lang,
      variant,
      entries: [],
      origins: {},
      anchors: {},
      terms: [],
      glossary: manifest.glossary === true,
      directions: {
        [lang]: languageDirection(lang, config),
        [config.languages.source]: languageDirection(
          config.languages.source,
          config,
        ),
      },
      callouts: {},
      xrefTitles: {},
    },
    issues: [
      {
        severity: 'error',
        code: 'expansion-too-large',
        message: depth
          ? `the manual's blocks and module references nest more than ${MAX_NESTING_DEPTH} deep; nothing of it is resolved`
          : `the manual expands to more than ${MAX_EXPANDED_NODES.toLocaleString('en')} content nodes, ${MAX_EXPANDED_CHARS.toLocaleString('en')} characters or ${MAX_EXPANDED_TABLE_CELLS.toLocaleString('en')} table cells (rows × columns) once its module references are included (a module referred to over several paths counts once per path); nothing of it is resolved`,
      },
    ],
    hidden: [],
  };
}

/**
 * The terms the entries link, each in `lang` or else `source`, sorted as
 * `ResolvedManual.terms` says.
 */
function resolveTerms(
  entries: readonly ResolvedEntry[],
  lang: string,
  source: string,
  loadTerm: ResolveInput['loadTerm'],
): ResolvedTerm[] {
  if (!loadTerm) return [];
  const ids = new Set<string>();
  const visit = (list: readonly ResolvedEntry[]): void => {
    for (const entry of list) {
      if (entry.kind === 'group') visit(entry.entries);
      else for (const id of linkedTermIds(entry.blocks)) ids.add(id);
    }
  };
  visit(entries);
  const terms: ResolvedTerm[] = [];
  for (const id of ids) {
    const term = loadTerm(id);
    if (!term) continue;
    const at = term.languages[lang] ? lang : source;
    const entry = term.languages[at];
    if (!entry) continue;
    terms.push({
      id,
      lang: at,
      preferred: entry.preferred,
      ...(entry.definition !== undefined && { definition: entry.definition }),
      status: term.status,
    });
  }
  const collator = collatorFor(lang);
  return terms.sort(
    (a, b) =>
      collator.compare(a.preferred, b.preferred) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** A collator for `lang`; English for a tag `Intl` does not take. */
function collatorFor(lang: string): Intl.Collator {
  try {
    return new Intl.Collator(lang);
  } catch {
    return new Intl.Collator('en');
  }
}

function attributeValue(
  value: AttributeValue,
  matches: (when: Condition | undefined) => boolean,
): string | undefined {
  if (typeof value === 'string') return value;
  return value.find((option) => matches(option.when))?.value;
}

/** Reports cross-references whose target is not part of this manual. */
function checkXrefs(
  entries: readonly ResolvedEntry[],
  anchors: ResolvedManual['anchors'],
  origins: ResolvedManual['origins'],
  report: (i: ResolveIssue) => void,
  passedOver?: ReadonlySet<string>,
  placedInPart?: ReadonlySet<string>,
): void {
  const visitInline = (
    nodes: readonly Inline[],
    module: string,
    outputId: string,
  ) => {
    const origin = origins[outputId];
    const at = origin
      ? { at: { module: origin.module, block: origin.block } }
      : {};
    for (const node of nodes) {
      if (node.type !== 'xref') continue;
      const target = {
        target: {
          module: node.module,
          ...(node.block !== undefined && { block: node.block }),
        },
      };
      if (node.block && `${node.module}#${node.block}` in anchors) continue;
      if (!(node.module in anchors) && placedInPart?.has(node.module)) {
        // A module the manual holds one block of, not this one (#223).
        report({
          severity: 'warning',
          code: 'xref-outside-manual',
          message: node.block
            ? `links to "${node.module}#${node.block}", which this manual leaves out: it includes only part of "${node.module}"`
            : `links to "${node.module}", which this manual includes only in part`,
          module,
          ...at,
          ...target,
        });
      } else if (!(node.module in anchors)) {
        report({
          severity: 'warning',
          code: 'xref-outside-manual',
          message: `links to "${node.module}", which is not in this manual`,
          module,
          ...at,
          ...target,
        });
      } else if (
        node.block &&
        passedOver?.has(`${node.module}#${node.block}`) &&
        !(`${node.module}#${node.block}` in anchors)
      ) {
        // A block of a module searched for notices that is not one of them (#670).
        report({
          severity: 'warning',
          code: 'xref-outside-manual',
          message: `links to "${node.module}#${node.block}", which this manual does not gather`,
          module,
          ...at,
          ...target,
        });
      } else if (node.block && !(`${node.module}#${node.block}` in anchors)) {
        report({
          severity: 'error',
          code: 'xref-unknown-block',
          message: `links to "${node.module}#${node.block}", which does not exist here`,
          module,
          ...at,
          ...target,
        });
      }
    }
  };
  const visitBlocks = (blocks: readonly Block[], module: string): void => {
    for (const block of blocks) {
      for (const [id, content] of inlineOf(block)) {
        visitInline(content, module, id);
      }
      for (const child of childBlocks(block)) visitBlocks(child, module);
    }
  };
  const visitEntries = (list: readonly ResolvedEntry[]): void => {
    for (const entry of list) {
      if (entry.kind === 'group') visitEntries(entry.entries);
      else visitBlocks(entry.blocks, entry.module);
    }
  };
  visitEntries(entries);
}

/** A block's inline content, each with the ID of the block or item it belongs to. */
function inlineOf(block: Block): [string, Inline[]][] {
  switch (block.type) {
    case 'paragraph':
      return [[block.id, block.content]];
    case 'section':
      return [[block.id, block.title]];
    case 'list':
      return block.items.map((i) => [i.id, i.content]);
    case 'procedure':
      return [
        ...(block.title ? [[block.id, block.title] as [string, Inline[]]] : []),
        ...block.steps.map((i): [string, Inline[]] => [i.id, i.content]),
      ];
    case 'table':
      return block.title ? [[block.id, block.title]] : [];
    case 'image':
      return [
        ...(block.title ? [[block.id, block.title] as [string, Inline[]]] : []),
        ...(block.callouts ?? []).map((c): [string, Inline[]] => [
          block.id,
          c.legend,
        ]),
      ];
    case 'safety':
      return [[block.id, block.hazard]];
    case 'faq':
      return [[block.id, block.question]];
    default:
      return [];
  }
}

function childBlocks(block: Block): Block[][] {
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
