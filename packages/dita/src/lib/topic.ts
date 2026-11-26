import {
  type Block,
  type Condition,
  type DitaMapping,
  type Inline,
  isLinkHref,
  type Item,
  type Mark,
  MAX_KEYWORDS,
  MAX_LIST_DEPTH,
  MAX_SECTION_DEPTH,
  MAX_TABLE_CELLS,
  MAX_TABLE_COLUMNS,
  type Module,
  normalizeInline,
  type ProjectConfig,
  type SafetySeverity,
  type Section,
  type TableCell,
  type TableColumn,
  type TableRow,
  type TextNode,
  type Xref,
} from '@openfolia/content-model';
import type { XmlElement, XmlNode } from '@openfolia/xml';
import {
  baseOf,
  BASE,
  type ExpansionBudget,
  MAX_CONREF_DEPTH,
  MODULE_REF,
} from './conref.js';
import {
  attr,
  child,
  childrenNamed,
  collapse,
  elements,
  isTopic,
  nameOf,
  pushAll,
  textOf,
  tokens,
} from './elements.js';
import { BlockIds } from './ids.js';
import { keyText, type KeySpace, textWithKeys } from './keys.js';
import type { DitaDoc, Project, TopicIndex } from './load.js';
import { baseName, hasScheme, resolvePath, splitReference } from './paths.js';
import {
  leastRestricted,
  type Profiling,
  profileOf,
  filterAttributes,
} from './profiling.js';
import type { DitaReport, DitaReportCode } from './report.js';

/**
 * The most columns a table is imported with (more are left out, reported), and the most cells,
 * padding included (rows past it are left out, reported): the content model's caps (#686), so
 * an imported table is always one the model takes.
 */
export { MAX_TABLE_CELLS, MAX_TABLE_COLUMNS };

/** What converting topics needs from the whole import. */
export interface ImportContext {
  readonly project: Project;
  readonly config: ProjectConfig;
  readonly mapping: DitaMapping;
  readonly profiling: Profiling;
  readonly report: DitaReport;
  /** `sha256:<hash>` of each file of the archive that is no DITA file. */
  readonly assetRefs: ReadonlyMap<string, string>;
  /** The files images use, by asset reference. */
  readonly usedAssets: Set<string>;
  /** Files of the archive read without being imported (a hazard symbol's image), by path. */
  readonly readFiles: Set<string>;
  /** The module a topic is (its file within its language folder, and its ID in a `<dita>` document). */
  moduleOf(path: string, topicId: string | undefined): string | undefined;
  /** Cross-references to blocks, resolved once every module is made. */
  readonly xrefs: XrefFixup[];
}

/** A cross-reference whose block is known once its module is made. */
export interface XrefFixup {
  readonly node: Xref;
  /** The target module's key: its source path (in its language folder) and DITA IDs. */
  readonly rel: string;
  readonly topicId: string;
  readonly elementId: string | undefined;
  readonly place: { source: string; kind: string; module: string };
}

/** Where blocks go. */
interface Scope {
  readonly sectionsAllowed: boolean;
  readonly sectionDepth: number;
  readonly listDepth: number;
  readonly inTable: boolean;
  readonly topic: TopicIndex;
}

/** The elements that hold inline content (phrases), read into a paragraph's text. */
// prettier-ignore
const INLINE = new Set([
  'ph', 'b', 'i', 'u', 'tt', 'sup', 'sub', 'line-through', 'overline', 'q',
  'cite', 'term', 'tm', 'xref', 'text', 'abbreviated-form', 'boolean',
  'state', 'codeph', 'kwd', 'var', 'synph', 'oper', 'delim', 'sep',
  'repsep', 'option', 'parmname', 'apiname', 'filepath', 'msgph', 'msgnum',
  'cmdname', 'varname', 'userinput', 'systemoutput', 'uicontrol',
  'wintitle', 'menucascade', 'shortcut', 'keyword', 'markupname',
  'numcharref', 'parameterentity', 'textentity', 'xmlatt', 'xmlelement',
  'xmlnsname', 'xmlpi', 'fn', 'indexterm', 'indextermref', 'index-base',
  'sort-as', 'draft-comment', 'required-cleanup', 'data', 'data-about',
  'foreign', 'unknown', 'image', 'linktext',
]);

const MARKS: Readonly<Record<string, Mark['type']>> = {
  b: 'strong',
  i: 'emphasis',
  cite: 'emphasis',
  varname: 'emphasis',
  sub: 'sub',
  sup: 'sup',
  uicontrol: 'ui',
  wintitle: 'ui',
  shortcut: 'ui',
  menucascade: 'ui',
  ...Object.fromEntries(
    [
      'tt',
      'codeph',
      'kwd',
      'var',
      'synph',
      'oper',
      'delim',
      'sep',
      'repsep',
      'option',
      'parmname',
      'apiname',
      'filepath',
      'msgph',
      'msgnum',
      'cmdname',
      'userinput',
      'systemoutput',
      'markupname',
      'numcharref',
      'parameterentity',
      'textentity',
      'xmlatt',
      'xmlelement',
      'xmlnsname',
      'xmlpi',
    ].map((name) => [name, 'code' as const]),
  ),
};

/** Elements left out, with nothing kept of them. */
const DROPPED: Readonly<Record<string, string>> = {
  indexterm: 'Index terms have no counterpart',
  indextermref: 'Index terms have no counterpart',
  'index-base': 'Index terms have no counterpart',
  'sort-as': 'Sort phrases have no counterpart',
  'draft-comment': 'Draft comments are not imported',
  'required-cleanup': 'Required clean-up markers are not imported',
  data: 'Metadata (<data>) has no counterpart',
  'data-about': 'Metadata (<data-about>) has no counterpart',
  foreign: 'Foreign content (<foreign>) is not imported',
  unknown: 'Unknown content (<unknown>) is not imported',
  object: 'Embedded objects (<object>) are not imported',
  'related-links': 'Related links have no counterpart',
  titlealts: 'Alternative titles have no counterpart',
};

/** Block elements whose own children are content, with an optional title. */
// prettier-ignore
const CONTAINERS = new Set([
  'section', 'example', 'sectiondiv', 'bodydiv', 'div', 'prereq', 'context',
  'result', 'postreq', 'tasktroubleshooting', 'steptroubleshooting', 'info',
  'stepxmp', 'stepresult', 'tutorialinfo', 'refsyn', 'condition', 'cause',
  'remedy', 'troubleSolution', 'responsibleParty', 'glossdef', 'glossBody',
  'abstract', 'steps-informal', 'figgroup', 'body', 'conbody', 'taskbody',
  'refbody', 'troublebody', 'lq', 'bookabstract',
]);

const SEVERITIES: Readonly<Record<string, SafetySeverity>> = {
  danger: 'danger',
  warning: 'warning',
  caution: 'caution',
  notice: 'notice',
};

const ADMONITIONS: Readonly<
  Record<string, { kind: 'note' | 'tip' | 'important'; exact: boolean }>
> = {
  note: { kind: 'note', exact: true },
  tip: { kind: 'tip', exact: true },
  important: { kind: 'important', exact: true },
  fastpath: { kind: 'tip', exact: false },
  remember: { kind: 'important', exact: false },
  restriction: { kind: 'important', exact: false },
  attention: { kind: 'important', exact: false },
  trouble: { kind: 'note', exact: false },
  other: { kind: 'note', exact: false },
};

const TRADEMARKS: Readonly<Record<string, string>> = {
  tm: '™',
  reg: '®',
  service: '℠',
};

/** A pending stream of inline content, and the blocks that break it (an inline image). */
interface Stream {
  inline(node: Inline): void;
  block(block: Block): void;
  footnote(blocks: Block[]): void;
}

/**
 * Converts one top-level topic (its content references resolved already)
 * into a module: its title, type, audience and keywords, its short
 * description, body and nested topics (as sections) as blocks. Everything
 * with no counterpart is reported, never dropped silently.
 */
export class TopicConverter {
  private readonly ids = new BlockIds();
  /** Block IDs by DITA address (`topicid` for a nested topic, `topicid/elementid`), for cross-references. */
  readonly anchors = new Map<string, string>();
  private readonly seen = new Set<string>();
  /** The keys whose text is being put in, innermost last: a key's text may name keys itself. */
  private readonly expanding: string[] = [];

  constructor(
    private readonly ctx: ImportContext,
    private readonly doc: DitaDoc,
    private readonly moduleId: string,
    private readonly keys: KeySpace | undefined,
    /** The same budget content references spend: key text and table padding are charged to it too. */
    private readonly budget: ExpansionBudget,
  ) {}

  module(topic: TopicIndex, element: XmlElement): Module {
    const scope: Scope = {
      sectionsAllowed: true,
      sectionDepth: 0,
      listDepth: 0,
      inTable: false,
      topic,
    };
    const profile = profileOf(
      element,
      this.ctx.profiling,
      this.ctx.report,
      this.place(element),
    );
    let blocks = this.topicBlocks(element, scope, true);
    if (profile.when && blocks.length > 0) {
      blocks = this.conditioned(profile.when, blocks, element);
    }
    const audience = leastRestricted(profile.audiences, this.ctx.config);
    if (profile.audiences.length > 1) {
      this.note(
        'audience-condition',
        element,
        `The topic is for several audience levels (${profile.audiences.join(', ')}); the module takes the least restricted, "${audience}".`,
      );
    }
    const keywords = this.keywords(element);
    return {
      schemaVersion: 1,
      id: this.moduleId,
      meta: {
        title: this.title(element),
        type: this.moduleType(element),
        lang: this.doc.lang,
        ...(audience !== undefined && { audience }),
        facets: {},
        ...(keywords.length > 0 && { keywords }),
        source: {
          system: 'DITA',
          id: collapse(`${this.doc.path}#${topic.id}`),
        },
      },
      blocks: fixSections(blocks),
    };
  }

  // Topics ------------------------------------------------------------------

  private topicBlocks(
    element: XmlElement,
    scope: Scope,
    top: boolean,
  ): Block[] {
    const blocks: Block[] = [];
    const inner: Scope = {
      ...scope,
      topic: this.doc.topics.get(attr(element, 'id') ?? '') ?? scope.topic,
    };
    for (const c of elements(element)) {
      const name = this.name(c);
      if (name === 'title' || name === 'glossterm') continue;
      if (name === 'prolog') {
        if (!top) this.metadata(c, true);
        else this.metadata(c, false);
        continue;
      }
      if (name === 'shortdesc') {
        pushAll(blocks, this.flow(c.children, inner, attr(c, 'id'), c));
        continue;
      }
      if (c.local === MODULE_REF) {
        blocks.push(this.moduleRef(c));
        continue;
      }
      if (isTopic(c)) {
        pushAll(blocks, this.nestedTopic(c, inner));
        continue;
      }
      pushAll(blocks, this.block(c, inner));
    }
    return blocks;
  }

  private nestedTopic(element: XmlElement, scope: Scope): Block[] {
    const profile = this.profile(element);
    const topic = this.doc.topics.get(attr(element, 'id') ?? '') ?? scope.topic;
    let blocks: Block[];
    if (scope.sectionsAllowed && scope.sectionDepth < MAX_SECTION_DEPTH) {
      const id = this.ids.take('section', attr(element, 'id'));
      this.anchor(element, id, topic, true);
      const content = this.topicBlocks(
        element,
        { ...scope, sectionDepth: scope.sectionDepth + 1, topic },
        false,
      );
      blocks = [
        {
          type: 'section',
          id,
          title: this.titleInline(element),
          blocks: fixSections(content),
        },
      ];
    } else {
      this.note(
        'section-depth',
        element,
        `The topic is nested deeper than ${MAX_SECTION_DEPTH} sections; its title is a bold paragraph.`,
      );
      blocks = [
        this.boldParagraph(this.titleInline(element)),
        ...this.topicBlocks(
          element,
          { ...scope, sectionsAllowed: false, topic },
          false,
        ),
      ];
    }
    return this.wrap(profile, blocks, element);
  }

  private moduleRef(element: XmlElement): Block {
    const module = this.ctx.moduleOf(
      relOf(this.ctx.project, attr(element, 'path') ?? ''),
      attr(element, 'topic'),
    );
    return {
      type: 'moduleRef',
      id: this.ids.take('ref', attr(element, 'id')),
      module: module ?? this.moduleId,
    };
  }

  private title(element: XmlElement): string {
    const title = child(element, 'title') ?? child(element, 'glossterm');
    const text = title ? collapse(textWithKeys(title, this.keys)) : '';
    return text === '' ? baseName(this.doc.path) : text;
  }

  private titleInline(element: XmlElement): Inline[] {
    const title = child(element, 'title') ?? child(element, 'glossterm');
    const inline = title ? this.inline(title.children, true) : [];
    return inline.length > 0
      ? inline
      : [{ type: 'text', text: attr(element, 'id') ?? 'Untitled' }];
  }

  private moduleType(element: XmlElement): string {
    const { mapping, config } = this.ctx;
    const configured = (id: string | undefined) =>
      id !== undefined && config.moduleTypes.some((t) => t.id === id)
        ? id
        : undefined;
    for (const token of tokens(attr(element, 'outputclass'))) {
      const id = Object.hasOwn(mapping.outputclasses, token)
        ? configured(mapping.outputclasses[token])
        : undefined;
      if (id) return id;
    }
    const names = [element.local, nameOf(element)].filter(
      (n): n is string => n !== undefined,
    );
    for (const name of names) {
      const id = Object.hasOwn(mapping.moduleTypes, name)
        ? configured(mapping.moduleTypes[name])
        : undefined;
      if (id) return id;
    }
    for (const name of names) {
      const id = configured(name);
      if (id) return id;
    }
    return (
      configured(mapping.defaultModuleType) ??
      (config.moduleTypes[0]?.id as string)
    );
  }

  private keywords(element: XmlElement): string[] {
    const prolog = child(element, 'prolog');
    const metadata = prolog && child(prolog, 'metadata');
    const lists = metadata ? childrenNamed(metadata, 'keywords') : [];
    const out: string[] = [];
    const seen = new Set<string>();
    let dropped = 0;
    for (const list of lists) {
      for (const keyword of childrenNamed(list, 'keyword')) {
        const text = collapse(textOf(keyword).replace(/,/g, ' '))
          .slice(0, 64)
          .trim();
        if (text === '' || seen.has(text.toLowerCase())) continue;
        if (out.length >= MAX_KEYWORDS) {
          dropped++;
          continue;
        }
        seen.add(text.toLowerCase());
        out.push(text);
      }
    }
    if (dropped > 0) {
      this.note(
        'keywords',
        element,
        `${dropped} keywords past the ${MAX_KEYWORDS} a module holds are left out.`,
      );
    }
    return out.map((k) => k.normalize('NFC'));
  }

  private metadata(prolog: XmlElement, nested: boolean): void {
    for (const c of elements(prolog)) {
      const name = this.name(c);
      if (name === 'metadata') {
        for (const m of elements(c)) {
          if (this.name(m) === 'keywords' && !nested) continue;
          this.note(
            'metadata',
            m,
            `<${m.local}> in the prolog has no counterpart; it is left out.`,
          );
        }
        continue;
      }
      this.note(
        'metadata',
        c,
        `<${c.local}> in the prolog has no counterpart; it is left out.`,
      );
    }
  }

  // Blocks ------------------------------------------------------------------

  /** One block-level element as blocks, its condition applied. */
  private block(element: XmlElement, scope: Scope): Block[] {
    const name = this.name(element);
    if (name !== undefined && Object.hasOwn(DROPPED, name)) {
      this.note(
        'dropped-element',
        element,
        `${DROPPED[name]}; <${element.local}> is left out.`,
      );
      return [];
    }
    const profile = this.profile(element);
    return this.wrap(profile, this.blockContent(element, name, scope), element);
  }

  private blockContent(
    element: XmlElement,
    name: string | undefined,
    scope: Scope,
  ): Block[] {
    switch (name) {
      case 'p':
        return this.flow(element.children, scope, attr(element, 'id'), element);
      case 'ul':
      case 'ol':
      case 'sl':
      case 'choices':
      case 'steps-unordered':
        return this.list(element, scope, name === 'ol');
      case 'steps':
      case 'substeps':
        return this.procedure(element, scope);
      case 'dl':
      case 'parml':
        return this.definitionList(element, scope);
      case 'note':
        return this.note_(element, scope);
      case 'hazardstatement':
        return this.hazard(element, scope);
      case 'pre':
      case 'codeblock':
      case 'screen':
      case 'msgblock':
        return [this.literal(element)];
      case 'lines':
        return this.paragraphs(
          this.inline(element.children, false, true),
          attr(element, 'id'),
          element,
        );
      case 'fig':
        return this.figure(element, scope);
      case 'image':
        return this.image(element, undefined);
      case 'table':
        return this.table(element, scope);
      case 'simpletable':
      case 'properties':
      case 'choicetable':
        return this.simpleTable(element, name, scope);
      case 'imagemap': {
        this.note(
          'unsupported-element',
          element,
          "The image map's areas have no counterpart; its image is imported.",
        );
        const image = child(element, 'image');
        return image ? this.image(image, undefined) : [];
      }
      case 'syntaxdiagram':
        this.note(
          'unsupported-element',
          element,
          'Syntax diagrams have no counterpart; the text is imported as a paragraph.',
        );
        return this.paragraphs(
          [{ type: 'text', text: collapse(textOf(element)) || ' ' }],
          attr(element, 'id'),
          element,
        );
      case 'stepsection':
        return this.flow(element.children, scope, attr(element, 'id'), element);
      case 'dlhead':
        this.note(
          'dropped-element',
          element,
          "A definition list's heading row has no counterpart; it is left out.",
        );
        return [];
      default:
        break;
    }
    if (name !== undefined && CONTAINERS.has(name)) {
      if (name === 'lq') {
        this.note(
          'unsupported-element',
          element,
          'Long quotations have no counterpart; the content is imported as it is.',
        );
      }
      return this.container(element, scope);
    }
    if (name !== undefined && INLINE.has(name)) {
      return this.flow([element], scope, undefined, element);
    }
    // Unknown: its text as a paragraph (the issue's default).
    this.note(
      'unknown-element',
      element,
      `<${element.local}> is no DITA 1.3 element the import knows; its text is imported as a paragraph.`,
    );
    return this.flow(element.children, scope, attr(element, 'id'), element);
  }

  /** A container's children; its title as a section (where sections may be) or a bold paragraph. */
  private container(element: XmlElement, scope: Scope): Block[] {
    const title = child(element, 'title');
    const rest = element.children.filter((c) => c !== title);
    if (!title || collapse(textOf(title)) === '') {
      return this.flow(rest, scope, undefined, undefined);
    }
    if (scope.sectionsAllowed && scope.sectionDepth < MAX_SECTION_DEPTH) {
      const id = this.ids.take('section', attr(element, 'id'));
      this.anchor(element, id, scope.topic);
      return [
        {
          type: 'section',
          id,
          title: this.inline(title.children, true),
          blocks: fixSections(
            this.flow(
              rest,
              { ...scope, sectionDepth: scope.sectionDepth + 1 },
              undefined,
              undefined,
            ),
          ),
        },
      ];
    }
    if (scope.sectionsAllowed) {
      this.note(
        'section-depth',
        element,
        `The section is nested deeper than ${MAX_SECTION_DEPTH} levels; its title is a bold paragraph.`,
      );
    }
    return [
      this.boldParagraph(this.inline(title.children, true)),
      ...this.flow(
        rest,
        { ...scope, sectionsAllowed: false },
        undefined,
        undefined,
      ),
    ];
  }

  /**
   * Mixed content (text, phrases and blocks, as a `<p>` or `<li>` holds) as
   * blocks: runs of inline content become paragraphs, block elements
   * blocks of their own in between.
   */
  private flow(
    nodes: readonly XmlNode[],
    scope: Scope,
    firstId: string | undefined,
    owner: XmlElement | undefined,
  ): Block[] {
    const blocks: Block[] = [];
    let pending: Inline[] = [];
    let footnotes: Block[] = [];
    let idUsed = false;
    const flush = () => {
      const content = tidy(pending);
      pending = [];
      if (content.length > 0) {
        const id = this.ids.take('p', idUsed ? undefined : firstId);
        if (!idUsed && owner && firstId !== undefined) {
          this.anchor(owner, id, scope.topic);
        }
        idUsed = true;
        blocks.push({ type: 'paragraph', id, content });
      }
      if (footnotes.length > 0) {
        blocks.push({
          type: 'admonition',
          id: this.ids.take('note'),
          kind: 'note',
          blocks: footnotes,
        });
        footnotes = [];
      }
    };
    const stream: Stream = {
      inline: (node) => pending.push(node),
      block: (block) => {
        flush();
        blocks.push(block);
      },
      footnote: (fn) => {
        pushAll(footnotes, fn);
      },
    };
    for (const node of nodes) {
      if (typeof node === 'string') {
        this.text(node, [], stream, false);
        continue;
      }
      const name = this.name(node);
      if (node.local === MODULE_REF) {
        stream.block(this.moduleRef(node));
        continue;
      }
      if (isTopic(node)) {
        flush();
        pushAll(blocks, this.nestedTopic(node, scope));
        continue;
      }
      const inline =
        name === undefined
          ? pending.length > 0 || hasText(nodes)
          : INLINE.has(name) &&
            !(name === 'image' && attr(node, 'placement') === 'break');
      if (inline) {
        this.inlineElement(node, [], stream, scope, false);
        continue;
      }
      flush();
      pushAll(blocks, this.block(node, scope));
    }
    flush();
    return blocks;
  }

  private paragraphs(
    content: Inline[],
    id: string | undefined,
    owner: XmlElement | undefined,
  ): Block[] {
    const tidied = tidy(content);
    if (tidied.length === 0) return [];
    const block = {
      type: 'paragraph' as const,
      id: this.ids.take('p', id),
      content: tidied,
    };
    if (owner && id !== undefined) this.anchor(owner, block.id, undefined);
    return [block];
  }

  private boldParagraph(title: Inline[]): Block {
    return {
      type: 'paragraph',
      id: this.ids.take('p'),
      content: title.map((n) =>
        n.type === 'text'
          ? {
              ...n,
              marks: [
                ...(n.marks ?? []).filter((m) => m.type !== 'strong'),
                { type: 'strong' },
              ],
            }
          : n,
      ),
    };
  }

  // Lists and procedures ------------------------------------------------------

  private list(element: XmlElement, scope: Scope, ordered: boolean): Block[] {
    const itemNames = new Set(['li', 'sli', 'choice', 'step']);
    const items = elements(element).filter((c) => {
      const name = this.name(c);
      if (name !== undefined && itemNames.has(name)) return true;
      if (name !== undefined && Object.hasOwn(DROPPED, name)) {
        this.note(
          'dropped-element',
          c,
          `${DROPPED[name]}; <${c.local}> is left out.`,
        );
      } else {
        this.note(
          'unknown-element',
          c,
          `<${c.local}> in a list is no list item; it is left out.`,
        );
      }
      return false;
    });
    if (scope.listDepth >= MAX_LIST_DEPTH) {
      this.note(
        'table-layout',
        element,
        `The list is nested deeper than ${MAX_LIST_DEPTH} levels; its items are paragraphs.`,
      );
      return items.flatMap((li) =>
        this.flow(li.children, scope, attr(li, 'id'), li),
      );
    }
    return this.grouped(element, items, (group) => [
      {
        type: 'list',
        id: this.ids.take(
          'list',
          group.first ? attr(element, 'id') : undefined,
        ),
        ordered,
        items: group.items.map((li) => this.item(li, scope, (c) => c.children)),
      },
    ]);
  }

  private procedure(element: XmlElement, scope: Scope): Block[] {
    const out: Block[] = [];
    let steps: XmlElement[] = [];
    let first = true;
    const emit = () => {
      if (steps.length === 0) return;
      const group = steps;
      steps = [];
      out.push(
        ...this.grouped(element, group, (g) => [
          {
            type: 'procedure',
            id: this.ids.take(
              'procedure',
              first && g.first ? attr(element, 'id') : undefined,
            ),
            steps: g.items.map((step) => this.step(step, scope)),
          },
        ]),
      );
      first = false;
    };
    for (const c of elements(element)) {
      const name = this.name(c);
      if (name === 'step' || name === 'substep') {
        steps.push(c);
        continue;
      }
      emit();
      if (name === 'stepsection') {
        this.note(
          'unsupported-element',
          c,
          'A step section splits the procedure; its text is a paragraph between two procedures.',
        );
      }
      pushAll(out, this.block(c, { ...scope, sectionsAllowed: false }));
    }
    emit();
    return out;
  }

  private step(step: XmlElement, scope: Scope): Item {
    if (attr(step, 'importance') !== undefined) {
      this.note(
        'unsupported-attribute',
        step,
        `A step's importance (@importance="${attr(step, 'importance')}") has no counterpart.`,
      );
    }
    const cmd = child(step, 'cmd');
    const id = this.ids.take('step', attr(step, 'id'));
    this.anchor(step, id, scope.topic);
    const inner: Scope = {
      ...scope,
      sectionsAllowed: false,
      listDepth: scope.listDepth + 1,
    };
    const content = cmd ? tidy(this.inline(cmd.children, false)) : [];
    const rest = elements(step).filter((c) => c !== cmd);
    const blocks = rest.flatMap((c) => this.block(c, inner));
    return {
      id,
      content: content.length > 0 ? content : this.placeholder(step),
      blocks: fixSections(blocks),
    };
  }

  /** A list item from a `<li>` (or the like): its first paragraph as its text, the rest as its blocks. */
  private item(
    li: XmlElement,
    scope: Scope,
    children: (li: XmlElement) => readonly XmlNode[],
  ): Item {
    const id = this.ids.take('item', attr(li, 'id'));
    this.anchor(li, id, scope.topic);
    const inner: Scope = {
      ...scope,
      sectionsAllowed: false,
      listDepth: scope.listDepth + 1,
    };
    const blocks = this.flow(children(li), inner, undefined, undefined);
    const first = blocks[0];
    if (first?.type === 'paragraph') {
      return { id, content: first.content, blocks: blocks.slice(1) };
    }
    return { id, content: this.placeholder(li), blocks };
  }

  private placeholder(element: XmlElement): Inline[] {
    this.note(
      'empty-element',
      element,
      `<${element.local}> has no text of its own; it is imported with "-" as its text.`,
    );
    return [{ type: 'text', text: '-' }];
  }

  private definitionList(element: XmlElement, scope: Scope): Block[] {
    const [entryName, termName, descName] =
      this.name(element) === 'parml'
        ? ['plentry', 'pt', 'pd']
        : ['dlentry', 'dt', 'dd'];
    const entries: XmlElement[] = [];
    // Anything else in it (invalid content) comes after the list, never lost.
    const after: Block[] = [];
    for (const c of elements(element)) {
      const name = this.name(c);
      if (name === entryName) entries.push(c);
      else pushAll(after, this.block(c, { ...scope, sectionsAllowed: false }));
    }
    if (entries.length === 0) return after;
    return [
      ...this.definitionEntries(
        element,
        entries,
        scope,
        termName as string,
        descName as string,
      ),
      ...after,
    ];
  }

  private definitionEntries(
    element: XmlElement,
    entries: XmlElement[],
    scope: Scope,
    termName: string,
    descName: string,
  ): Block[] {
    return this.grouped(element, entries, (group) => [
      {
        type: 'list',
        id: this.ids.take(
          'list',
          group.first ? attr(element, 'id') : undefined,
        ),
        ordered: false,
        items: group.items.map((entry) => {
          const id = this.ids.take('item', attr(entry, 'id'));
          this.anchor(entry, id, scope.topic);
          const inner: Scope = {
            ...scope,
            sectionsAllowed: false,
            listDepth: scope.listDepth + 1,
          };
          const terms = childrenNamed(entry, termName as string).map((t) =>
            this.inline(t.children, true),
          );
          const content: Inline[] = [];
          terms.forEach((t, i) => {
            if (i > 0) content.push({ type: 'text', text: ', ' });
            pushAll(content, t);
          });
          const strong = tidy(content).map((n) =>
            n.type === 'text'
              ? {
                  ...n,
                  marks: [
                    ...(n.marks ?? []).filter((m) => m.type !== 'strong'),
                    { type: 'strong' as const },
                  ],
                }
              : n,
          );
          const blocks = childrenNamed(entry, descName as string).flatMap((d) =>
            this.flow(d.children, inner, attr(d, 'id'), d),
          );
          return {
            id,
            content: strong.length > 0 ? strong : this.placeholder(entry),
            blocks,
          };
        }),
      },
    ]);
  }

  /**
   * Items split where their conditions change (a list item has none of its
   * own in the model): each run of items under the same condition is one
   * list, a conditional run in a variant block. Reported when it splits.
   */
  private grouped(
    element: XmlElement,
    items: readonly XmlElement[],
    make: (group: { items: XmlElement[]; first: boolean }) => Block[],
  ): Block[] {
    const groups: { when: Condition | undefined; items: XmlElement[] }[] = [];
    for (const item of items) {
      const { when } = this.profile(item);
      const last = groups[groups.length - 1];
      if (last && JSON.stringify(last.when) === JSON.stringify(when)) {
        last.items.push(item);
      } else {
        groups.push({ when, items: [item] });
      }
    }
    if (groups.length > 1 || (groups.length === 1 && groups[0]?.when)) {
      this.note(
        'item-condition',
        element,
        "Items with conditions of their own are split into lists of their own (in variant blocks); an ordered list's numbering starts again after each.",
      );
    }
    return groups.flatMap((group, i) => {
      const blocks = make({ items: group.items, first: i === 0 });
      return group.when
        ? this.conditioned(group.when, blocks, element)
        : blocks;
    });
  }

  // Notes and hazards ---------------------------------------------------------

  private note_(element: XmlElement, scope: Scope): Block[] {
    const type = attr(element, 'type') ?? 'note';
    const inner: Scope = { ...scope, sectionsAllowed: false };
    const blocks = fixSections(
      this.flow(element.children, inner, undefined, undefined),
    );
    const id = this.ids.take('note', attr(element, 'id'));
    this.anchor(element, id, scope.topic);
    const severity = Object.hasOwn(SEVERITIES, type)
      ? SEVERITIES[type]
      : undefined;
    if (severity) return [this.safety(id, severity, blocks, [], element)];
    if (blocks.length === 0) {
      this.note('empty-element', element, 'An empty note is left out.');
      return [];
    }
    const known = Object.hasOwn(ADMONITIONS, type)
      ? ADMONITIONS[type]
      : undefined;
    const kind = known?.kind ?? 'note';
    if (!known?.exact) {
      this.note(
        'note-type',
        element,
        `A note of type "${type}"${attr(element, 'othertype') ? ` ("${attr(element, 'othertype')}")` : ''} has no counterpart; it is imported as "${kind}".`,
      );
    }
    return [{ type: 'admonition', id, kind, blocks }];
  }

  /** A safety block, its hazard the first paragraph's text. */
  private safety(
    id: string,
    severity: SafetySeverity,
    blocks: Block[],
    symbols: string[],
    element: XmlElement,
    hazard?: Inline[],
  ): Block {
    let rest = blocks;
    let text = hazard ? tidy(hazard) : [];
    if (text.length === 0) {
      const first = blocks[0];
      if (first?.type === 'paragraph') {
        text = first.content;
        rest = blocks.slice(1);
      }
    }
    text = text.map((n) =>
      n.type === 'hardBreak' ? { type: 'text' as const, text: ' ' } : n,
    );
    text = tidy(text);
    if (text.length === 0) {
      this.note(
        'empty-element',
        element,
        'The safety notice states no hazard; "-" stands in for it.',
      );
      text = [{ type: 'text', text: '-' }];
    }
    return {
      type: 'safety',
      id,
      severity,
      hazard: text,
      symbols,
      blocks: rest,
    };
  }

  private hazard(element: XmlElement, scope: Scope): Block[] {
    const type = attr(element, 'type') ?? 'caution';
    const id = this.ids.take('safety', attr(element, 'id'));
    this.anchor(element, id, scope.topic);
    const inner: Scope = { ...scope, sectionsAllowed: false };
    const panels = childrenNamed(element, 'messagepanel');
    if (panels.length > 1) {
      this.note(
        'hazard-type',
        element,
        'A hazard statement with several message panels: they are imported one after the other.',
      );
    }
    let hazard: Inline[] | undefined;
    const blocks: Block[] = [];
    for (const panel of panels) {
      for (const c of elements(panel)) {
        const name = this.name(c);
        if (name === 'typeofhazard' && hazard === undefined) {
          hazard = this.inline(c.children, true);
          continue;
        }
        pushAll(blocks, this.flow(c.children, inner, attr(c, 'id'), c));
      }
    }
    const symbols: string[] = [];
    for (const symbol of childrenNamed(element, 'hazardsymbol')) {
      const href = attr(symbol, 'href');
      const keyref = attr(symbol, 'keyref');
      const file = href === undefined ? undefined : splitReference(href);
      const path = file && resolvePath(baseOf(symbol, this.doc), file.path);
      if (path !== undefined) this.ctx.readFiles.add(path);
      const names = [href && baseName(href.split('#')[0] ?? ''), keyref].filter(
        (n): n is string => !!n,
      );
      const id = names
        .map((n) =>
          Object.hasOwn(this.ctx.mapping.hazardSymbols, n)
            ? this.ctx.mapping.hazardSymbols[n]
            : undefined,
        )
        .find(
          (s) =>
            s !== undefined &&
            this.ctx.config.safetySymbols.some((c) => c.id === s),
        );
      if (id && !symbols.includes(id)) symbols.push(id);
      else if (!id) {
        this.note(
          'hazard-symbol',
          symbol,
          `The hazard symbol "${names.join('", "') || '?'}" maps to no safety symbol; map it in "dita.hazardSymbols".`,
        );
      }
    }
    const severity = Object.hasOwn(SEVERITIES, type)
      ? SEVERITIES[type]
      : undefined;
    if (severity)
      return [this.safety(id, severity, blocks, symbols, element, hazard)];
    this.note(
      'hazard-type',
      element,
      `A hazard statement of type "${type}" is no safety severity (danger, warning, caution, notice); it is imported as a note.`,
    );
    const content = [
      ...(hazard && tidy(hazard).length > 0
        ? [
            {
              type: 'paragraph' as const,
              id: this.ids.take('p'),
              content: tidy(hazard),
            },
          ]
        : []),
      ...blocks,
    ];
    return content.length > 0
      ? [{ type: 'admonition', id, kind: 'important', blocks: content }]
      : [];
  }

  // Literal text --------------------------------------------------------------

  private literal(element: XmlElement): Block {
    if (elements(element).length > 0) {
      this.note(
        'markup-in-literal',
        element,
        `Markup inside <${element.local}> (${[...new Set(elements(element).map((e) => e.local))].join(', ')}) is imported as plain text.`,
      );
    }
    const text = textOf(element).replace(/^\n/, '').trimEnd();
    const language = tokens(attr(element, 'outputclass'))
      .map((t) => /^language-([A-Za-z0-9][A-Za-z0-9+#._-]*)$/.exec(t)?.[1])
      .find((l) => l !== undefined);
    const id = this.ids.take('literal', attr(element, 'id'));
    this.anchor(element, id, undefined);
    return { type: 'literal', id, text, ...(language && { language }) };
  }

  // Images ------------------------------------------------------------------

  private figure(element: XmlElement, scope: Scope): Block[] {
    const images = childrenNamed(element, 'image');
    const title = child(element, 'title');
    const rest = element.children.filter(
      (c) => c !== title && !(images.length === 1 && c === images[0]),
    );
    if (images.length === 1) {
      const titleInline = title ? tidy(this.inline(title.children, true)) : [];
      return [
        ...this.image(
          images[0] as XmlElement,
          titleInline.length > 0 ? titleInline : undefined,
          attr(element, 'id'),
        ),
        ...this.flow(
          rest,
          { ...scope, sectionsAllowed: false },
          undefined,
          undefined,
        ),
      ];
    }
    return [
      ...(title && collapse(textOf(title)) !== ''
        ? [this.boldParagraph(this.inline(title.children, true))]
        : []),
      ...this.flow(
        element.children.filter((c) => c !== title),
        { ...scope, sectionsAllowed: false },
        undefined,
        undefined,
      ),
    ];
  }

  private image(
    element: XmlElement,
    title: Inline[] | undefined,
    ownerId?: string,
  ): Block[] {
    const asset = this.assetOf(element);
    const altElement = child(element, 'alt');
    const alt =
      collapse(
        altElement ? textOf(altElement) : (attr(element, 'alt') ?? ''),
      ) ||
      (title
        ? collapse(title.map((n) => (n.type === 'text' ? n.text : '')).join(''))
        : '') ||
      (asset?.path ? baseName(asset.path) : 'Image');
    if (!asset) return [];
    const id = this.ids.take('image', ownerId ?? attr(element, 'id'));
    this.anchor(element, id, undefined);
    // DITA's sizes (a length with a unit, a scale of the image's own size)
    // say nothing about the share of the text width the model's `width` is.
    const sized = ['height', 'width', 'scale', 'scalefit'].filter(
      (a) => attr(element, a) !== undefined,
    );
    if (sized.length > 0) {
      this.note(
        'unsupported-attribute',
        element,
        `An image's size (@${sized.join(', @')}) has no counterpart (a width is a share of the text width); the image is imported at its own size.`,
      );
    }
    return [
      {
        type: 'image',
        id,
        asset: asset.ref,
        alt,
        ...(title && title.length > 0 && { title }),
      },
    ];
  }

  /** The file an `<image>` (or a key it names) shows, as a stored file. */
  private assetOf(
    element: XmlElement,
  ): { ref: string; path: string } | undefined {
    let href = attr(element, 'href');
    const base = baseOf(element, this.doc);
    // A key's target is a path already (decoded, resolved): never parsed again.
    let keyed: { readonly path: string } | undefined;
    const keyref = attr(element, 'keyref');
    if (keyref !== undefined) {
      const def = this.keys?.get(keyref);
      if (def?.target) {
        href = def.target.path;
        keyed = def.target;
      } else if (href === undefined) {
        this.note(
          'unresolved-key',
          element,
          `The key "${keyref}" names no image; the image is left out.`,
        );
        return undefined;
      }
    }
    if (href === undefined) {
      this.note(
        'missing-asset',
        element,
        'An image without @href is left out.',
      );
      return undefined;
    }
    if (hasScheme(href)) {
      this.note(
        'external-reference',
        element,
        `The image "${href}" lies outside the archive; it is left out (nothing is fetched).`,
      );
      return undefined;
    }
    const ref = keyed ?? splitReference(href);
    const path = keyed ? keyed.path : ref && resolvePath(base, ref.path);
    if (path === undefined || path === '') {
      this.note(
        'outside-archive',
        element,
        `The image "${href}" lies outside the archive; it is left out.`,
      );
      return undefined;
    }
    const assetRef = this.ctx.assetRefs.get(path);
    if (!assetRef) {
      this.note(
        'missing-asset',
        element,
        `The image "${path}" is not in the archive; it is left out.`,
      );
      return undefined;
    }
    this.ctx.usedAssets.add(assetRef);
    return { ref: assetRef, path };
  }

  // Tables --------------------------------------------------------------------

  private table(element: XmlElement, scope: Scope): Block[] {
    if (scope.inTable) return this.nestedTable(element);
    const title = child(element, 'title');
    const titleInline = title ? tidy(this.inline(title.children, true)) : [];
    const groups = childrenNamed(element, 'tgroup');
    if (groups.length > 1) {
      this.note(
        'table-layout',
        element,
        'A table with several groups (<tgroup>) is imported as one table per group.',
      );
    }
    const out: Block[] = [];
    groups.forEach((group, i) => {
      const block = this.tgroup(group, scope, element);
      if (!block) return;
      const id = this.ids.take(
        'table',
        i === 0 ? attr(element, 'id') : undefined,
      );
      if (i === 0) this.anchor(element, id, scope.topic);
      out.push({
        type: 'table',
        id,
        ...(i === 0 && titleInline.length > 0 && { title: titleInline }),
        ...block,
      });
    });
    const desc = child(element, 'desc');
    if (desc)
      out.push(
        ...this.flow(
          desc.children,
          { ...scope, sectionsAllowed: false },
          undefined,
          undefined,
        ),
      );
    return out;
  }

  private tgroup(
    group: XmlElement,
    scope: Scope,
    table: XmlElement,
  ): { columns: TableColumn[]; header: boolean; rows: TableRow[] } | undefined {
    const specs = childrenNamed(group, 'colspec');
    const declared = Number.parseInt(attr(group, 'cols') ?? '', 10);
    const wanted =
      Number.isInteger(declared) && declared > 0 ? declared : specs.length;
    const count = Math.min(Math.max(1, wanted), MAX_TABLE_COLUMNS);
    if (wanted > MAX_TABLE_COLUMNS) {
      this.note(
        'table-layout',
        table,
        `The table has ${wanted} columns; only the first ${MAX_TABLE_COLUMNS} are imported.`,
      );
    }
    const names = new Map<string, number>();
    specs.forEach((spec, i) => {
      const num = Number.parseInt(attr(spec, 'colnum') ?? '', 10);
      const index = Number.isInteger(num) && num >= 1 ? num - 1 : i;
      const name = attr(spec, 'colname');
      if (name !== undefined) names.set(name, index);
    });
    const widths = Array.from(
      { length: count },
      (_, i) => specs[i] && attr(specs[i] as XmlElement, 'colwidth'),
    );
    const columns = columnWidths(widths, () =>
      this.note(
        'table-layout',
        table,
        'Column widths in absolute units are not imported; the columns share the width.',
      ),
    ).map((width, i) => {
      const align = specs[i] && attr(specs[i] as XmlElement, 'align');
      return {
        width,
        ...(align === 'center' || align === 'right'
          ? { align }
          : align === 'left'
            ? { align }
            : {}),
      } as TableColumn;
    });
    const head = child(group, 'thead');
    const body = child(group, 'tbody');
    for (const part of [group, head, body]) {
      if (part) this.rowCondition(part, table);
    }
    const headRows = head ? childrenNamed(head, 'row') : [];
    const bodyRows = body ? childrenNamed(body, 'row') : [];
    if (headRows.length > 1) {
      this.note(
        'table-layout',
        table,
        "Only a table's first heading row is a header; the others are body rows.",
      );
    }
    const inner: Scope = { ...scope, sectionsAllowed: false, inTable: true };
    const rows = this.grid(
      this.rowsWithin([...headRows, ...bodyRows], count, table),
      count,
      names,
      inner,
      table,
    );
    if (rows.length === 0) return undefined;
    let header = headRows.length > 0;
    const first = rows[0];
    if (
      header &&
      first &&
      !first.cells.every(
        (c) =>
          (c.rowspan ?? 1) === 1 &&
          (c.blocks.length === 0 ||
            (c.blocks.length === 1 && c.blocks[0]?.type === 'paragraph')),
      )
    ) {
      this.note(
        'table-layout',
        table,
        'A heading row whose cells hold more than one paragraph, or span rows, is imported as a body row.',
      );
      header = false;
    }
    return { columns, header, rows };
  }

  /** CALS rows as the model's: spans, cells placed by column name, rows filled to the table's width. */
  private grid(
    rows: readonly XmlElement[],
    count: number,
    names: ReadonlyMap<string, number>,
    scope: Scope,
    table: XmlElement,
  ): TableRow[] {
    const carried = new Array<number>(count).fill(0);
    const out: TableRow[] = [];
    for (const [r, row] of rows.entries()) {
      this.rowCondition(row, table);
      const occupied = carried.map((n) => n > 0);
      const cells: TableCell[] = [];
      let col = 0;
      const remaining = rows.length - r;
      for (const entry of childrenNamed(row, 'entry')) {
        const start = names.get(
          attr(entry, 'namest') ?? attr(entry, 'colname') ?? '',
        );
        while (col < count && occupied[col]) col++;
        if (start !== undefined && start > col) {
          for (; col < start && col < count; col++) {
            if (!occupied[col]) {
              cells.push({ blocks: [] });
              occupied[col] = true;
            }
          }
          while (col < count && occupied[col]) col++;
        }
        if (col >= count) {
          this.note(
            'table-layout',
            table,
            'A row holds more cells than the table has columns; the extra cells are left out.',
          );
          break;
        }
        const end = names.get(attr(entry, 'nameend') ?? '');
        let colspan = end !== undefined && end >= col ? end - col + 1 : 1;
        if (attr(entry, 'spanname') !== undefined) {
          this.note(
            'table-layout',
            table,
            'Spans named by <spanspec> are not read; the cell spans one column.',
          );
        }
        // Narrowed to the table and to the first occupied column: one scan.
        colspan = Math.max(1, Math.min(colspan, count - col));
        for (let j = col + 1; j < col + colspan; j++) {
          if (occupied[j]) {
            colspan = j - col;
            break;
          }
        }
        if (occupied[col]) colspan = 1;
        const more = Number.parseInt(attr(entry, 'morerows') ?? '0', 10);
        const rowspan = Math.max(
          1,
          Math.min(Number.isInteger(more) ? more + 1 : 1, remaining, 100),
        );
        for (let c = col; c < col + colspan; c++) {
          occupied[c] = true;
          carried[c] = Math.max(carried[c] ?? 0, rowspan);
        }
        cells.push({
          ...(colspan > 1 && { colspan }),
          ...(rowspan > 1 && { rowspan }),
          blocks: this.cellBlocks(entry, scope),
        });
        col += colspan;
      }
      for (let c = 0; c < count; c++) {
        if (!occupied[c]) cells.push({ blocks: [] });
      }
      for (let c = 0; c < count; c++)
        carried[c] = Math.max(0, (carried[c] ?? 0) - 1);
      out.push({ cells: cells.length > 0 ? cells : [{ blocks: [] }] });
    }
    return out;
  }

  /**
   * The rows a table of `count` columns is imported with: at most
   * `MAX_TABLE_CELLS` cells (every row is padded to `count`), the rest
   * reported and left out; the cells are charged to the expansion budget.
   */
  private rowsWithin<T>(
    rows: readonly T[],
    count: number,
    table: XmlElement,
  ): T[] {
    const most = Math.max(1, Math.floor(MAX_TABLE_CELLS / count));
    if (rows.length > most) {
      this.note(
        'table-layout',
        table,
        `The table has ${rows.length} rows of ${count} cells, more than the ${MAX_TABLE_CELLS} cells a table is imported with; only the first ${most} rows are.`,
      );
    }
    const kept = rows.slice(0, most);
    this.budget.spend(kept.length * count);
    return kept;
  }

  /** Reports a row's (or row group's) condition: a table row has none in the model. */
  private rowCondition(row: XmlElement, table: XmlElement): void {
    const conditions = filterAttributes(row);
    if (conditions.length === 0) return;
    this.note(
      'item-condition',
      table,
      `A table row's or row group's condition (<${row.local}> ${conditions.map(([a, v]) => `${a}="${v}"`).join(' ')}) has no counterpart; the row is imported for every variant.`,
    );
  }

  private cellBlocks(entry: XmlElement, scope: Scope): Block[] {
    if (filterAttributes(entry).length > 0) {
      this.note(
        'item-condition',
        entry,
        "A table cell's condition has no counterpart; the cell is imported for every variant.",
      );
    }
    return this.flow(entry.children, scope, undefined, undefined);
  }

  private nestedTable(element: XmlElement): Block[] {
    this.note(
      'nested-table',
      element,
      'A table inside a table cell has no counterpart; its text is a paragraph.',
    );
    const text = collapse(textOf(element));
    return text === ''
      ? []
      : [
          {
            type: 'paragraph',
            id: this.ids.take('p'),
            content: [{ type: 'text', text }],
          },
        ];
  }

  private simpleTable(
    element: XmlElement,
    name: string,
    scope: Scope,
  ): Block[] {
    if (scope.inTable) return this.nestedTable(element);
    const shape =
      name === 'properties'
        ? {
            head: 'prophead',
            row: 'property',
            cells: [
              ['proptypehd', 'proptype'],
              ['propvaluehd', 'propvalue'],
              ['propdeschd', 'propdesc'],
            ],
          }
        : name === 'choicetable'
          ? {
              head: 'chhead',
              row: 'chrow',
              cells: [
                ['choptionhd', 'choption'],
                ['chdeschd', 'chdesc'],
              ],
            }
          : { head: 'sthead', row: 'strow', cells: undefined };
    const head = child(element, shape.head);
    const rows = childrenNamed(element, shape.row);
    const inner: Scope = { ...scope, sectionsAllowed: false, inTable: true };
    let cellsOf: (
      row: XmlElement,
      header: boolean,
    ) => (XmlElement | undefined)[];
    let count: number;
    if (shape.cells) {
      // The columns any row uses, in their order.
      const kinds = shape.cells.filter(([h, c]) =>
        [head, ...rows].some(
          (row) =>
            row && child(row, row === head ? (h as string) : (c as string)),
        ),
      );
      count = Math.max(1, kinds.length);
      cellsOf = (row, header) =>
        kinds.map(([h, c]) =>
          child(row, header ? (h as string) : (c as string)),
        );
    } else {
      // A loop, not a spread: a table may have more rows than a call has arguments.
      let widest = 1;
      for (const r of [head, ...rows]) {
        if (r) widest = Math.max(widest, childrenNamed(r, 'stentry').length);
      }
      count = Math.min(widest, MAX_TABLE_COLUMNS);
      if (widest > MAX_TABLE_COLUMNS) {
        this.note(
          'table-layout',
          element,
          `The table has ${widest} columns; only the first ${MAX_TABLE_COLUMNS} are imported.`,
        );
      }
      cellsOf = (row) => {
        const entries = childrenNamed(row, 'stentry');
        return Array.from({ length: count }, (_, i) => entries[i]);
      };
    }
    const all = this.rowsWithin(
      [
        ...(head ? [{ row: head, header: true }] : []),
        ...rows.map((row) => ({ row, header: false })),
      ],
      count,
      element,
    );
    if (all.length === 0) return [];
    for (const { row } of all) this.rowCondition(row, element);
    const tableRows: TableRow[] = all.map(({ row, header }) => ({
      cells: cellsOf(row, header).map((cell) => ({
        blocks: cell ? this.cellBlocks(cell, inner) : [],
      })),
    }));
    const relwidths = tokens(attr(element, 'relcolwidth'));
    const widths = columnWidths(
      Array.from({ length: count }, (_, i) => relwidths[i]),
      () => undefined,
    );
    let header = head !== undefined;
    const first = tableRows[0];
    if (
      header &&
      first &&
      !first.cells.every(
        (c) =>
          c.blocks.length === 0 ||
          (c.blocks.length === 1 && c.blocks[0]?.type === 'paragraph'),
      )
    ) {
      this.note(
        'table-layout',
        element,
        'A heading row whose cells hold more than one paragraph is imported as a body row.',
      );
      header = false;
    }
    const title = child(element, 'title');
    const titleInline = title ? tidy(this.inline(title.children, true)) : [];
    const id = this.ids.take('table', attr(element, 'id'));
    this.anchor(element, id, scope.topic);
    return [
      {
        type: 'table',
        id,
        ...(titleInline.length > 0 && { title: titleInline }),
        columns: widths.map((width) => ({ width })),
        header,
        rows: tableRows,
      },
    ];
  }

  // Inline ----------------------------------------------------------------

  /** Inline content of `nodes` (blocks in it reported and left out). */
  private inline(
    nodes: readonly XmlNode[],
    title: boolean,
    lines = false,
  ): Inline[] {
    const out: Inline[] = [];
    const stream: Stream = {
      inline: (n) => out.push(n),
      block: (b) => {
        this.note(
          'inline-image',
          {
            local: b.type,
            attributes: new Map(),
            declarations: new Map(),
            children: [],
            ns: undefined,
            line: 0,
          },
          "A block inside a title or a step's command is left out.",
        );
      },
      footnote: () => undefined,
    };
    const scope: Scope = {
      sectionsAllowed: false,
      sectionDepth: 0,
      listDepth: 0,
      inTable: false,
      topic: this.doc.firstTopic as TopicIndex,
    };
    for (const node of nodes) {
      if (typeof node === 'string') this.text(node, [], stream, lines);
      else this.inlineElement(node, [], stream, scope, lines);
    }
    const content = tidy(out);
    return title
      ? tidy(
          content.map((n) =>
            n.type === 'hardBreak' ? { type: 'text' as const, text: ' ' } : n,
          ),
        )
      : content;
  }

  private text(
    text: string,
    marks: Mark[],
    stream: Stream,
    lines: boolean,
  ): void {
    if (!lines) {
      const value = text.replace(/[ \t\r\n]+/g, ' ');
      if (value !== '') stream.inline(textNode(value, marks));
      return;
    }
    text.split('\n').forEach((line, i) => {
      if (i > 0) stream.inline({ type: 'hardBreak' });
      const value = line.replace(/[ \t\r]+/g, ' ');
      if (value !== '') stream.inline(textNode(value, marks));
    });
  }

  private inlineChildren(
    element: XmlElement,
    marks: Mark[],
    stream: Stream,
    scope: Scope,
    lines: boolean,
  ): void {
    for (const node of element.children) {
      if (typeof node === 'string') this.text(node, marks, stream, lines);
      else this.inlineElement(node, marks, stream, scope, lines);
    }
  }

  private inlineElement(
    element: XmlElement,
    marks: Mark[],
    stream: Stream,
    scope: Scope,
    lines: boolean,
  ): void {
    const name = this.name(element);
    if (name !== undefined && Object.hasOwn(DROPPED, name)) {
      this.note(
        'dropped-element',
        element,
        `${DROPPED[name]}; <${element.local}> is left out.`,
      );
      return;
    }
    if (filterAttributes(element).length > 0) {
      this.note(
        'inline-condition',
        element,
        `A phrase's condition (${filterAttributes(element)
          .map(([a, v]) => `${a}="${v}"`)
          .join(
            ' ',
          )}) has no counterpart: inline content does not vary by variant; the text is imported for every variant.`,
      );
    }
    switch (name) {
      case 'image': {
        this.note(
          'inline-image',
          element,
          'An image inside text is imported as an image block of its own, splitting the paragraph.',
        );
        for (const block of this.image(element, undefined)) stream.block(block);
        return;
      }
      case 'fn': {
        this.note(
          'footnote',
          element,
          'Footnotes have no counterpart; the footnote is a note after its paragraph.',
        );
        stream.footnote(
          this.flow(
            element.children,
            { ...scope, sectionsAllowed: false },
            undefined,
            undefined,
          ),
        );
        return;
      }
      case 'xref':
        this.xref(element, marks, stream);
        return;
      case 'tm': {
        this.inlineChildren(element, marks, stream, scope, lines);
        const symbol = TRADEMARKS[attr(element, 'tmtype') ?? 'tm'];
        if (symbol) stream.inline(textNode(symbol, marks));
        return;
      }
      case 'q':
        stream.inline(textNode('"', marks));
        this.inlineChildren(element, marks, stream, scope, lines);
        stream.inline(textNode('"', marks));
        return;
      case 'menucascade': {
        const uimarks = withMark(marks, 'ui');
        elements(element).forEach((c, i) => {
          if (i > 0) stream.inline(textNode(' > ', uimarks));
          this.inlineChildren(c, uimarks, stream, scope, lines);
        });
        return;
      }
      case 'u':
      case 'line-through':
      case 'overline':
        this.note(
          'unsupported-element',
          element,
          `<${element.local}> has no counterpart; its text is imported without it.`,
        );
        this.inlineChildren(element, marks, stream, scope, lines);
        return;
      case 'ph':
      case 'keyword':
      case 'term':
      case 'abbreviated-form':
      case 'text':
      case 'linktext':
      case 'boolean':
      case 'state':
        if (this.keyContent(element, marks, stream, scope)) return;
        if (name === 'boolean' || name === 'state') {
          this.note(
            'unsupported-element',
            element,
            `<${element.local}> (deprecated) is imported as its text.`,
          );
          const value = attr(element, 'value') ?? attr(element, 'name') ?? '';
          if (value !== '') stream.inline(textNode(value, marks));
          return;
        }
        this.inlineChildren(element, marks, stream, scope, lines);
        return;
      default:
        break;
    }
    if (name !== undefined && Object.hasOwn(MARKS, name)) {
      this.inlineChildren(
        element,
        withMark(marks, MARKS[name] as Mark['type']),
        stream,
        scope,
        lines,
      );
      return;
    }
    if (name === undefined || !INLINE.has(name)) {
      if (name === undefined) {
        this.note(
          'unknown-element',
          element,
          `<${element.local}> is no DITA 1.3 element the import knows; its text is imported.`,
        );
      } else {
        this.note(
          'unsupported-element',
          element,
          `<${element.local}> inside text has no counterpart; its text is imported.`,
        );
      }
    }
    this.inlineChildren(element, marks, stream, scope, lines);
  }

  /** An empty element with `@keyref`: a text attribute, or the key's text. Whether it was one. */
  private keyContent(
    element: XmlElement,
    marks: Mark[],
    stream: Stream,
    scope: Scope,
  ): boolean {
    const keyref = attr(element, 'keyref');
    if (keyref === undefined) return false;
    const empty = element.children.every(
      (c) => typeof c === 'string' && c.trim() === '',
    );
    if (!empty) return false;
    const key = keyref.split('/')[0] ?? keyref;
    const attribute = this.textAttribute(key);
    if (attribute) {
      stream.inline({ type: 'attribute', name: attribute });
      return true;
    }
    const def = this.keys?.get(key);
    const text = def && keyText(def);
    if (!text) {
      this.note(
        'unresolved-key',
        element,
        `The key "${key}" holds no text${def ? '' : ' (it is not defined)'}; the element is left empty.`,
      );
      return true;
    }
    this.withKey(key, element, text, () =>
      this.inlineChildren(text, marks, stream, scope, false),
    );
    return true;
  }

  /**
   * Puts a key's text in (`run`), bounded as content references are: a key
   * already being put in (a cycle) or one past `MAX_CONREF_DEPTH` keys deep
   * is reported and left out, and every node of the text is charged to the
   * expansion budget, so a fan-out of keys stops at its bound.
   */
  private withKey(
    key: string,
    element: XmlElement,
    text: XmlElement,
    run: () => void,
  ): void {
    if (this.expanding.includes(key)) {
      this.note(
        'key-cycle',
        element,
        `The key "${key}"'s text names "${key}" again (${[...this.expanding, key].join(' → ')}); it is not put in again.`,
      );
      return;
    }
    if (this.expanding.length >= MAX_CONREF_DEPTH) {
      this.note(
        'key-cycle',
        element,
        `Key texts nest deeper than ${MAX_CONREF_DEPTH}; the key "${key}" is not put in.`,
      );
      return;
    }
    const { nodes, chars } = nodeCount(text);
    this.budget.spend(nodes, chars);
    this.expanding.push(key);
    try {
      run();
    } finally {
      this.expanding.pop();
    }
  }

  /** The text attribute a key is, by the mapping or by the same name. */
  textAttribute(key: string): string | undefined {
    const { mapping, config } = this.ctx;
    const id = Object.hasOwn(mapping.textKeys, key)
      ? mapping.textKeys[key]
      : key;
    return config.textAttributes.some((a) => a.id === id) ? id : undefined;
  }

  private xref(element: XmlElement, marks: Mark[], stream: Stream): void {
    let href = attr(element, 'href');
    const base = baseOf(element, this.doc);
    let scopeAttr = attr(element, 'scope');
    const keyref = attr(element, 'keyref');
    let fragmentFromKey: string | undefined;
    let keyed:
      { readonly path: string; readonly fragment?: string } | undefined;
    let keyLabel: XmlElement | undefined;
    if (keyref !== undefined) {
      const slash = keyref.indexOf('/');
      const def = this.keys?.get(
        slash === -1 ? keyref : keyref.slice(0, slash),
      );
      if (def?.external) {
        href = def.external;
        // Put in at every use (the link and, unlabelled, its text): charged by its length each time.
        this.budget.spend(0, 2 * href.length);
        scopeAttr = 'external';
      } else if (def?.target) {
        href = def.target.path;
        keyed = def.target;
        fragmentFromKey =
          slash === -1
            ? def.target.fragment
            : `${def.target.fragment ?? this.ctx.project.docs.get(def.target.path)?.firstTopic?.id ?? ''}/${keyref.slice(slash + 1)}`;
      } else if (href === undefined) {
        this.note(
          'unresolved-key',
          element,
          `The key "${keyref}" is not defined; the link is imported as its text.`,
        );
      }
      if (def) keyLabel = keyText(def);
    }
    const content: Inline[] = [];
    const collect: Stream = {
      inline: (n) => content.push(n),
      block: () => undefined,
      footnote: () => undefined,
    };
    const scope: Scope = {
      sectionsAllowed: false,
      sectionDepth: 0,
      listDepth: 0,
      inTable: false,
      topic: this.doc.firstTopic as TopicIndex,
    };
    for (const c of element.children) {
      if (typeof c === 'string') this.text(c, marks, collect, false);
      else if (this.name(c) !== 'desc')
        this.inlineElement(c, marks, collect, scope, false);
    }
    if (tidy(content).length === 0 && keyLabel && keyref !== undefined) {
      const label = keyLabel;
      this.withKey(keyref.split('/')[0] ?? keyref, element, label, () =>
        this.inlineChildren(label, marks, collect, scope, false),
      );
    }
    const label = tidy(content);
    if (href === undefined) {
      label.forEach((n) => stream.inline(n));
      return;
    }
    if (scopeAttr === 'external' || hasScheme(href)) {
      const target = href.trim();
      if (!isLinkHref(target)) {
        this.note(
          'external-reference',
          element,
          `The link "${target}" is no http, https or mailto address; it is imported as its text.`,
        );
        (label.length > 0 ? label : [textNode(target, marks)]).forEach((n) =>
          stream.inline(n),
        );
        return;
      }
      const linked = withMark(
        marks.filter((m) => m.type !== 'link' && m.type !== 'term'),
        'link',
        target,
      );
      const runs = label.length > 0 ? label : [textNode(target, [])];
      for (const n of runs) {
        stream.inline(
          n.type === 'text' ? { ...n, marks: mergeMarks(n.marks, linked) } : n,
        );
      }
      return;
    }
    const ref = keyed ?? splitReference(href);
    const path = keyed
      ? keyed.path
      : ref && (ref.path === '' ? base : resolvePath(base, ref.path));
    const fragment = fragmentFromKey ?? ref?.fragment;
    const doc =
      path === undefined ? undefined : this.ctx.project.docs.get(path);
    if (!doc || doc.kind !== 'topic') {
      this.note(
        doc ? 'external-reference' : 'unresolved-xref',
        element,
        doc
          ? `The link to "${href}" names no topic; it is imported as its text.`
          : `The link "${href}" names nothing in the archive${path !== undefined && this.ctx.project.files.has(path) ? ' that is a topic (links to other files are not imported)' : ''}; it is imported as its text.`,
      );
      label.forEach((n) => stream.inline(n));
      return;
    }
    const slash = fragment?.indexOf('/') ?? -1;
    const topicId =
      fragment === undefined
        ? doc.firstTopic?.id
        : slash === -1
          ? fragment
          : fragment.slice(0, slash);
    const resolvedTopic = topicId === '.' ? doc.firstTopic?.id : topicId;
    const topic =
      resolvedTopic === undefined ? undefined : doc.topics.get(resolvedTopic);
    const top = topic && topLevelOf(this.ctx.project, doc, topic);
    const module =
      top &&
      this.ctx.moduleOf(
        relOf(this.ctx.project, doc.path),
        doc.modules.length > 1 ? top.id : undefined,
      );
    if (!topic || !module) {
      this.note(
        'unresolved-xref',
        element,
        `The link "${href}" names no topic in the archive; it is imported as its text.`,
      );
      label.forEach((n) => stream.inline(n));
      return;
    }
    const runs = label
      .filter((n): n is TextNode => n.type === 'text')
      .map((n) => {
        const kept = (n.marks ?? []).filter(
          (m) => m.type !== 'link' && m.type !== 'term',
        );
        return kept.length > 0
          ? { ...n, marks: kept }
          : { type: 'text' as const, text: n.text };
      });
    const node: Xref = {
      type: 'xref',
      module,
      ...(runs.length > 0 && { text: runs }),
    };
    const elementId = slash === -1 ? undefined : fragment?.slice(slash + 1);
    if (elementId !== undefined || topic !== top) {
      this.ctx.xrefs.push({
        node,
        rel: relOf(this.ctx.project, doc.path),
        topicId: topic.id,
        elementId,
        place: {
          source: `${this.doc.path}#${attr(element, 'id') ?? ''}`,
          kind: 'xref',
          module: this.moduleId,
        },
      });
    }
    stream.inline(node);
  }

  // Helpers -------------------------------------------------------------------

  /** The name an element is read as; a specialisation, generalised, is reported once per name and file. */
  private name(element: XmlElement): string | undefined {
    const name = nameOf(element);
    if (
      name !== undefined &&
      name !== element.local &&
      element.local !== MODULE_REF
    ) {
      const key = `${element.local}`;
      if (!this.seen.has(key)) {
        this.seen.add(key);
        this.note(
          'specialization',
          element,
          `The specialisation <${element.local}> is imported as <${name}>, the element its @class names.`,
        );
      }
    }
    return name;
  }

  private profile(element: XmlElement): { when?: Condition } {
    const profile = profileOf(
      element,
      this.ctx.profiling,
      this.ctx.report,
      this.place(element),
    );
    if (profile.audiences.length > 0) {
      this.note(
        'audience-condition',
        element,
        "Audience levels inside a topic have no counterpart (a module has one audience); this element's audience is left out.",
      );
    }
    return profile.when ? { when: profile.when } : {};
  }

  private wrap(
    profile: { when?: Condition },
    blocks: Block[],
    element: XmlElement,
  ): Block[] {
    return profile.when && blocks.length > 0
      ? this.conditioned(profile.when, blocks, element)
      : blocks;
  }

  /**
   * `blocks` under a condition. A variant block holds no section (the
   * model's rule), so a section keeps its place and title, and the
   * condition goes onto its content instead (reported: the title is in
   * every variant); the blocks before the first section are one variant.
   */
  private conditioned(
    when: Condition,
    blocks: readonly Block[],
    element: XmlElement,
    noted = false,
  ): Block[] {
    const fixed = fixSections(blocks);
    const first = fixed.findIndex((b) => b.type === 'section');
    const plain = first === -1 ? fixed : fixed.slice(0, first);
    const out: Block[] =
      plain.length > 0
        ? [
            {
              type: 'variant',
              // A profiled `div`'s @id is the variant block's (as the export writes one, #433).
              id: this.ids.take(
                'variant',
                !noted && nameOf(element) === 'div'
                  ? attr(element, 'id')
                  : undefined,
              ),
              when,
              blocks: plain,
            },
          ]
        : [];
    if (first === -1) return out;
    if (!noted)
      this.note(
        'section-condition',
        element,
        "A section's condition has no counterpart (a variant block holds no section): the condition is on its content, and its title is in every variant.",
      );
    for (const section of fixed.slice(first)) {
      if (section.type !== 'section') continue;
      out.push({
        ...section,
        blocks: this.conditioned(when, section.blocks, element, true),
      });
    }
    return out;
  }

  /** Records a block made from an element with an `@id`, for links to it. */
  private anchor(
    element: XmlElement,
    blockId: string,
    topic: TopicIndex | undefined,
    isTopicAnchor = false,
  ): void {
    const id = attr(element, 'id');
    if (id === undefined || element.attributes.has(BASE)) return;
    if (isTopicAnchor) {
      if (!this.anchors.has(id)) this.anchors.set(id, blockId);
      return;
    }
    const topicId = topic?.id ?? this.doc.firstTopic?.id ?? '';
    const key = `${topicId}/${id}`;
    if (!this.anchors.has(key)) this.anchors.set(key, blockId);
  }

  private place(element: XmlElement) {
    return {
      source:
        `${baseOf(element, this.doc)}#${attr(element, 'id') ?? ''}`.replace(
          /#$/,
          '',
        ),
      kind: element.local,
      module: this.moduleId,
    };
  }

  private note(
    code: DitaReportCode,
    element: XmlElement,
    message: string,
  ): void {
    this.ctx.report.add(code, this.place(element), message);
  }
}

/** The file's path within its language folder (a module's key). */
export function relOf(project: Project, path: string): string {
  return project.docs.get(path)?.rel ?? path;
}

/** The top-level topic `topic` lies in. */
function topLevelOf(
  project: Project,
  doc: DitaDoc,
  topic: TopicIndex,
): TopicIndex | undefined {
  // Up through the parents (at most the reader's depth), never across the file.
  let element: XmlElement | undefined = topic.element;
  while (element) {
    const found = doc.topics.get(attr(element, 'id') ?? '');
    if (found?.topLevel && found.element === element) return found;
    element = project.parents.get(element);
  }
  return undefined;
}

/** The nodes (elements and text) in `element`, itself included, and the characters of its text; iterative. */
function nodeCount(element: XmlElement): { nodes: number; chars: number } {
  let count = 0;
  let chars = 0;
  const stack: XmlNode[] = [element];
  while (stack.length > 0) {
    const node = stack.pop() as XmlNode;
    count++;
    if (typeof node === 'string') chars += node.length;
    if (typeof node !== 'string') pushAll(stack, node.children);
  }
  return { nodes: count, chars };
}

function hasText(nodes: readonly XmlNode[]): boolean {
  return nodes.some((n) => typeof n === 'string' && n.trim() !== '');
}

function textNode(text: string, marks: readonly Mark[]): TextNode {
  return marks.length > 0
    ? { type: 'text', text, marks: [...marks] }
    : { type: 'text', text };
}

function withMark(
  marks: readonly Mark[],
  type: Mark['type'],
  href?: string,
): Mark[] {
  if (marks.some((m) => m.type === type)) return [...marks];
  const mark = (type === 'link' ? { type, href } : { type }) as Mark;
  return [...marks, mark];
}

function mergeMarks(
  own: readonly Mark[] | undefined,
  outer: readonly Mark[],
): Mark[] {
  const out: Mark[] = (own ?? []).filter(
    (m) => m.type !== 'link' && m.type !== 'term',
  );
  for (const m of outer) if (!out.some((o) => o.type === m.type)) out.push(m);
  return out;
}

/**
 * Inline content as the model holds it: neighbouring runs with the same
 * marks joined, whitespace at the start and end trimmed, empty runs and a
 * break at either end dropped.
 */
export function tidy(nodes: readonly Inline[]): Inline[] {
  // Linear throughout: indexes and one new array, never shift, splice or an unanchored `\s+$`.
  const list = normalizeInline(
    nodes.filter((n) => n.type !== 'text' || n.text !== ''),
  );
  let from = 0;
  let head: Inline | undefined;
  for (; from < list.length; from++) {
    const node = list[from] as Inline;
    if (node.type === 'hardBreak') continue;
    if (node.type === 'text') {
      const text = node.text.trimStart();
      if (text === '') continue;
      head = { ...node, text };
    } else head = node;
    break;
  }
  let to = list.length - 1;
  let tail: Inline | undefined;
  for (; to >= from; to--) {
    const node = (to === from ? head : list[to]) as Inline;
    if (node.type === 'hardBreak') continue;
    if (node.type === 'text') {
      const text = node.text.trimEnd();
      if (text === '') continue;
      tail = { ...node, text };
    } else tail = node;
    break;
  }
  const kept: Inline[] = [];
  for (let i = from; i <= to; i++) {
    kept.push((i === to ? tail : i === from ? head : list[i]) as Inline);
  }
  // Spaces around a line break are no content.
  const out: Inline[] = [];
  for (let i = 0; i < kept.length; i++) {
    const node = kept[i] as Inline;
    if (node.type !== 'text') {
      out.push(node);
      continue;
    }
    let text = node.text;
    if (out[out.length - 1]?.type === 'hardBreak') text = trimStartSpaces(text);
    if (kept[i + 1]?.type === 'hardBreak') text = trimEndSpaces(text);
    if (text === node.text) out.push(node);
    else if (text !== '') out.push({ ...node, text });
  }
  return normalizeInline(out);
}

function trimStartSpaces(text: string): string {
  let at = 0;
  while (at < text.length && text.charCodeAt(at) === 32) at++;
  return text.slice(at);
}

function trimEndSpaces(text: string): string {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 32) end--;
  return text.slice(0, end);
}

/** The largest relative column width read as one (`1000000*`). */
const MAX_RELATIVE_WIDTH = 1_000_000;

/** Relative column widths (`2*`, `1.5*`) as whole numbers; any other unit shares the width (`onAbsolute`). */
function columnWidths(
  values: readonly (string | undefined)[],
  onAbsolute: () => void,
): number[] {
  let absolute = false;
  const parsed = values.map((value) => {
    if (value === undefined || value.trim() === '') return 1;
    // Trimmed first: whitespace on both sides of an optional group is quadratic to match.
    const star = /^(\d+(?:\.\d+)?)?\s*\*$/.exec(value.trim());
    const n = star && (star[1] === undefined ? 1 : Number(star[1]));
    // A width past any table's (or no finite number) is no proportion either.
    if (
      typeof n === 'number' &&
      Number.isFinite(n) &&
      n <= MAX_RELATIVE_WIDTH
    ) {
      return n;
    }
    absolute = true;
    return 1;
  });
  if (absolute) {
    onAbsolute();
    return values.map(() => 1);
  }
  const scaled = parsed.map((n) => Math.max(1, Math.round(n * 100)));
  const gcd = (a: number, b: number): number => {
    while (b !== 0) [a, b] = [b, a % b];
    return a;
  };
  const divisor = scaled.reduce((a, b) => gcd(a, b));
  return scaled.map((n) => n / divisor);
}

/**
 * Blocks with the model's section rule kept: once a section starts, a
 * later block of the same level belongs to it (into its last subsection).
 */
export function fixSections(blocks: readonly Block[]): Block[] {
  const out: Block[] = [];
  // The innermost last section's blocks, a copy of our own: appended to in place, so linear.
  let open: Block[] | undefined;
  for (const block of blocks) {
    if (block.type === 'section') {
      out.push(block);
      open = undefined;
    } else if (out[out.length - 1]?.type === 'section') {
      open ??= openSections(out);
      open.push(block);
    } else {
      out.push(block);
    }
  }
  return out;
}

/** Copies the chain of last sections in `list` (each once), returning the innermost one's blocks. */
function openSections(list: Block[]): Block[] {
  let container = list;
  for (;;) {
    const i = container.length - 1;
    const last = container[i];
    if (last?.type !== 'section') return container;
    const copy: Section = { ...last, blocks: [...last.blocks] };
    container[i] = copy;
    container = copy.blocks;
  }
}
