// Deterministic randomness and invented, neutral text for the scale generator (`seed.mjs`).
// Nothing here names an organisation, a product or a person: the words are generic technical
// English, the "translations" are pseudo-text made from them.

/**
 * A seeded generator (sfc32 over a string seed hashed with cyrb128): the same seed gives the
 * same sequence on every machine and Node version.
 */
export class Random {
  /** @param {string} seed */
  constructor(seed) {
    let h1 = 1779033703,
      h2 = 3144134277,
      h3 = 1013904242,
      h4 = 2773480762;
    for (let i = 0; i < seed.length; i++) {
      const k = seed.charCodeAt(i);
      h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
      h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
      h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
      h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
    }
    h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
    h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
    h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
    h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
    this.a = (h1 ^ h2 ^ h3 ^ h4) >>> 0;
    this.b = (h2 ^ h1) >>> 0;
    this.c = (h3 ^ h1) >>> 0;
    this.d = (h4 ^ h1) >>> 0;
  }

  /** A float in [0, 1). */
  next() {
    this.a >>>= 0;
    this.b >>>= 0;
    this.c >>>= 0;
    this.d >>>= 0;
    let t = (this.a + this.b) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.d = (this.d + 1) | 0;
    t = (t + this.d) | 0;
    this.c = (this.c + t) | 0;
    return (t >>> 0) / 4294967296;
  }

  /** A whole number in [min, max]. */
  int(min, max) {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** True with probability `p`. */
  chance(p) {
    return this.next() < p;
  }

  /** @template T @param {readonly T[]} items @returns {T} */
  pick(items) {
    return items[Math.floor(this.next() * items.length)];
  }

  /** `count` distinct items (fewer when there are fewer), in a random order. @template T @param {readonly T[]} items */
  sample(items, count) {
    const copy = [...items];
    const n = Math.min(count, copy.length);
    for (let i = 0; i < n; i++) {
      const j = i + Math.floor(this.next() * (copy.length - i));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.slice(0, n);
  }

  /** An item by weight: `[[value, weight], …]`. @template T @param {readonly [T, number][]} weighted @returns {T} */
  weighted(weighted) {
    const total = weighted.reduce((sum, [, w]) => sum + w, 0);
    let r = this.next() * total;
    for (const [value, w] of weighted) {
      r -= w;
      if (r < 0) return value;
    }
    return weighted[weighted.length - 1][0];
  }

  /** A child generator for one part of the output, so adding a part never shifts another. */
  fork(label) {
    return new Random(`${this.a}.${this.b}.${this.c}.${this.d}/${label}`);
  }
}

/** Nouns of a generic machine: parts, places and materials. */
export const NOUNS = [
  'panel',
  'lever',
  'valve',
  'filter',
  'housing',
  'cover',
  'sensor',
  'switch',
  'cable',
  'connector',
  'bracket',
  'hinge',
  'belt',
  'roller',
  'pump',
  'tank',
  'nozzle',
  'gasket',
  'screen',
  'display',
  'battery',
  'charger',
  'motor',
  'gear',
  'shaft',
  'bearing',
  'frame',
  'wheel',
  'brake',
  'clamp',
  'fan',
  'heater',
  'drain',
  'hose',
  'fuse',
  'relay',
  'terminal',
  'module',
  'tray',
  'drawer',
  'door',
  'latch',
  'handle',
  'knob',
  'indicator',
  'lamp',
  'socket',
  'plug',
  'spring',
  'seal',
];

/** Verbs of maintenance and operation. */
export const VERBS = [
  'check',
  'clean',
  'replace',
  'adjust',
  'install',
  'remove',
  'inspect',
  'tighten',
  'loosen',
  'calibrate',
  'lubricate',
  'connect',
  'disconnect',
  'open',
  'close',
  'reset',
  'start',
  'stop',
  'store',
  'mount',
];

export const ADJECTIVES = [
  'upper',
  'lower',
  'left',
  'right',
  'front',
  'rear',
  'main',
  'auxiliary',
  'inner',
  'outer',
  'primary',
  'secondary',
  'small',
  'large',
  'standard',
  'optional',
];

const ADVERBS = [
  'carefully',
  'slowly',
  'firmly',
  'gently',
  'regularly',
  'completely',
  'evenly',
  'briefly',
];

const OBJECT_PHRASES = [
  'until it clicks into place',
  'before you continue',
  'with the supplied tool',
  'at least once a month',
  'after every shift',
  'as shown in the figure',
  'without force',
  'in a clockwise direction',
  'until the indicator turns green',
  'while the unit is switched off',
];

/** A sentence of 8 to 20 words, ending in a full stop. */
export function sentence(random) {
  const parts = [
    capitalise(random.pick(VERBS)),
    'the',
    random.pick(ADJECTIVES),
    random.pick(NOUNS),
  ];
  if (random.chance(0.5)) parts.push(random.pick(ADVERBS));
  if (random.chance(0.7)) parts.push(random.pick(OBJECT_PHRASES));
  if (random.chance(0.4)) {
    parts.push(
      'and',
      random.pick(VERBS),
      'the',
      random.pick(NOUNS),
      random.pick(OBJECT_PHRASES),
    );
  }
  return `${parts.join(' ')}.`;
}

/** A paragraph's text: 1 to `max` sentences. */
export function paragraphText(random, max = 4) {
  return Array.from({ length: random.int(1, max) }, () =>
    sentence(random),
  ).join(' ');
}

/** A title of two to four words, e.g. "Replace the rear filter". */
export function title(random) {
  const verb = capitalise(random.pick(VERBS));
  return random.chance(0.5)
    ? `${verb} the ${random.pick(ADJECTIVES)} ${random.pick(NOUNS)}`
    : `${verb} the ${random.pick(NOUNS)}`;
}

export function capitalise(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Pseudo-translation into `lang`: every word replaced by an invented word made from the
 * language tag and the word, deterministic, so a translated module reads differently in each
 * language and keeps its punctuation and length. Not a real language, and not meant to be one.
 */
export function pseudoTranslate(text, lang) {
  return text.replace(/[A-Za-z]+/g, (word) => {
    let h = 0;
    for (const ch of `${lang}:${word.toLowerCase()}`) {
      h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0;
    }
    const syllables = [
      'ka',
      'lo',
      'mi',
      'ne',
      'ru',
      'ta',
      'vo',
      'se',
      'di',
      'pa',
    ];
    let out = '';
    const n = Math.max(1, Math.round(word.length / 2.5));
    for (let i = 0; i < n; i++) {
      out += syllables[(h >>> (i * 3)) % syllables.length];
    }
    return word[0] === word[0].toUpperCase() ? capitalise(out) : out;
  });
}
