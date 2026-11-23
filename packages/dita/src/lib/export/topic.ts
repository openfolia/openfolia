import type {
  Block,
  Image,
  Inline,
  Item,
  Mark,
  Module,
  Procedure,
  Safety,
  Section,
  Table,
} from '@openfolia/content-model';
import {
  assertTableWithinLimits,
  placeholderText,
  plainTextOf,
  walk,
} from '@openfolia/content-model';
import { fixSections } from '../topic.js';
import type { ExportProfiling } from './profiling.js';
import type { ExportReport } from './report.js';
import { el, type El, type Node, withAttrs } from './xml.js';

/** The topic types the export writes (the OASIS technical content shells'). */
export const TOPIC_TYPES = [
  'topic',
  'concept',
  'task',
  'reference',
  'troubleshooting',
] as const;
export type TopicType = (typeof TOPIC_TYPES)[number];

const BODY: Readonly<Record<TopicType, string>> = {
  topic: 'body',
  concept: 'conbody',
  task: 'taskbody',
  reference: 'refbody',
  troubleshooting: 'troublebody',
};

/** The topic type a nested topic of each type must have (each OASIS shell nests one). */
const NESTED: Readonly<Record<TopicType, TopicType>> = {
  topic: 'topic',
  concept: 'concept',
  task: 'task',
  reference: 'reference',
  troubleshooting: 'task',
};

/** A cross-reference written before its target's topic is: its address is filled in once every topic is (`ExportContext.links`). */
export interface PendingLink {
  readonly element: { attrs: [string, string][]; name: string };
  readonly module: string;
  readonly block: string | undefined;
}

/** What writing one topic needs from the export as a whole. */
export interface TopicContext {
  readonly profiling: ExportProfiling;
  readonly report: ExportReport;
  /** An image's or attached file's path from a topic (`../images/<hash>.png`); undefined for one not stored. */
  assetHref(ref: string, kind: 'image' | 'file'): string | undefined;
  /** A safety symbol's artwork's path from a topic; undefined for one without artwork. */
  symbolHref(id: string): string | undefined;
  /** The key a text attribute is written as (`<ph keyref>`). */
  keyOf(attribute: string): string;
  /** Cross-references, filled in when every topic is written. */
  readonly links: PendingLink[];
  /**
   * A module reference as a content reference: the element to write in its
   * place (its target's first top-level element, empty, with `@conref` and
   * `@conrefend`), or undefined when it cannot be one here (`inNote`: no
   * note may be in it; `inTable`: no table).
   */
  conref(
    module: string,
    where: { inNote: boolean; inTable: boolean },
  ): El | undefined;
  /** A module reference's target's blocks, their IDs prefixed (`<ref>--<id>`), to write in its place. */
  inline(ref: { id: string; module: string }): Block[];
}

/** Where a block is written: what may hold it. */
interface Where {
  /** A section may be here (a body, a nested topic's body). */
  readonly sections: boolean;
  readonly inNote: boolean;
  readonly inTable: boolean;
}

const TOP: Where = { sections: true, inNote: false, inTable: false };

/** Where text is written: whether a cross-reference may be (not in titles), and line breaks. */
interface InlineWhere {
  readonly xref: boolean;
  readonly breaks: boolean;
}

/** The order phrases are nested in: what may hold what in DITA 1.3 (`<uicontrol>` and `<term>` hold words only). */
const MARK_NESTING: readonly Mark['type'][] = [
  'link',
  'strong',
  'emphasis',
  'code',
  'sub',
  'sup',
  'ui',
  'term',
];

const MARK_ELEMENT: Readonly<Record<Exclude<Mark['type'], 'link'>, string>> = {
  strong: 'b',
  emphasis: 'i',
  code: 'codeph',
  sub: 'sub',
  sup: 'sup',
  ui: 'uicontrol',
  term: 'term',
};

/** Whether a procedure (or a variant block holding procedures only) joins the steps before it. */
function stepsOf(
  block: Block,
): { steps: Item[]; when: Block | undefined } | undefined {
  if (block.type === 'procedure' && block.title === undefined) {
    return { steps: block.steps, when: undefined };
  }
  if (
    block.type === 'variant' &&
    block.blocks.every((b) => b.type === 'procedure' && b.title === undefined)
  ) {
    return {
      steps: block.blocks.flatMap((b) => (b as Procedure).steps),
      when: block,
    };
  }
  return undefined;
}

/** The ID a topic gets: an XML name (a module ID may start with a digit). */
export function topicIdOf(module: string): string {
  return /^[a-z_]/.test(module) ? module : `m-${module}`;
}

/** Thrown when a module does not fit its topic type: it is written as a generic topic instead. */
class DoesNotFit extends Error {}

/**
 * Writes one module (in one language) as a DITA topic of `type` (#433):
 * its blocks as the topic type's body holds them, each block's ID as its
 * element's `@id` (so the import gives it back), variant blocks as `<div>`
 * with filter attributes, sections as `<section>`s, or as nested topics when
 * they have sections of their own. A module that does not fit its type (a
 * task with sections or two procedures, say) is written as a `<topic>`
 * (`topic-type`). Everything with no DITA counterpart is reported.
 */
/** How deep module references are followed (content put in, or a content reference's target found). */
export const MAX_REFERENCE_DEPTH = 16;

export class TopicWriter {
  /** How many module references' content is being written, one inside the other. */
  private inlining = 0;
  /** Each block ID's topic (a nested topic's, or the module's), for cross-references into it. */
  readonly anchors = new Map<string, string>();
  /** Each section written as a nested topic: that topic's ID. */
  readonly topics = new Map<string, string>();
  private topicStack: string[] = [];

  constructor(
    private readonly ctx: TopicContext,
    private readonly module: Module,
  ) {}

  /** The topic's root element; `type` is the one wanted, `written` the one it got. */
  write(
    type: TopicType,
    blocks: readonly Block[],
    rootAttrs: ReadonlyArray<readonly [string, string]>,
  ): { root: El; written: TopicType } {
    const id = topicIdOf(this.module.id);
    try {
      return { root: this.topic(type, id, blocks, rootAttrs), written: type };
    } catch (error) {
      if (!(error instanceof DoesNotFit)) throw error;
      this.anchors.clear();
      this.topics.clear();
      this.warn(
        'topic-type',
        undefined,
        `The module does not fit a DITA <${type}> (${error.message}); it is written as a <topic>.`,
      );
      return {
        root: this.topic('topic', id, blocks, rootAttrs),
        written: 'topic',
      };
    }
  }

  /**
   * A nested topic's `@id`: its section's, unless that is the module's
   * topic ID (topic IDs are `xs:ID`s, unique in the file); then one no
   * block of the module holds, reported (it imports as the section's ID).
   */
  private nestedTopicId(section: string): string {
    const root = topicIdOf(this.module.id);
    if (section !== root) return section;
    this.ids ??= new Set([...walk(this.module.blocks)].map((n) => n.node.id));
    let n = 1;
    let id = `${section}-section`;
    while (this.ids.has(id) || id === root) id = `${section}-section-${++n}`;
    this.ids.add(id);
    this.warn(
      'id-renamed',
      section,
      `The section’s ID is the topic’s; its nested topic is "${id}", the ID it imports as.`,
    );
    return id;
  }

  private ids: Set<string> | undefined;

  /** Reports procedures (and variant blocks of them) joined into the steps before them: their own IDs are not written. */
  private merged(joined: readonly Block[]): void {
    for (const block of joined) {
      this.warn(
        'procedures-merged',
        block.id,
        'A procedure right after another (or a variant block of one) is part of the same steps in DITA; its own ID is not kept, its steps’ are.',
      );
    }
  }

  private warn(
    code: Parameters<ExportReport['add']>[0],
    block: string | undefined,
    detail: string,
  ): void {
    this.ctx.report.add(code, { module: this.module.id, block }, detail);
  }

  // Topics ------------------------------------------------------------------

  private topic(
    type: TopicType,
    id: string,
    blocks: readonly Block[] | Block[],
    rootAttrs: ReadonlyArray<readonly [string, string]>,
    title?: Inline[],
  ): El {
    this.topicStack.push(id);
    try {
      // After a section every block is in one (the model's rule; content put in can break it).
      blocks = fixSections(blocks);
      const first = blocks.findIndex((b) => b.type === 'section');
      const plain = first === -1 ? blocks : blocks.slice(0, first);
      const sections = (first === -1 ? [] : blocks.slice(first)).filter(
        (b): b is Section => b.type === 'section',
      );
      const nested = sections.some((s) =>
        s.blocks.some((b) => b.type === 'section'),
      );
      if (
        sections.length > 0 &&
        (type === 'task' || type === 'troubleshooting')
      ) {
        throw new DoesNotFit('it has sections');
      }
      const body = this.body(type, plain, nested ? [] : sections);
      const children: (Node | undefined)[] = [
        title === undefined
          ? el('title', {}, [this.module.meta.title])
          : el('title', {}, this.inline(title, { xref: false, breaks: false })),
      ];
      if (title === undefined) children.push(this.prolog());
      children.push(body);
      if (nested) {
        for (const section of sections) {
          const topicId = this.nestedTopicId(section.id);
          this.anchors.set(section.id, topicId);
          this.topics.set(section.id, topicId);
          children.push(
            this.topic(
              NESTED[type],
              topicId,
              section.blocks,
              [],
              section.title,
            ),
          );
        }
      }
      return withAttrs(el(type, { id }, children), rootAttrs);
    } finally {
      this.topicStack.pop();
    }
  }

  private prolog(): El | undefined {
    const { keywords, facets, deprecated } = this.module.meta;
    if (Object.keys(facets ?? {}).length > 0) {
      this.warn(
        'metadata',
        undefined,
        'The module’s facets have no DITA counterpart; they are left out.',
      );
    }
    if (deprecated) {
      this.warn(
        'metadata',
        undefined,
        'The module’s deprecation has no DITA counterpart; it is left out.',
      );
    }
    if (!keywords || keywords.length === 0) return undefined;
    return el('prolog', {}, [
      el('metadata', {}, [
        el(
          'keywords',
          {},
          keywords.map((k) => el('keyword', {}, [k])),
        ),
      ]),
    ]);
  }

  private body(
    type: TopicType,
    plain: readonly Block[],
    sections: readonly Section[],
  ): El {
    const name = BODY[type];
    const sectionEls = () => sections.map((s) => this.section(s));
    switch (type) {
      case 'topic':
      case 'concept':
        return el(name, {}, [...this.blocks(plain, TOP), ...sectionEls()]);
      case 'reference': {
        // A reference body holds sections and tables only: the rest in one untitled section, so its blocks stay siblings.
        const content = this.blocks(plain, { ...TOP, sections: false });
        return el(name, {}, [
          content.length > 0 ? el('section', {}, content) : undefined,
          ...sectionEls(),
        ]);
      }
      case 'task':
        return this.taskbody(plain);
      case 'troubleshooting':
        return this.troublebody(plain);
    }
  }

  /** A strict task body: context, one `<steps>` (procedures one after another joined), result. */
  private taskbody(blocks: readonly Block[]): El {
    const start = blocks.findIndex((b) => b.type === 'procedure');
    if (start === -1) {
      const context = this.blocks(blocks, { ...TOP, sections: false });
      return el('taskbody', {}, [
        context.length > 0 ? el('context', {}, context) : undefined,
      ]);
    }
    const first = blocks[start] as Procedure;
    let end = start + 1;
    while (end < blocks.length && stepsOf(blocks[end] as Block)) end++;
    if (blocks.slice(end).some((b) => b.type === 'procedure')) {
      throw new DoesNotFit('it has procedures apart');
    }
    const context = this.blocks(blocks.slice(0, start), {
      ...TOP,
      sections: false,
    });
    if (first.title) {
      this.warn(
        'procedure-title',
        first.id,
        'A task’s steps have no title in DITA; the procedure’s title is a bold paragraph before them.',
      );
      context.push(this.boldParagraph(first.title));
    }
    this.merged(blocks.slice(start + 1, end));
    const steps = this.steps(first, blocks.slice(start + 1, end), 'steps');
    const result = this.blocks(blocks.slice(end), { ...TOP, sections: false });
    return el('taskbody', {}, [
      context.length > 0 ? el('context', {}, context) : undefined,
      steps,
      result.length > 0 ? el('result', {}, result) : undefined,
    ]);
  }

  /** A troubleshooting body: the blocks before the first procedure its condition, each procedure a remedy, the blocks before it the cause. */
  private troublebody(blocks: readonly Block[]): El {
    const where: Where = { ...TOP, sections: false };
    const children: El[] = [];
    let i = blocks.findIndex((b) => b.type === 'procedure');
    if (i === -1) {
      const cause = this.blocks(blocks, where);
      return el(
        'troublebody',
        {},
        cause.length > 0
          ? [el('troubleSolution', {}, [el('cause', {}, cause)])]
          : [],
      );
    }
    const condition = this.blocks(blocks.slice(0, i), where);
    if (condition.length > 0) children.push(el('condition', {}, condition));
    let pending: Block[] = [];
    while (i < blocks.length) {
      const block = blocks[i] as Block;
      if (block.type !== 'procedure') {
        pending.push(block);
        i++;
        continue;
      }
      let end = i + 1;
      while (end < blocks.length && stepsOf(blocks[end] as Block)) end++;
      this.merged(blocks.slice(i + 1, end));
      const cause = this.blocks(pending, where);
      pending = [];
      children.push(
        el('troubleSolution', {}, [
          cause.length > 0 ? el('cause', {}, cause) : undefined,
          el('remedy', {}, [
            block.title
              ? el(
                  'title',
                  {},
                  this.inline(block.title, { xref: false, breaks: false }),
                )
              : undefined,
            this.steps(block, blocks.slice(i + 1, end), 'steps'),
          ]),
        ]),
      );
      i = end;
    }
    const cause = this.blocks(pending, where);
    if (cause.length > 0) {
      children.push(el('troubleSolution', {}, [el('cause', {}, cause)]));
    }
    return el('troublebody', {}, children);
  }

  /** A procedure as `<steps>` (or `<substeps>`), the procedures and variant blocks of procedures after it joined. */
  private steps(
    first: Procedure,
    more: readonly Block[],
    name: 'steps' | 'substeps',
  ): El {
    const steps: El[] = first.steps.map((s) => this.step(s, name, undefined));
    for (const block of more) {
      const found = stepsOf(block);
      if (!found) continue;
      for (const step of found.steps) {
        steps.push(this.step(step, name, found.when));
      }
    }
    this.anchor(first.id);
    return el(name, { id: first.id }, steps);
  }

  private step(
    step: Item,
    list: 'steps' | 'substeps',
    when: Block | undefined,
  ): El {
    this.anchor(step.id);
    const children: (Node | undefined)[] = [
      el(
        'cmd',
        {},
        this.inline(step.content, { xref: true, breaks: false }, step.id),
      ),
    ];
    let info: Block[] = [];
    const flush = () => {
      if (info.length === 0) return;
      children.push(
        el('info', {}, this.blocks(info, { ...TOP, sections: false })),
      );
      info = [];
    };
    for (const block of step.blocks) {
      if (list === 'steps' && block.type === 'procedure' && !block.title) {
        flush();
        children.push(this.steps(block, [], 'substeps'));
      } else {
        info.push(block);
      }
    }
    flush();
    const attrs = when?.type === 'variant' ? this.profile(when) : [];
    return withAttrs(
      el(list === 'steps' ? 'step' : 'substep', { id: step.id }, children),
      attrs,
    );
  }

  private section(section: Section): El {
    this.anchor(section.id);
    return el('section', { id: section.id }, [
      el(
        'title',
        {},
        this.inline(section.title, { xref: false, breaks: false }),
      ),
      ...this.blocks(section.blocks, { ...TOP, sections: false }),
    ]);
  }

  // Blocks ------------------------------------------------------------------

  private blocks(blocks: readonly Block[], where: Where): El[] {
    const out: El[] = [];
    for (const block of blocks) out.push(...this.block(block, where));
    return out;
  }

  private anchor(id: string): void {
    const topic = this.topicStack[this.topicStack.length - 1];
    if (topic !== undefined && !this.anchors.has(id))
      this.anchors.set(id, topic);
  }

  private block(block: Block, where: Where): El[] {
    this.anchor(block.id);
    switch (block.type) {
      case 'paragraph':
        return [this.paragraph(block.id, block.content)];
      case 'section':
        // Only where sections may not be (a module reference's content put in): its title in bold.
        this.warn(
          'section-flattened',
          block.id,
          'A section where DITA holds none (inside a list, a note, a table or a task) is written as a bold paragraph and its content.',
        );
        return [
          this.boldParagraph(block.title, block.id),
          ...this.blocks(block.blocks, where),
        ];
      case 'list':
        return [
          el(
            block.ordered ? 'ol' : 'ul',
            { id: block.id },
            block.items.map((item) => this.item('li', item, where)),
          ),
        ];
      case 'procedure': {
        this.warn(
          'procedure-as-list',
          block.id,
          'Steps are a task’s only; outside one, a procedure is written as an ordered list.',
        );
        return [
          ...(block.title ? [this.boldParagraph(block.title)] : []),
          el(
            'ol',
            { id: block.id, outputclass: 'steps' },
            block.steps.map((step) => this.item('li', step, where)),
          ),
        ];
      }
      case 'table':
        return this.table(block, where);
      case 'image':
        return [this.image(block)];
      case 'attachment': {
        this.warn(
          'attachment',
          block.id,
          'An attached file has no DITA counterpart; it is a paragraph linking the file.',
        );
        const href = this.ctx.assetHref(block.asset, 'file');
        const ext = block.fileName.includes('.')
          ? block.fileName
              .slice(block.fileName.lastIndexOf('.') + 1)
              .toLowerCase()
          : undefined;
        return [
          el('p', { id: block.id }, [
            href === undefined
              ? block.name
              : el(
                  'xref',
                  {
                    href,
                    scope: 'local',
                    format:
                      ext && /^[a-z0-9]{1,16}$/.test(ext) ? ext : undefined,
                  },
                  [block.name],
                ),
            block.description === undefined
              ? undefined
              : ` (${block.description})`,
          ]),
        ];
      }
      case 'safety':
        return [this.safety(block, where)];
      case 'admonition': {
        if (where.inNote)
          return [this.nestedNote(block.id, block.blocks, where)];
        return [
          el(
            'note',
            { id: block.id, type: block.kind },
            this.blocks(block.blocks, {
              ...where,
              sections: false,
              inNote: true,
            }),
          ),
        ];
      }
      case 'faq':
        this.warn(
          'faq',
          block.id,
          'A question and answer has no DITA counterpart; it is a definition list (the question its term).',
        );
        return [
          el('dl', { id: block.id }, [
            el('dlentry', {}, [
              el(
                'dt',
                {},
                this.inline(block.question, { xref: false, breaks: false }),
              ),
              el(
                'dd',
                {},
                this.blocks(block.blocks, { ...where, sections: false }),
              ),
            ]),
          ]),
        ];
      case 'variant':
        return [
          withAttrs(
            el(
              'div',
              { id: block.id },
              this.blocks(block.blocks, { ...where, sections: false }),
            ),
            this.profile(block),
          ),
        ];
      case 'moduleRef': {
        const stub = this.ctx.conref(block.module, where);
        if (stub) return [withAttrs(stub, [['id', block.id]])];
        if (this.inlining >= MAX_REFERENCE_DEPTH) {
          this.ctx.report.add(
            'module-reference-cycle',
            { module: this.module.id, block: block.id },
            `References put in nest deeper than ${MAX_REFERENCE_DEPTH}; the reference to "${block.module}" is left out.`,
          );
          return [];
        }
        this.inlining++;
        try {
          return this.blocks(this.ctx.inline(block), where);
        } finally {
          this.inlining--;
        }
      }
      case 'literal':
        return [
          el(
            'codeblock',
            {
              id: block.id,
              outputclass: block.language && `language-${block.language}`,
            },
            [block.text],
          ),
        ];
      case 'passthrough':
        this.warn(
          'passthrough',
          block.id,
          `Raw ${block.format} source has no DITA counterpart; it is written as a code block.`,
        );
        return [el('codeblock', { id: block.id }, [block.raw])];
      case 'pageBreak':
        this.warn(
          'page-break',
          block.id,
          'A page break has no DITA counterpart; it is left out.',
        );
        return [];
    }
  }

  /** A variant block's condition as filter attributes (reported when DITA says it only for the shipped variants, or more broadly). */
  private profile(
    block: Extract<Block, { type: 'variant' }>,
  ): ReadonlyArray<readonly [string, string]> {
    const { attrs, fidelity } = this.ctx.profiling.attributes(block.when);
    if (fidelity === 'shipped') {
      this.warn(
        'condition-shipped',
        block.id,
        'The condition is written as the values the manual’s shipped variants hold (DITA filters by value, not by comparing versions or combining attributes).',
      );
    } else if (fidelity === 'approximated') {
      this.warn(
        'condition-approximated',
        block.id,
        'The condition has no form as DITA filter attributes; it is written as the values of the variants it holds in, which a DITAVAL file includes in more variants than the condition does.',
      );
    }
    return attrs;
  }

  private paragraph(id: string, content: readonly Inline[]): El {
    const breaks = content.some((n) => n.type === 'hardBreak');
    return el(
      breaks ? 'lines' : 'p',
      { id },
      this.inline(content, { xref: true, breaks }, id),
    );
  }

  private boldParagraph(title: readonly Inline[], id?: string): El {
    return el('p', { id }, [
      el('b', {}, this.inline(title, { xref: true, breaks: false })),
    ]);
  }

  private item(name: 'li', item: Item, where: Where): El {
    this.anchor(item.id);
    const text = this.inline(
      item.content,
      { xref: true, breaks: false },
      item.id,
    );
    if (item.blocks.length === 0) return el(name, { id: item.id }, text);
    // With blocks after it, the item's text is a paragraph of its own, named, so reading it takes no generated ID.
    return el(name, { id: item.id }, [
      el('p', { id: `${item.id}-text` }, text),
      ...this.blocks(item.blocks, { ...where, sections: false }),
    ]);
  }

  private nestedNote(id: string, blocks: readonly Block[], where: Where): El {
    this.warn(
      'nested-note',
      id,
      'A note or safety notice inside another has no DITA counterpart (a note holds none); its content is written in place.',
    );
    return el('div', { id }, this.blocks(blocks, where));
  }

  private safety(block: Safety, where: Where): El {
    if (where.inNote) {
      return this.nestedNote(
        block.id,
        [
          {
            type: 'paragraph',
            id: `${block.id}-hazard`,
            content: block.hazard,
          },
          ...block.blocks,
        ],
        where,
      );
    }
    const panel = block.blocks.every(
      (b) =>
        b.type === 'paragraph' ||
        (b.type === 'list' &&
          !b.ordered &&
          b.items.every((i) => i.blocks.length === 0)),
    );
    const hazard = this.inline(block.hazard, { xref: false, breaks: false });
    if (!panel) {
      if (block.symbols.length > 0) {
        this.warn(
          'safety-as-note',
          block.id,
          'A safety notice holding more than paragraphs and a simple list is a note of its severity, which holds no hazard symbol; its symbols are left out.',
        );
      }
      return el('note', { id: block.id, type: block.severity }, [
        el('p', {}, hazard),
        ...this.blocks(block.blocks, {
          ...where,
          sections: false,
          inNote: true,
        }),
      ]);
    }
    const avoid: El[] = block.blocks.map((b) => {
      this.anchor(b.id);
      return b.type === 'paragraph'
        ? el(
            'howtoavoid',
            { id: b.id },
            this.inline(b.content, { xref: true, breaks: false }, b.id),
          )
        : el('howtoavoid', {}, [
            el(
              'sl',
              { id: b.id },
              (b as Extract<Block, { type: 'list' }>).items.map((i) => {
                this.anchor(i.id);
                return el(
                  'sli',
                  { id: i.id },
                  this.inline(i.content, { xref: true, breaks: false }, i.id),
                );
              }),
            ),
          ]);
    });
    const symbols: El[] = [];
    for (const id of block.symbols) {
      const href = this.ctx.symbolHref(id);
      if (href === undefined) {
        this.warn(
          'missing-symbol',
          block.id,
          `The safety symbol "${id}" has no artwork; it is left out.`,
        );
        continue;
      }
      symbols.push(el('hazardsymbol', { href }));
    }
    return el('hazardstatement', { id: block.id, type: block.severity }, [
      el('messagepanel', {}, [
        el('typeofhazard', {}, hazard),
        ...(avoid.length > 0 ? avoid : [el('howtoavoid')]),
      ]),
      ...symbols,
    ]);
  }

  private image(block: Image): El {
    if (block.width !== undefined) {
      this.warn(
        'image-size',
        block.id,
        'An image’s width (a share of the text width) has no DITA counterpart; it is left out.',
      );
    }
    if (block.callouts && block.callouts.length > 0) {
      this.warn(
        'callouts',
        block.id,
        'Image callouts have no DITA counterpart; they are left out.',
      );
    }
    const href = this.ctx.assetHref(block.asset, 'image');
    if (href === undefined) {
      this.warn(
        'missing-asset',
        block.id,
        `The file "${block.asset}" is not stored; the image has no file.`,
      );
    }
    const image = (id?: string) =>
      el('image', { id, href, placement: 'break' }, [
        el('alt', {}, [block.alt]),
      ]);
    if (!block.title) return image(block.id);
    return el('fig', { id: block.id }, [
      el('title', {}, this.inline(block.title, { xref: false, breaks: false })),
      image(),
    ]);
  }

  private table(block: Table, where: Where): El[] {
    if (where.inTable) {
      this.warn(
        'nested-table',
        block.id,
        'A table inside a table has no DITA counterpart; its cells’ content is written in place.',
      );
      return block.rows.flatMap((r) =>
        r.cells.flatMap((c) => this.blocks(c.blocks, where)),
      );
    }
    // Never a table past the caps (#686), whose grid costs a place per row and column: content
    // that went through the schema has none.
    assertTableWithinLimits(block);
    const count = block.columns.length;
    const colspecs = block.columns.map((c, i) =>
      el('colspec', {
        colname: `c${i + 1}`,
        colwidth: `${c.width}*`,
        align: c.align,
      }),
    );
    // Where each row's cells start, the cells spanning rows from above skipped.
    const carried = new Array<number>(count).fill(0);
    const rows = block.rows.map((row) => {
      const entries: El[] = [];
      let col = 0;
      for (const cell of row.cells) {
        while (col < count && (carried[col] ?? 0) > 0) col++;
        const span = Math.max(1, Math.min(cell.colspan ?? 1, count - col));
        const rowspan = cell.rowspan ?? 1;
        entries.push(
          el(
            'entry',
            {
              namest: span > 1 ? `c${col + 1}` : undefined,
              nameend: span > 1 ? `c${col + span}` : undefined,
              morerows: rowspan > 1 ? String(rowspan - 1) : undefined,
            },
            this.blocks(cell.blocks, {
              sections: false,
              inNote: where.inNote,
              inTable: true,
            }),
          ),
        );
        for (let j = col; j < col + span && j < count; j++)
          carried[j] = rowspan;
        col += span;
      }
      for (let j = 0; j < count; j++) {
        if ((carried[j] ?? 0) > 0) carried[j] = (carried[j] ?? 0) - 1;
      }
      return el('row', {}, entries);
    });
    let head = block.header ? rows.slice(0, 1) : [];
    let body = block.header ? rows.slice(1) : rows;
    if (body.length === 0) {
      this.warn(
        'table-layout',
        block.id,
        'A table of its header row only: DITA needs a body row, so the header is its body.',
      );
      body = head;
      head = [];
    }
    return [
      el('table', { id: block.id }, [
        block.title
          ? el(
              'title',
              {},
              this.inline(block.title, { xref: false, breaks: false }),
            )
          : undefined,
        el('tgroup', { cols: String(count) }, [
          ...colspecs,
          head.length > 0 ? el('thead', {}, head) : undefined,
          el('tbody', {}, body),
        ]),
      ]),
    ];
  }

  // Inline ------------------------------------------------------------------

  private inline(
    content: readonly Inline[],
    where: InlineWhere,
    block?: string,
  ): Node[] {
    const out: Node[] = [];
    for (const node of content) {
      switch (node.type) {
        case 'text':
          out.push(this.marked(node.text, node.marks ?? [], where, block));
          break;
        case 'hardBreak':
          if (where.breaks) out.push('\n');
          else {
            this.warn(
              'line-break',
              block,
              'A line break where DITA holds none (a title, a list item, a step) is a space.',
            );
            out.push(' ');
          }
          break;
        case 'attribute':
          out.push(el('ph', { keyref: this.ctx.keyOf(node.name) }));
          break;
        case 'xref': {
          const text = node.text ?? [];
          const link = {
            name: 'xref',
            attrs: [] as [string, string][],
            children: text.map((t) =>
              this.marked(
                t.text,
                t.marks ?? [],
                { xref: false, breaks: false },
                block,
              ),
            ),
          };
          this.ctx.links.push({
            element: link,
            module: node.module,
            block: node.block,
          });
          out.push(where.xref ? link : el('ph', {}, [link]));
          break;
        }
        case 'kbd':
          this.warn(
            'keyboard',
            block,
            'A keyboard shortcut has no DITA 1.3 counterpart; it is user input.',
          );
          out.push(el('userinput', {}, [node.keys.join('+')]));
          break;
        case 'calloutRef': {
          this.warn(
            'callouts',
            block,
            'A reference to an image callout has no DITA counterpart; it is the callout’s legend.',
          );
          const legend = this.calloutLegend(node.block, node.callout);
          if (legend !== '') out.push(legend);
          break;
        }
        case 'placeholder':
          out.push(placeholderText(node.key));
          break;
      }
    }
    return out;
  }

  private calloutLegend(image: string, callout: string): string {
    const stack: Block[] = [...this.module.blocks];
    while (stack.length > 0) {
      const b = stack.pop() as Block;
      if (b.type === 'image' && b.id === image) {
        const found = b.callouts?.find((c) => c.id === callout);
        return found ? plainTextOf(found.legend).text : '';
      }
      if ('blocks' in b) stack.push(...b.blocks);
      if (b.type === 'list') stack.push(...b.items.flatMap((i) => i.blocks));
      if (b.type === 'procedure')
        stack.push(...b.steps.flatMap((i) => i.blocks));
      if (b.type === 'table')
        stack.push(...b.rows.flatMap((r) => r.cells.flatMap((c) => c.blocks)));
    }
    return '';
  }

  /** A text run in its phrases, nested as DITA allows; a link outermost (wrapped in `<ph>` where no cross-reference may be). */
  private marked(
    text: string,
    marks: readonly Mark[],
    where: InlineWhere,
    block: string | undefined,
  ): Node {
    let node: Node = text;
    const sorted = [...marks].sort(
      (a, b) => MARK_NESTING.indexOf(b.type) - MARK_NESTING.indexOf(a.type),
    );
    for (const mark of sorted) {
      if (mark.type === 'link') {
        const link = el(
          'xref',
          {
            href: mark.href,
            scope: 'external',
            format: /^https?:/i.test(mark.href) ? 'html' : undefined,
          },
          [node],
        );
        node = where.xref ? link : el('ph', {}, [link]);
        continue;
      }
      if (mark.type === 'term') {
        this.warn(
          'term-link',
          block,
          'A term link has no DITA counterpart here; it is a <term>, without its link to the glossary.',
        );
      }
      node = el(MARK_ELEMENT[mark.type], {}, [node]);
    }
    return node;
  }
}
