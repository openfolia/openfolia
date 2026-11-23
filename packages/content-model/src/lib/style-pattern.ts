/**
 * The patterns of the configured style rules (#55, `styleRules` in `openfolia.yaml`): a small subset
 * of regular expressions, matched by our own automaton, never by `RegExp`. A pattern is untrusted
 * configuration, so a JavaScript regular expression's backtracking (`(a+)+$` on a long run of
 * `a`, exponential) is out of the question: here each character of the text is looked at once
 * per state of the pattern's program (a Thompson automaton simulated as a Pike VM), so matching
 * is linear in the text, its factor bounded by `MAX_STYLE_PATTERN_STATES`, and every step is
 * counted against a budget (`WritingBudget`) the caller sets.
 *
 * Schema-free (no zod, no yaml): the editor runs it in the browser (#247).
 */

/** The longest pattern (UTF-16 code units). */
export const MAX_STYLE_PATTERN_LENGTH = 200;
/** The largest count in a counted repetition (`{n}`, `{n,}`, `{n,m}`). */
export const MAX_STYLE_PATTERN_REPEAT = 20;
/** The most instructions a pattern compiles to (counted repetitions expanded). */
export const MAX_STYLE_PATTERN_STATES = 300;

/** A pattern outside the subset, or too large. */
export class StylePatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StylePatternError';
  }
}

/**
 * Steps left for the writing checks of one call (a pattern's state looked at, a phrase looked
 * up): when they run out, matching stops and the result says it is incomplete.
 */
export interface WritingBudget {
  steps: number;
}

/**
 * Code points of a text prepared for matching: `cps[i]` the code point (`BLOCKED` where the text
 * is no typed text, an inline node or code, `BREAK` at a line break), `offsets[i]` its UTF-16
 * offset in the text (`offsets[n]` the text's length), whether it is a word character, and its
 * lower and upper case (for matching without case).
 */
export interface PreparedText {
  readonly text: string;
  readonly n: number;
  readonly cps: Int32Array;
  readonly offsets: Int32Array;
  readonly word: Uint8Array;
  readonly lower: Int32Array;
  readonly upper: Int32Array;
}

/** A stretch that is no typed text (an attribute, a cross-reference, inline code). */
export const BLOCKED = -1;
/** A line break (a hard break): no pattern matches it, and a sentence ends there. */
export const BREAK = -2;

const WORD_CHAR = /[\p{L}\p{M}\p{N}_]/uy;
const caseCache = new Map<number, readonly [number, number]>();

/** Whether code point `cp` is a word character: a letter, a mark, a digit or `_`. */
function isWordAt(text: string, offset: number, cp: number): boolean {
  if (cp < 0x80) {
    return (
      (cp >= 0x30 && cp <= 0x39) ||
      (cp >= 0x41 && cp <= 0x5a) ||
      (cp >= 0x61 && cp <= 0x7a) ||
      cp === 0x5f
    );
  }
  WORD_CHAR.lastIndex = offset;
  return WORD_CHAR.test(text);
}

/** The lower and upper case of `cp`, where each is one code point (else `cp` itself). */
function casesOf(cp: number): readonly [number, number] {
  if (cp < 0x80) {
    if (cp >= 0x41 && cp <= 0x5a) return [cp + 32, cp];
    if (cp >= 0x61 && cp <= 0x7a) return [cp, cp - 32];
    return [cp, cp];
  }
  let found = caseCache.get(cp);
  if (found === undefined) {
    const s = String.fromCodePoint(cp);
    const one = (t: string) => {
      const c = t.codePointAt(0) as number;
      return t.length === String.fromCodePoint(c).length ? c : cp;
    };
    found = [one(s.toLowerCase()), one(s.toUpperCase())];
    if (caseCache.size < 10_000) caseCache.set(cp, found);
  }
  return found;
}

/**
 * `text` prepared for matching; `blocked` are ranges (UTF-16 offsets, start inclusive, end
 * exclusive, in order) that are no typed text, `breaks` the offsets of line breaks among them.
 */
export function prepareText(
  text: string,
  blocked: readonly { readonly start: number; readonly end: number }[] = [],
  breaks: ReadonlySet<number> = new Set(),
): PreparedText {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    n++;
  }
  const cps = new Int32Array(n);
  const offsets = new Int32Array(n + 1);
  const word = new Uint8Array(n);
  const lower = new Int32Array(n);
  const upper = new Int32Array(n);
  let b = 0;
  let offset = 0;
  for (let i = 0; i < n; i++) {
    const cp = text.codePointAt(offset) as number;
    offsets[i] = offset;
    while (b < blocked.length && (blocked[b] as { end: number }).end <= offset)
      b++;
    const range = blocked[b];
    if (range !== undefined && range.start <= offset) {
      const mark = breaks.has(offset) ? BREAK : BLOCKED;
      cps[i] = mark;
      lower[i] = mark;
      upper[i] = mark;
    } else {
      cps[i] = cp;
      word[i] = isWordAt(text, offset, cp) ? 1 : 0;
      const [lo, up] = casesOf(cp);
      lower[i] = lo;
      upper[i] = up;
    }
    offset += cp > 0xffff ? 2 : 1;
  }
  offsets[n] = text.length;
  return { text, n, cps, offsets, word, lower, upper };
}

// --- Parsing ---------------------------------------------------------------------------------

/** A set of code points: ranges (pairs, inclusive), classes, negated or not. */
interface CharSet {
  readonly ranges: readonly number[];
  readonly classes: readonly Shorthand[];
  readonly negated: boolean;
}
type Shorthand = 'd' | 'D' | 'w' | 'W' | 's' | 'S' | 'any';

type Node =
  | { readonly t: 'set'; readonly set: CharSet }
  | { readonly t: 'assert'; readonly kind: Assertion }
  | { readonly t: 'cat'; readonly items: readonly Node[] }
  | { readonly t: 'alt'; readonly items: readonly Node[] }
  | {
      readonly t: 'rep';
      readonly item: Node;
      readonly min: number;
      readonly max: number;
    };
type Assertion = 'start' | 'end' | 'word' | 'nonword';

const META = '\\^$.|?*+()[]{}/-';
const SHORTHANDS = 'dDwWsS';

class Parser {
  i = 0;
  constructor(readonly src: string) {}

  fail(what: string): never {
    throw new StylePatternError(`${what} (at character ${this.i + 1})`);
  }

  peek(): string | undefined {
    return this.src[this.i];
  }

  parse(): Node {
    const node = this.alt();
    if (this.i < this.src.length) this.fail('unbalanced ")"');
    return node;
  }

  alt(): Node {
    const items = [this.seq()];
    while (this.peek() === '|') {
      this.i++;
      items.push(this.seq());
    }
    return items.length === 1 ? (items[0] as Node) : { t: 'alt', items };
  }

  seq(): Node {
    const items: Node[] = [];
    for (;;) {
      const c = this.peek();
      if (c === undefined || c === '|' || c === ')') break;
      const atom = this.atom();
      items.push(this.quantified(atom));
    }
    return items.length === 1 ? (items[0] as Node) : { t: 'cat', items };
  }

  quantified(atom: Node): Node {
    const c = this.peek();
    let min: number;
    let max: number;
    if (c === '*') [min, max] = [0, Infinity];
    else if (c === '+') [min, max] = [1, Infinity];
    else if (c === '?') [min, max] = [0, 1];
    else if (c === '{') {
      const m = /^\{(\d{1,3})(,(\d{0,3}))?\}/.exec(this.src.slice(this.i));
      if (!m) this.fail('a "{" that starts no count: write "\\{"');
      min = Number(m[1]);
      max = m[2] === undefined ? min : m[3] === '' ? Infinity : Number(m[3]);
      if (
        min > MAX_STYLE_PATTERN_REPEAT ||
        (max < Infinity && max > MAX_STYLE_PATTERN_REPEAT)
      ) {
        this.fail(`a count above ${MAX_STYLE_PATTERN_REPEAT}`);
      }
      if (max < min) this.fail('a count whose maximum is below its minimum');
      this.i += m[0].length - 1;
    } else return atom;
    if (atom.t === 'assert') this.fail('a repeated assertion');
    this.i++;
    const next = this.peek();
    if (next === '?' || next === '+') {
      this.fail('lazy and possessive repetition are not supported');
    }
    if (next === '*' || next === '{') this.fail('a repetition repeated');
    return { t: 'rep', item: atom, min, max };
  }

  atom(): Node {
    const c = this.src[this.i] as string;
    switch (c) {
      case '(': {
        this.i++;
        if (this.peek() === '?') {
          if (this.src[this.i + 1] !== ':') {
            this.fail(
              'lookaround, named groups and flags are not supported; only "(?:…)"',
            );
          }
          this.i += 2;
        }
        const inner = this.alt();
        if (this.peek() !== ')') this.fail('a "(" without its ")"');
        this.i++;
        return inner;
      }
      case '[':
        return { t: 'set', set: this.charClass() };
      case '.':
        this.i++;
        return {
          t: 'set',
          set: { ranges: [], classes: ['any'], negated: false },
        };
      case '^':
        this.i++;
        return { t: 'assert', kind: 'start' };
      case '$':
        this.i++;
        return { t: 'assert', kind: 'end' };
      case '\\': {
        const e = this.src[this.i + 1];
        if (e === 'b' || e === 'B') {
          this.i += 2;
          return { t: 'assert', kind: e === 'b' ? 'word' : 'nonword' };
        }
        const set = this.escape(false);
        return { t: 'set', set };
      }
      case '*':
      case '+':
      case '?':
        return this.fail('a repetition of nothing');
      case '{':
        return this.fail('a "{" that starts no count: write "\\{"');
      case '}':
      case ']':
        return this.fail(`a lone "${c}": write "\\${c}"`);
      default: {
        const cp = this.src.codePointAt(this.i) as number;
        this.i += cp > 0xffff ? 2 : 1;
        return {
          t: 'set',
          set: { ranges: [cp, cp], classes: [], negated: false },
        };
      }
    }
  }

  /** An escape at `\`: a shorthand class, a control character or an escaped sign. */
  escape(inClass: boolean): CharSet {
    const e = this.src[this.i + 1];
    if (e === undefined) this.fail('a "\\" at the end');
    this.i += 2;
    if (SHORTHANDS.includes(e)) {
      return { ranges: [], classes: [e as Shorthand], negated: false };
    }
    const single = (cp: number): CharSet => ({
      ranges: [cp, cp],
      classes: [],
      negated: false,
    });
    if (e === 'n') return single(0x0a);
    if (e === 't') return single(0x09);
    if (e === 'r') return single(0x0d);
    if (META.includes(e) || (inClass && e === ']'))
      return single(e.charCodeAt(0));
    this.i -= 2;
    return this.fail(
      `"\\${e}" is not supported (back-references, \\p and the like are not)`,
    );
  }

  charClass(): CharSet {
    this.i++; // [
    let negated = false;
    if (this.peek() === '^') {
      negated = true;
      this.i++;
    }
    const ranges: number[] = [];
    const classes: Shorthand[] = [];
    let first = true;
    for (;;) {
      const c = this.peek();
      if (c === undefined) this.fail('a "[" without its "]"');
      if (c === ']' && !first) {
        this.i++;
        break;
      }
      if (c === ']') this.fail('an empty class "[]"');
      if (c === '[') this.fail('a "[" inside a class: write "\\["');
      first = false;
      const lo = this.classChar(classes);
      if (lo === undefined) continue;
      if (
        this.peek() === '-' &&
        this.src[this.i + 1] !== ']' &&
        this.src[this.i + 1] !== undefined
      ) {
        this.i++;
        const hi = this.classChar(classes);
        if (hi === undefined) this.fail('a range that ends in a class');
        if (hi < lo) this.fail('a range out of order');
        ranges.push(lo, hi);
      } else {
        ranges.push(lo, lo);
      }
    }
    return { ranges, classes, negated };
  }

  /** One character of a class (its code point), or a shorthand added to `classes`. */
  classChar(classes: Shorthand[]): number | undefined {
    if (this.peek() === '\\') {
      const set = this.escape(true);
      if (set.classes.length > 0) {
        classes.push(...set.classes);
        return undefined;
      }
      return set.ranges[0] as number;
    }
    const cp = this.src.codePointAt(this.i) as number;
    this.i += cp > 0xffff ? 2 : 1;
    return cp;
  }
}

/** Whether `node` matches the empty text (then it is refused: it would match everywhere). */
function nullable(node: Node): boolean {
  switch (node.t) {
    case 'set':
      return false;
    case 'assert':
      return true;
    case 'cat':
      return node.items.every(nullable);
    case 'alt':
      return node.items.some(nullable);
    case 'rep':
      return node.min === 0 || nullable(node.item);
  }
}

// --- Compiling -------------------------------------------------------------------------------

const CHAR = 0;
const SPLIT = 1;
const JMP = 2;
const ASSERT = 3;
const MATCH = 4;

interface Instr {
  op: number;
  x: number;
  y: number;
  set?: CharSet;
  kind?: Assertion;
}

function compileNode(node: Node, out: Instr[]): void {
  const guard = () => {
    if (out.length > MAX_STYLE_PATTERN_STATES) {
      throw new StylePatternError(
        `the pattern is too large: more than ${MAX_STYLE_PATTERN_STATES} states once its repetitions are counted out`,
      );
    }
  };
  switch (node.t) {
    case 'set':
      out.push({ op: CHAR, x: 0, y: 0, set: node.set });
      break;
    case 'assert':
      out.push({ op: ASSERT, x: 0, y: 0, kind: node.kind });
      break;
    case 'cat':
      for (const item of node.items) compileNode(item, out);
      break;
    case 'alt': {
      // split L1, next; L1: a; jmp end; next: split L2, ...
      const jumps: Instr[] = [];
      node.items.forEach((item, k) => {
        if (k < node.items.length - 1) {
          const split: Instr = { op: SPLIT, x: out.length + 1, y: 0 };
          out.push(split);
          compileNode(item, out);
          const jmp: Instr = { op: JMP, x: 0, y: 0 };
          out.push(jmp);
          jumps.push(jmp);
          split.y = out.length;
        } else {
          compileNode(item, out);
        }
        guard();
      });
      for (const jmp of jumps) jmp.x = out.length;
      break;
    }
    case 'rep': {
      for (let k = 0; k < node.min; k++) {
        compileNode(node.item, out);
        guard();
      }
      if (node.max === Infinity) {
        // L: split body, end; body; jmp L
        const split: Instr = { op: SPLIT, x: out.length + 1, y: 0 };
        out.push(split);
        compileNode(node.item, out);
        out.push({ op: JMP, x: out.indexOf(split), y: 0 });
        split.y = out.length;
      } else {
        const splits: Instr[] = [];
        for (let k = node.min; k < node.max; k++) {
          const split: Instr = { op: SPLIT, x: out.length + 1, y: 0 };
          out.push(split);
          splits.push(split);
          compileNode(node.item, out);
          guard();
        }
        for (const split of splits) split.y = out.length;
      }
      break;
    }
  }
  guard();
}

/** Whether `cp` (a real code point) is in `set`, ignoring `negated`. */
function inSet(set: CharSet, cp: number): boolean {
  const r = set.ranges;
  for (let k = 0; k < r.length; k += 2) {
    if (cp >= (r[k] as number) && cp <= (r[k + 1] as number)) return true;
  }
  return false;
}

const SPACE = /\s/u;

function inClass(cls: Shorthand, cp: number, isWord: boolean): boolean {
  switch (cls) {
    case 'any':
      return true;
    case 'd':
      return cp >= 0x30 && cp <= 0x39;
    case 'D':
      return !(cp >= 0x30 && cp <= 0x39);
    case 'w':
      return isWord;
    case 'W':
      return !isWord;
    case 's':
      return cp < 0x80
        ? cp === 0x20 || (cp >= 0x09 && cp <= 0x0d)
        : SPACE.test(String.fromCodePoint(cp));
    case 'S':
      return !(cp < 0x80
        ? cp === 0x20 || (cp >= 0x09 && cp <= 0x0d)
        : SPACE.test(String.fromCodePoint(cp)));
  }
}

/** A compiled pattern. */
export class StylePattern {
  readonly #op: Uint8Array;
  readonly #x: Int32Array;
  readonly #y: Int32Array;
  readonly #sets: (CharSet | undefined)[];
  readonly #kinds: (Assertion | undefined)[];
  readonly #matchCase: boolean;

  constructor(
    readonly source: string,
    options: { matchCase?: boolean } = {},
  ) {
    if (source.length === 0) throw new StylePatternError('an empty pattern');
    if (source.length > MAX_STYLE_PATTERN_LENGTH) {
      throw new StylePatternError(
        `longer than ${MAX_STYLE_PATTERN_LENGTH} characters`,
      );
    }
    const node = new Parser(source).parse();
    if (nullable(node)) {
      throw new StylePatternError('the pattern matches empty text');
    }
    const program: Instr[] = [];
    compileNode(node, program);
    program.push({ op: MATCH, x: 0, y: 0 });
    if (program.length > MAX_STYLE_PATTERN_STATES) {
      throw new StylePatternError(
        `the pattern is too large: more than ${MAX_STYLE_PATTERN_STATES} states once its repetitions are counted out`,
      );
    }
    this.#op = Uint8Array.from(program, (p) => p.op);
    this.#x = Int32Array.from(program, (p) => p.x);
    this.#y = Int32Array.from(program, (p) => p.y);
    this.#sets = program.map((p) => p.set);
    this.#kinds = program.map((p) => p.kind);
    this.#matchCase = options.matchCase ?? false;
    // The characters a match can start with (assertions read as passing): a position whose
    // character is none of them starts no thread, which is most positions of most texts.
    const firsts: CharSet[] = [];
    const seen = new Set<number>();
    const todo = [0];
    while (todo.length > 0) {
      const pc = todo.pop() as number;
      if (seen.has(pc)) continue;
      seen.add(pc);
      const p = program[pc] as Instr;
      if (p.op === CHAR && !firsts.includes(p.set as CharSet)) {
        firsts.push(p.set as CharSet);
      } else if (p.op === SPLIT) todo.push(p.x, p.y);
      else if (p.op === JMP) todo.push(p.x);
      else if (p.op === ASSERT) todo.push(pc + 1);
    }
    this.#firsts = firsts;
    const ascii = new Uint8Array(128);
    const probe = prepareText(
      Array.from({ length: 128 }, (_, c) => String.fromCharCode(c)).join(''),
    );
    for (let c = 0; c < 128; c++) {
      if (firsts.some((set) => this.#accepts(set, probe, c))) ascii[c] = 1;
    }
    this.#asciiFirst = ascii;
  }

  readonly #firsts: readonly CharSet[];
  readonly #asciiFirst: Uint8Array;
  /**
   * Whether a match may start with a code point beyond ASCII, per code point once worked out
   * (it depends on the code point alone: its cases and whether it is a word character). Kept
   * across texts; at most one entry per code point.
   */
  readonly #otherFirst = new Map<number, boolean>();

  /**
   * Whether a match may start at `i`: its character is one a match starts with. Working it out
   * for a code point beyond ASCII the first time costs a step per first set it reads.
   */
  #canStart(t: PreparedText, i: number, budget: WritingBudget): boolean {
    const cp = t.cps[i] as number;
    if (cp < 0) return false;
    if (cp < 128) return this.#asciiFirst[cp] === 1;
    const known = this.#otherFirst.get(cp);
    if (known !== undefined) return known;
    let can = false;
    for (const set of this.#firsts) {
      budget.steps--;
      if (this.#accepts(set, t, i)) {
        can = true;
        break;
      }
    }
    this.#otherFirst.set(cp, can);
    return can;
  }

  /** How many instructions the pattern compiled to. */
  get size(): number {
    return this.#op.length;
  }

  #accepts(set: CharSet, t: PreparedText, i: number): boolean {
    const cp = t.cps[i] as number;
    if (cp < 0) return false;
    const isWord = t.word[i] === 1;
    let hit = inSet(set, cp);
    if (!hit && !this.#matchCase) {
      const lo = t.lower[i] as number;
      const up = t.upper[i] as number;
      hit = (lo !== cp && inSet(set, lo)) || (up !== cp && inSet(set, up));
    }
    if (!hit) {
      for (const cls of set.classes) {
        if (inClass(cls, cp, isWord)) {
          hit = true;
          break;
        }
      }
    }
    return set.negated ? !hit : hit;
  }

  #holds(kind: Assertion, t: PreparedText, i: number): boolean {
    switch (kind) {
      case 'start':
        return i === 0;
      case 'end':
        return i === t.n;
      case 'word':
      case 'nonword': {
        const before = i > 0 && t.word[i - 1] === 1;
        const after = i < t.n && t.word[i] === 1;
        return (before !== after) === (kind === 'word');
      }
    }
  }

  /**
   * The matches in `t`, leftmost first, each the longest from where it starts, never
   * overlapping (code point indexes, end exclusive), to `found`; a match never takes in a
   * blocked stretch. Returns `false` when `budget` ran out first (then not every match was
   * found). `found` returning `false` stops it, having found enough (then it returns `true`).
   */
  matches(
    t: PreparedText,
    budget: WritingBudget,
    found: (start: number, end: number) => boolean | void,
  ): boolean {
    const size = this.#op.length;
    // A call costs its program's size (what it allocates), and each position read an eighth of
    // a step (`POSITION_STEPS`), so neither many short texts nor a long one escape the budget.
    budget.steps -= size;
    if (budget.steps < 0) return false;
    const op = this.#op;
    const x = this.#x;
    const y = this.#y;
    let cur = new Int32Array(size);
    let curStart = new Int32Array(size);
    let curLen = 0;
    let nxt = new Int32Array(size);
    let nxtStart = new Int32Array(size);
    let nxtLen: number;
    const mark = new Int32Array(size).fill(-1);
    const stack = new Int32Array(size + 1);
    // Matches found but not yet reported: the longest end per start, and the starts in a heap.
    const ends = new Map<number, number>();
    const heap: number[] = [];
    const push = (s: number) => {
      heap.push(s);
      let k = heap.length - 1;
      while (k > 0) {
        const p = (k - 1) >> 1;
        if ((heap[p] as number) <= s) break;
        heap[k] = heap[p] as number;
        k = p;
      }
      heap[k] = s;
    };
    const pop = () => {
      const top = heap[0] as number;
      const last = heap.pop() as number;
      if (heap.length > 0) {
        let k = 0;
        for (;;) {
          const l = 2 * k + 1;
          if (l >= heap.length) break;
          const r = l + 1;
          const c =
            r < heap.length && (heap[r] as number) < (heap[l] as number)
              ? r
              : l;
          if ((heap[c] as number) >= last) break;
          heap[k] = heap[c] as number;
          k = c;
        }
        heap[k] = last;
      }
      return top;
    };

    let out = false; // ran out of steps
    // Adds the thread at `pc` started at `start` to the list at position `i`, following the
    // instructions that consume nothing; threads at the same state keep the earliest start.
    const add = (
      list: Int32Array,
      starts: Int32Array,
      len: number,
      pc0: number,
      start: number,
      i: number,
    ): number => {
      let top = 0;
      stack[top++] = pc0;
      while (top > 0) {
        const pc = stack[--top] as number;
        if (mark[pc] === i) continue;
        mark[pc] = i;
        if (--budget.steps < 0) {
          out = true;
          return len;
        }
        switch (op[pc]) {
          case CHAR:
            list[len] = pc;
            starts[len] = start;
            len++;
            break;
          case SPLIT:
            stack[top++] = y[pc] as number;
            stack[top++] = x[pc] as number;
            break;
          case JMP:
            stack[top++] = x[pc] as number;
            break;
          case ASSERT:
            if (this.#holds(this.#kinds[pc] as Assertion, t, i)) {
              stack[top++] = pc + 1;
            }
            break;
          case MATCH: {
            const known = ends.get(start);
            if (known === undefined) push(start);
            if (known === undefined || i > known) ends.set(start, i);
            break;
          }
        }
      }
      return len;
    };

    // Where to look again after a report dropped a live thread or a match found: either may have
    // stood in for a later start in the same state (threads at a state keep the earliest start
    // only), so the matches after the report are looked for again from its end, afresh.
    let again = -1;
    for (let i = 0; i <= t.n; i++) {
      if ((i & (POSITION_STEPS - 1)) === 0 && --budget.steps < 0) return false;
      // Threads carried over are in `cur` already, earliest start first; a new one starts here.
      if (i < t.n && this.#canStart(t, i, budget)) {
        curLen = add(cur, curStart, curLen, 0, i, i);
      }
      if (out || budget.steps < 0) return false;
      // At the end no thread grows any more.
      if (i === t.n) curLen = 0;
      // Report what can no longer grow or be overtaken by an earlier start.
      while (heap.length > 0) {
        const s = heap[0] as number;
        if (curLen > 0 && (curStart[0] as number) <= s) break;
        pop();
        const e = ends.get(s) as number;
        ends.delete(s);
        if (found(s, e) === false) return true;
        // What overlaps it is dropped: found matches and live threads alike.
        while (heap.length > 0 && (heap[0] as number) < e) {
          ends.delete(pop());
          again = e;
        }
        let kept = 0;
        for (let k = 0; k < curLen; k++) {
          if ((curStart[k] as number) >= e) {
            cur[kept] = cur[k] as number;
            curStart[kept] = curStart[k] as number;
            kept++;
          }
        }
        if (kept < curLen) again = e;
        curLen = kept;
        // A start a dropped thread stood in for may come before what is pending: report nothing
        // more from here, and look again from `e`.
        if (again >= 0) break;
      }
      if (again >= 0) {
        // Paid for as the first pass was; each report moves `again` on, so this ends.
        heap.length = 0;
        ends.clear();
        curLen = 0;
        mark.fill(-1);
        budget.steps -= size;
        if (budget.steps < 0) return false;
        i = again - 1;
        again = -1;
        continue;
      }
      if (i === t.n) break;
      nxtLen = 0;
      for (let k = 0; k < curLen; k++) {
        const pc = cur[k] as number;
        if (--budget.steps < 0) return false;
        if (this.#accepts(this.#sets[pc] as CharSet, t, i)) {
          nxtLen = add(
            nxt,
            nxtStart,
            nxtLen,
            pc + 1,
            curStart[k] as number,
            i + 1,
          );
          if (out) return false;
        }
      }
      [cur, nxt] = [nxt, cur];
      [curStart, nxtStart] = [nxtStart, curStart];
      curLen = nxtLen;
    }
    return true;
  }
}

/** How many positions of a text one step pays for when no thread runs there (a power of 2). */
const POSITION_STEPS = 8;

/** Why `source` is no pattern of the subset, or `undefined` when it is one. */
export function stylePatternProblem(source: string): string | undefined {
  try {
    new StylePattern(source);
    return undefined;
  } catch (error) {
    if (error instanceof StylePatternError) return error.message;
    throw error;
  }
}
