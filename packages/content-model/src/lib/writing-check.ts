/**
 * The writing checks (#55): forbidden and deprecated term variants and the configured style
 * rules, found in a module's translatable text. Pure and schema-free, so the API's checks and
 * the editor (#247, in the browser) run the same code on the same text.
 *
 * - **Terms:** a forbidden variant of an approved term in the module's language, matched
 *   without case as whole words (no stemming), is a `forbidden-term` finding with the term's
 *   preferred variant as its replacement; every variant of a deprecated term (`status:
 *   deprecated`) is one too, as a warning, with its replacement's preferred variant when it
 *   names one. A proposed term is not in force yet and checks nothing.
 * - **Style rules** (`styleRules` in `openfolia.yaml`, per language): a phrase (`words`, matched as
 *   terms are) or a pattern (`pattern`, the subset of `style-pattern.ts`, matched in linear
 *   time), each with its message, an optional replacement and its severity, and a longest
 *   sentence (`maxSentenceWords`). Each is a `style-rule` finding.
 *
 * Only typed text is read: inline nodes (attributes, cross-references, keys, callout
 * references) and text marked as code are never part of a finding, and literal and passthrough
 * blocks have no translatable text at all. The work is bounded: at most `MAX_WRITING_CHARS` of
 * text, `MAX_WRITING_FINDINGS` findings and `MAX_WRITING_STEPS` steps per call, after which the
 * result says it is incomplete (`complete: false`, `stopped`).
 */
import type { Inline } from './inline.js';
import type { Module } from './module.js';
import { plainTextOf } from './plain-text.js';
import {
  BREAK,
  prepareText,
  StylePattern,
  type PreparedText,
  type WritingBudget,
} from './style-pattern.js';
import type { Term } from './term.js';
import {
  translatableUnits,
  type TranslatableField,
} from './translatable-units.js';

/** How much a writing finding holds up: `blocking` holds review and release, as a check does. */
export const WRITING_SEVERITIES = ['warning', 'blocking'] as const;
export type WritingSeverity = (typeof WRITING_SEVERITIES)[number];

/** The most style rules one language has. */
export const MAX_STYLE_RULES = 200;
/** The longest phrase (`words`) of a style rule. */
export const MAX_STYLE_WORDS_LENGTH = 200;
/** The fewest and most words `maxSentenceWords` may allow. */
export const MIN_SENTENCE_WORDS = 5;
export const MAX_SENTENCE_WORDS = 200;

/** The rule ID a sentence's length is reported under: no configured rule may take it. */
export const SENTENCE_RULE_ID = 'max-sentence-words';

/** The most characters (UTF-16 code units) of a module's text one call checks. */
export const MAX_WRITING_CHARS = 1_000_000;
/** The most findings one call reports. */
export const MAX_WRITING_FINDINGS = 1_000;
/**
 * The most steps one call takes (a pattern's state looked at, a phrase looked up, a word
 * counted): what bounds a hostile pattern on a long text. Far above what the largest module
 * takes against `MAX_STYLE_RULES` ordinary rules (`writing-check.perf.spec.ts`).
 */
export const MAX_WRITING_STEPS = 60_000_000;

/** A style rule as `openfolia.yaml` holds it (`styleRules.<lang>.rules[]`). */
export interface StyleRule {
  readonly id: string;
  /** A phrase, matched without case (unless `matchCase`) as whole words. */
  readonly words?: string | undefined;
  /** A pattern of the subset (`style-pattern.ts`). */
  readonly pattern?: string | undefined;
  readonly matchCase?: boolean | undefined;
  readonly message: string;
  readonly replacement?: string | undefined;
  readonly severity?: WritingSeverity | undefined;
}

/** One language's style rules (`styleRules.<lang>`). */
export interface LanguageStyleRules {
  readonly maxSentenceWords?: number | undefined;
  readonly rules?: readonly StyleRule[] | undefined;
}

/** What the writing checks of one language are made from. */
export interface WritingRulesInput {
  /** Every term (those without the language check nothing in it). */
  readonly terms: readonly Term[];
  /** The configuration's `styleRules`, by language tag. */
  readonly styleRules?:
    Readonly<Record<string, LanguageStyleRules | undefined>> | undefined;
  /** The configuration's `terminology`. */
  readonly terminology?:
    { readonly forbiddenIsBlocking?: boolean | undefined } | undefined;
  /** The language checked (the module's). */
  readonly lang: string;
}

/** What a finding is about. */
export type WritingRuleRef =
  | {
      readonly kind: 'term';
      readonly termId: string;
      /** `forbidden`: a forbidden variant; `deprecated`: a variant of a deprecated term. */
      readonly status: 'forbidden' | 'deprecated';
      /** The variant's note, when the term gives one. */
      readonly note?: string;
    }
  | { readonly kind: 'style'; readonly ruleId: string }
  | {
      readonly kind: 'sentence-length';
      readonly words: number;
      readonly max: number;
    };

/** A finding in one piece of inline content. */
export interface TextFinding {
  readonly code: 'forbidden-term' | 'style-rule';
  readonly severity: WritingSeverity;
  /** UTF-16 offsets in `plainTextOf(content).text`, start inclusive, end exclusive. */
  readonly start: number;
  readonly end: number;
  /** The text found. */
  readonly text: string;
  readonly rule: WritingRuleRef;
  /** In English for a term or a sentence's length; a style rule's own message as configured. */
  readonly message: string;
  /** What to write instead (may be empty: delete it), when there is something to offer. */
  readonly replacement?: string;
}

/** A finding in a module: a `TextFinding` at a unit's block (or list item, callout) and field. */
export interface WritingFinding extends TextFinding {
  /** The block, list item or procedure step; for a callout's legend, the callout. */
  readonly blockId: string;
  /** For a callout's legend: the image block that holds the callout. */
  readonly image?: string;
  readonly field: TranslatableField;
}

/** Why a check stopped before the end. */
export type WritingStop = 'chars' | 'findings' | 'steps';

export interface WritingCheck<F extends TextFinding = WritingFinding> {
  /** In document order: by unit, field, then start. */
  readonly findings: readonly F[];
  /** Whether every rule was checked on all the text. */
  readonly complete: boolean;
  readonly stopped?: WritingStop;
}

// --- Words ------------------------------------------------------------------------------------

/** The words of a prepared text: runs of word characters, by code point index. */
interface Words {
  readonly start: Int32Array;
  readonly end: Int32Array;
  readonly count: number;
}

function wordsOf(t: PreparedText): Words {
  const start: number[] = [];
  const end: number[] = [];
  let i = 0;
  while (i < t.n) {
    if (t.word[i] !== 1) {
      i++;
      continue;
    }
    const s = i;
    while (i < t.n && t.word[i] === 1) i++;
    start.push(s);
    end.push(i);
  }
  return {
    start: Int32Array.from(start),
    end: Int32Array.from(end),
    count: start.length,
  };
}

const fold = (s: string, matchCase: boolean) =>
  matchCase ? s.normalize('NFC') : s.normalize('NFC').toLowerCase();

/**
 * The text between two code point indexes, or `undefined` when a stretch in it is blocked; reading
 * it costs a step per code point of `budget`, when one is given.
 */
function separator(
  t: PreparedText,
  from: number,
  to: number,
  matchCase: boolean,
  budget?: WritingBudget,
): string | undefined {
  if (budget) budget.steps -= Math.max(0, to - from);
  for (let i = from; i < to; i++)
    if ((t.cps[i] as number) < 0) return undefined;
  const raw = t.text.slice(t.offsets[from], t.offsets[to]);
  return fold(raw.replace(/\s+/gu, ' '), matchCase);
}

/** What a phrase found means. */
interface Hit {
  readonly lead: string;
  readonly trail: string;
  readonly make: (text: string) => Omit<TextFinding, 'start' | 'end' | 'text'>;
}

interface TrieNode {
  readonly next: Map<string, TrieNode>;
  hits?: Hit[];
}

/**
 * Phrases (term variants, style rules' words) as a trie of words and the separators between
 * them, so looking one up at a word costs as many steps as the phrase found has words, however
 * many phrases there are.
 */
class PhraseIndex {
  readonly #root: TrieNode = { next: new Map() };
  #size = 0;

  constructor(readonly matchCase: boolean) {}

  get size(): number {
    return this.#size;
  }

  /** Adds `phrase`; one without any word is never found, and is left out. */
  add(phrase: string, make: Hit['make']): void {
    const t = prepareText(phrase);
    const words = wordsOf(t);
    if (words.count === 0) return;
    let node = this.#root;
    for (let k = 0; k < words.count; k++) {
      const word = fold(
        t.text.slice(
          t.offsets[words.start[k] as number],
          t.offsets[words.end[k] as number],
        ),
        this.matchCase,
      );
      const key =
        k === 0
          ? word
          : `${separator(t, words.end[k - 1] as number, words.start[k] as number, this.matchCase) ?? ''}\u0000${word}`;
      let child = node.next.get(key);
      if (!child) {
        child = { next: new Map() };
        node.next.set(key, child);
      }
      node = child;
    }
    const lead = fold(
      t.text.slice(0, t.offsets[words.start[0] as number]),
      this.matchCase,
    ).trim();
    const trail = fold(
      t.text.slice(t.offsets[words.end[words.count - 1] as number]),
      this.matchCase,
    ).trim();
    (node.hits ??= []).push({ lead, trail, make });
    this.#size++;
  }

  /**
   * The phrases in `t` (whose words are `words`), the longest at each word, never
   * overlapping, in order of where they start, each costing a step; `false` when `budget` ran
   * out first. `found` returning `false` stops it (having found enough).
   */
  find(
    t: PreparedText,
    words: Words,
    text: (k: number) => string,
    budget: WritingBudget,
    found: (start: number, end: number, hit: Hit) => boolean,
  ): boolean {
    if (this.#size === 0) return true;
    let k = 0;
    while (k < words.count) {
      if (--budget.steps < 0) return false;
      let node = this.#root.next.get(text(k));
      let j = k;
      let best: { j: number; hits: Hit[] } | undefined;
      while (node) {
        if (node.hits) best = { j, hits: node.hits };
        if (j + 1 >= words.count) break;
        if (--budget.steps < 0) return false;
        const sep = separator(
          t,
          words.end[j] as number,
          words.start[j + 1] as number,
          this.matchCase,
          budget,
        );
        if (budget.steps < 0) return false;
        if (sep === undefined) break;
        node = node.next.get(`${sep}\u0000${text(j + 1)}`);
        j++;
      }
      let matched = false;
      if (best) {
        const s = words.start[k] as number;
        const e = words.end[best.j] as number;
        for (const hit of best.hits) {
          if (--budget.steps < 0) return false;
          const from = s - [...hit.lead].length;
          const to = e + [...hit.trail].length;
          if (from < 0 || to > t.n) continue;
          if (
            (hit.lead &&
              separator(t, from, s, this.matchCase, budget)?.trim() !==
                hit.lead) ||
            (hit.trail &&
              separator(t, e, to, this.matchCase, budget)?.trim() !== hit.trail)
          ) {
            continue;
          }
          if (!found(from, to, hit)) return true;
          matched = true;
        }
      }
      k = matched && best ? best.j + 1 : k + 1;
    }
    return true;
  }
}

/** `replacement` in the case of `found`: all capitals, or a capital first, as it was written. */
export function adaptCase(found: string, replacement: string): string {
  const letters = [...found].filter((c) => c.toLowerCase() !== c.toUpperCase());
  if (letters.length > 1 && letters.every((c) => c === c.toUpperCase())) {
    return replacement.toUpperCase();
  }
  const first = [...found][0];
  const head = [...replacement][0];
  if (
    first !== undefined &&
    head !== undefined &&
    first !== first.toLowerCase() &&
    head === head.toLowerCase()
  ) {
    return head.toUpperCase() + replacement.slice(head.length);
  }
  return replacement;
}

// --- Compiled rules ---------------------------------------------------------------------------

interface PatternRule {
  readonly rule: StyleRule;
  readonly pattern: StylePattern;
}

/** A language's writing checks, compiled once (per configuration, terms and language). */
export class WritingRules {
  readonly lang: string;
  readonly #terms = new PhraseIndex(false);
  readonly #words = new PhraseIndex(false);
  readonly #wordsCased = new PhraseIndex(true);
  readonly #patterns: PatternRule[] = [];
  readonly #maxSentenceWords: number | undefined;

  constructor(input: WritingRulesInput) {
    const { lang } = input;
    this.lang = lang;
    const blocking = input.terminology?.forbiddenIsBlocking === true;
    const byId = new Map(input.terms.map((term) => [term.id, term]));
    // Variants in force for a concept are never reported as another's deprecated ones.
    const inUse = new Set<string>();
    for (const term of input.terms) {
      const entry = term.languages[lang];
      if (!entry || term.status === 'deprecated') continue;
      inUse.add(fold(entry.preferred, false));
      for (const v of entry.allowed) inUse.add(fold(v.term, false));
    }
    for (const term of [...input.terms].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    )) {
      const entry = term.languages[lang];
      if (!entry) continue;
      if (term.status === 'approved') {
        for (const variant of entry.forbidden) {
          const preferred = entry.preferred;
          this.#terms.add(variant.term, (text) => ({
            code: 'forbidden-term',
            severity: blocking ? 'blocking' : 'warning',
            rule: {
              kind: 'term',
              termId: term.id,
              status: 'forbidden',
              ...(variant.note !== undefined && { note: variant.note }),
            },
            message: `"${text}" is a forbidden variant of the term "${term.id}": write "${preferred}".`,
            replacement: adaptCase(text, preferred),
          }));
        }
      } else if (term.status === 'deprecated') {
        const successor =
          term.replacedBy === undefined ? undefined : byId.get(term.replacedBy);
        const instead =
          successor && successor.status !== 'deprecated'
            ? successor.languages[lang]?.preferred
            : undefined;
        const variants = [
          { term: entry.preferred, note: undefined as string | undefined },
          ...entry.allowed,
          ...entry.forbidden,
        ];
        for (const variant of variants) {
          if (inUse.has(fold(variant.term, false))) continue;
          this.#terms.add(variant.term, (text) => ({
            code: 'forbidden-term',
            severity: 'warning',
            rule: {
              kind: 'term',
              termId: term.id,
              status: 'deprecated',
              ...(variant.note !== undefined && { note: variant.note }),
            },
            message:
              instead === undefined
                ? `"${text}" names the deprecated term "${term.id}".`
                : `"${text}" names the deprecated term "${term.id}": write "${instead}".`,
            ...(instead !== undefined && {
              replacement: adaptCase(text, instead),
            }),
          }));
        }
      }
    }
    const style = input.styleRules?.[lang];
    this.#maxSentenceWords = style?.maxSentenceWords;
    for (const rule of style?.rules ?? []) {
      const severity = rule.severity ?? 'warning';
      if (rule.words !== undefined) {
        const index = rule.matchCase ? this.#wordsCased : this.#words;
        index.add(rule.words, (text) => ({
          code: 'style-rule',
          severity,
          rule: { kind: 'style', ruleId: rule.id },
          message: rule.message,
          ...(rule.replacement !== undefined && {
            replacement: rule.matchCase
              ? rule.replacement
              : adaptCase(text, rule.replacement),
          }),
        }));
      } else if (rule.pattern !== undefined) {
        this.#patterns.push({
          rule,
          pattern: new StylePattern(rule.pattern, {
            matchCase: rule.matchCase ?? false,
          }),
        });
      }
    }
  }

  /** Whether there is nothing to check in this language. */
  get empty(): boolean {
    return (
      this.#terms.size === 0 &&
      this.#words.size === 0 &&
      this.#wordsCased.size === 0 &&
      this.#patterns.length === 0 &&
      this.#maxSentenceWords === undefined
    );
  }

  /**
   * The findings in `content`, in order of where they start; `false` when `budget` ran out. At
   * most `limit + 1` are found (the first ones), so a caller that keeps `limit` knows there were
   * more; what is held meanwhile is bounded by it too, however often a rule matches.
   */
  check(
    content: readonly Inline[],
    budget: WritingBudget,
    found: (finding: TextFinding) => void,
    limit: number = MAX_WRITING_FINDINGS,
  ): boolean {
    if (this.empty) return true;
    const t = checkableText(content);
    if (t.n === 0) return true;
    const words = wordsOf(t);
    const keep = Math.max(0, limit) + 1;
    const out: TextFinding[] = [];
    // Each source finds in order of where its findings start, so the first `keep` of each are
    // all that can be among the first `keep` of all; past that, the rest are dropped.
    let taken = 0;
    const take = (finding: TextFinding): boolean => {
      out.push(finding);
      return ++taken < keep;
    };
    const trim = () => {
      taken = 0;
      if (out.length <= keep) return;
      out.sort(byStart);
      out.length = keep;
    };
    const at = (s: number, e: number) => ({
      start: t.offsets[s] as number,
      end: t.offsets[e] as number,
      text: t.text.slice(t.offsets[s], t.offsets[e]),
    });
    // Each word folded once, the first time an index asks for it.
    const folded = (matchCase: boolean) => {
      const cache: (string | undefined)[] = [];
      return (k: number) =>
        (cache[k] ??= fold(
          t.text.slice(
            t.offsets[words.start[k] as number],
            t.offsets[words.end[k] as number],
          ),
          matchCase,
        ));
    };
    const anyCase = folded(false);
    let complete = true;
    for (const [index, text] of [
      [this.#terms, anyCase],
      [this.#words, anyCase],
      [this.#wordsCased, folded(true)],
    ] as const) {
      if (!complete) break;
      complete = index.find(t, words, text, budget, (s, e, hit) => {
        const where = at(s, e);
        return take({ ...where, ...hit.make(where.text) });
      });
      trim();
    }
    for (const { rule, pattern } of this.#patterns) {
      if (!complete) break;
      complete = pattern.matches(t, budget, (s, e) =>
        take({
          ...at(s, e),
          code: 'style-rule',
          severity: rule.severity ?? 'warning',
          rule: { kind: 'style', ruleId: rule.id },
          message: rule.message,
          ...(rule.replacement !== undefined && {
            replacement: rule.replacement,
          }),
        }),
      );
      trim();
    }
    if (complete && this.#maxSentenceWords !== undefined) {
      complete = longSentences(
        t,
        words,
        this.#maxSentenceWords,
        budget,
        (s, e, n) =>
          take({
            ...at(s, e),
            code: 'style-rule',
            severity: 'warning',
            rule: {
              kind: 'sentence-length',
              words: n,
              max: this.#maxSentenceWords as number,
            },
            message: `The sentence has ${n} words; the house style allows ${this.#maxSentenceWords}.`,
          }),
      );
      trim();
    }
    out.sort(byStart);
    for (const finding of out) found(finding);
    return complete;
  }
}

const byStart = (a: TextFinding, b: TextFinding) =>
  a.start - b.start || a.end - b.end;

/** Where a sentence ends: after one of these, before white space, a line break or the end. */
const SENTENCE_END = new Set(
  ['.', '!', '?', '…', '。', '！', '？', '‽', '؟', '।'].map(
    (c) => c.codePointAt(0) as number,
  ),
);
const isSpace = (cp: number) =>
  cp === 0x20 || (cp >= 0x09 && cp <= 0x0d) || cp === 0xa0 || cp === 0x3000;

/** The sentences of `t` with more than `max` words: from their first word to their end. */
function longSentences(
  t: PreparedText,
  words: Words,
  max: number,
  budget: WritingBudget,
  found: (start: number, end: number, words: number) => boolean,
): boolean {
  let k = 0;
  let first = -1;
  let count = 0;
  let last = 0;
  let enough = false;
  const close = (end: number) => {
    if (count > max && first >= 0 && !found(first, end, count)) enough = true;
    first = -1;
    count = 0;
  };
  for (let i = 0; i < t.n; i++) {
    if (enough) return true;
    if (--budget.steps < 0) return false;
    if (k < words.count && words.start[k] === i) {
      if (first < 0) first = i;
      count++;
      last = words.end[k] as number;
      k++;
    }
    const cp = t.cps[i] as number;
    if (cp === BREAK) {
      close(last);
    } else if (
      SENTENCE_END.has(cp) &&
      (i + 1 === t.n ||
        isSpace(t.cps[i + 1] as number) ||
        t.cps[i + 1] === BREAK)
    ) {
      close(i + 1);
    }
  }
  close(last);
  return true;
}

/**
 * `content` as text to check: `plainTextOf`'s text, with its atoms and the text marked as code
 * blocked (a finding never takes them in) and its line breaks marked as such.
 */
function checkableText(content: readonly Inline[]): PreparedText {
  const blocked: { start: number; end: number }[] = [];
  const breaks = new Set<number>();
  let offset = 0;
  let text = '';
  for (const node of content) {
    if (node.type === 'text') {
      if (node.marks?.some((m) => m.type === 'code')) {
        blocked.push({ start: offset, end: offset + node.text.length });
      }
      text += node.text;
      offset += node.text.length;
      continue;
    }
    const atom = plainTextOf([node]).text;
    if (node.type === 'hardBreak') breaks.add(offset);
    blocked.push({ start: offset, end: offset + atom.length });
    text += atom;
    offset += atom.length;
  }
  return prepareText(text, mergeRanges(blocked), breaks);
}

function mergeRanges(
  ranges: { start: number; end: number }[],
): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (const r of ranges) {
    if (r.end <= r.start) continue;
    const last = out[out.length - 1];
    if (last && last.end >= r.start) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

// --- Entry points -----------------------------------------------------------------------------

/** `input` compiled: once per configuration, terms and language, then for every check. */
export function compileWritingRules(input: WritingRulesInput): WritingRules {
  return new WritingRules(input);
}

const newBudget = (): WritingBudget => ({ steps: MAX_WRITING_STEPS });

/**
 * The writing findings of a module's translatable text (`translatableUnits`) in `rules`'s
 * language (the caller picks it: the module's own): terms and style rules, in document order.
 */
export function checkWriting(
  module: Module,
  rules: WritingRules | WritingRulesInput,
): WritingCheck {
  const compiled =
    rules instanceof WritingRules ? rules : compileWritingRules(rules);
  const findings: WritingFinding[] = [];
  if (compiled.empty) return { findings, complete: true };
  const budget = newBudget();
  let chars = 0;
  for (const unit of translatableUnits(module)) {
    for (const part of unit.parts) {
      chars += plainLength(part.content);
      if (chars > MAX_WRITING_CHARS) {
        return { findings, complete: false, stopped: 'chars' };
      }
      let full = false;
      const done = compiled.check(
        part.content,
        budget,
        (finding) => {
          if (findings.length >= MAX_WRITING_FINDINGS) {
            full = true;
            return;
          }
          findings.push({
            ...finding,
            blockId: unit.blockId,
            ...(unit.image !== undefined && { image: unit.image }),
            field: part.field,
          });
        },
        MAX_WRITING_FINDINGS - findings.length,
      );
      if (full) return { findings, complete: false, stopped: 'findings' };
      if (!done) return { findings, complete: false, stopped: 'steps' };
    }
  }
  return { findings, complete: true };
}

/**
 * The writing findings of one piece of inline content (a paragraph as it is typed, #247), with
 * offsets in `plainTextOf(content).text`; bounded as `checkWriting` is.
 */
export function checkWritingText(
  content: readonly Inline[],
  rules: WritingRules,
): WritingCheck<TextFinding> {
  const findings: TextFinding[] = [];
  if (plainLength(content) > MAX_WRITING_CHARS) {
    return { findings, complete: false, stopped: 'chars' };
  }
  let full = false;
  const done = rules.check(content, newBudget(), (finding) => {
    if (findings.length >= MAX_WRITING_FINDINGS) full = true;
    else findings.push(finding);
  });
  if (full) return { findings, complete: false, stopped: 'findings' };
  return done
    ? { findings, complete: true }
    : { findings, complete: false, stopped: 'steps' };
}

/** How long `content` is as plain text, without making it. */
function plainLength(content: readonly Inline[]): number {
  let n = 0;
  for (const node of content) {
    n +=
      node.type === 'text' ? node.text.length : plainTextOf([node]).text.length;
  }
  return n;
}
