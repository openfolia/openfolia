import {
  checkWriting,
  compileWritingRules,
  MAX_STYLE_RULES,
  MAX_WRITING_CHARS,
  type Block,
  type Module,
  type StyleRule,
  type Term,
} from '@openfolia/content-model';
import { expectWithin } from './budget.js';

/**
 * The writing checks' bound (#55): a module of the largest text they read
 * (`MAX_WRITING_CHARS`) against many terms and the most style rules a language may have
 * (`MAX_STYLE_RULES`), ordinary rules and hostile ones. The work is bounded by the engine's own
 * limits (characters, findings, steps), never by a timeout; this measures what those limits
 * cost.
 */

const TERMS = 10_000;
const FORBIDDEN_PER_TERM = 5;

const words = [
  'the',
  'battery',
  'charges',
  'when',
  'vehicle',
  'stands',
  'still',
  'press',
  'button',
  'and',
  'wait',
  'until',
  'light',
  'turns',
  'green',
  'was',
  'opened',
  'in',
  'order',
  'to',
];

/** About `MAX_WRITING_CHARS` characters of sentences, in paragraphs of about 600. */
function largestModule(): Module {
  const blocks: Block[] = [];
  let chars = 0;
  let seed = 11;
  const next = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    // The high bits: the low ones of this generator repeat in short cycles.
    return seed >> 16;
  };
  while (chars < MAX_WRITING_CHARS - 1_000) {
    let text = '';
    while (text.length < 600) {
      const length = 8 + (next() % 30);
      const sentence = Array.from(
        { length },
        () => words[next() % words.length],
      ).join(' ');
      text += `${sentence[0]?.toUpperCase()}${sentence.slice(1)}. `;
    }
    text = text.trimEnd();
    blocks.push({
      type: 'paragraph',
      id: `p${blocks.length}`,
      content: [{ type: 'text', text }],
    });
    chars += text.length;
  }
  return {
    schemaVersion: 1,
    id: 'largest',
    meta: {
      title: 'Largest',
      type: 'concept',
      lang: 'en',
      audience: 'public',
      facets: {},
    },
    blocks,
  };
}

function manyTerms(): Term[] {
  return Array.from({ length: TERMS }, (_, i) => ({
    schemaVersion: 1,
    id: `term-${i}`,
    status: 'approved' as const,
    languages: {
      en: {
        preferred: `preferred${i}`,
        allowed: [],
        forbidden: Array.from({ length: FORBIDDEN_PER_TERM }, (_, k) => ({
          term: `banned${i} word${k}`,
        })),
      },
    },
  }));
}

/** Half phrases, half patterns of the kind a house style holds. */
function ordinaryRules(): StyleRule[] {
  return Array.from({ length: MAX_STYLE_RULES }, (_, i) =>
    i % 2 === 0
      ? {
          id: `words-${i}`,
          words: i === 0 ? 'in order to' : `phrase${i} here`,
          message: 'Shorter.',
        }
      : {
          id: `pattern-${i}`,
          pattern:
            i === 1 ? '\\b(?:was|were) \\w+ed\\b' : `\\bword${i}(?:ly|ing)?\\b`,
          message: 'Plainer.',
        },
  );
}

describe('the writing checks of the largest module (#55)', () => {
  const module = largestModule();
  const terms = manyTerms();

  it('compiles many terms and the most rules, then checks the largest module, completely', () => {
    const compileStart = performance.now();
    const rules = compileWritingRules({
      terms,
      lang: 'en',
      styleRules: { en: { maxSentenceWords: 40, rules: ordinaryRules() } },
    });
    const compiled = performance.now() - compileStart;
    expectWithin(
      `compile ${TERMS} terms × ${FORBIDDEN_PER_TERM} forbidden variants and ${MAX_STYLE_RULES} rules`,
      compiled,
      2_000,
    );
    const start = performance.now();
    const result = checkWriting(module, rules);
    const took = performance.now() - start;
    expect(result).toMatchObject({ complete: true });
    expectWithin(
      `check ${MAX_WRITING_CHARS.toLocaleString('en')} characters against them (${result.findings.length} findings)`,
      took,
      3_000,
    );
  });

  it('stops hostile patterns at the step budget, within the same bound', () => {
    const hostile: StyleRule[] = Array.from(
      { length: MAX_STYLE_RULES },
      (_, i) => ({
        id: `hostile-${i}`,
        pattern: '(?:\\w{0,10}){0,10}z',
        message: 'Never.',
      }),
    );
    const rules = compileWritingRules({
      terms: [],
      lang: 'en',
      styleRules: { en: { rules: hostile } },
    });
    const start = performance.now();
    const result = checkWriting(module, rules);
    const took = performance.now() - start;
    expect(result).toMatchObject({ complete: false, stopped: 'steps' });
    expectWithin(
      `${MAX_STYLE_RULES} hostile patterns on ${MAX_WRITING_CHARS.toLocaleString('en')} characters, stopped at the step budget`,
      took,
      3_000,
    );
  });
});
