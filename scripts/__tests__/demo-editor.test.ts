import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sceneLength } from '@/scripts/demo/assemble.mjs';
import { CAPTION_LANGS, checkCaptions } from '@/scripts/demo/captions.mjs';
import { CAPTION, LOOP } from '@/scripts/demo/look.mjs';
import { narrationPlan, readNarration } from '@/scripts/demo/narration.mjs';
import {
  EDITOR_TEXTS,
  LEAST_MS,
  SHOTS,
  shotLengths,
} from '@/scripts/demo/scenes/editor.mjs';

/** The Editor tab video (#443): its captions, its voice-over and its length. */
describe('the Editor video’s words', () => {
  const captions = JSON.parse(
    readFileSync(
      new URL('../demo/captions/editor.json', import.meta.url),
      'utf8',
    ),
  );
  const CAPTION_SHOTS = ['01a', '02a', '03a'];
  const roles =
    /\b(reviewer|author|writer|Prüfer\w*|Autor\w*|he|she|er|sie)\b/i;

  it('has a caption for every shot, in both languages, short and neutral', () => {
    checkCaptions(captions, 'editor.json');
    // Three captions, each held from its shot until the next one starts.
    expect(Object.keys(captions)).toEqual(CAPTION_SHOTS);
    for (const lang of CAPTION_LANGS) {
      for (const shot of CAPTION_SHOTS) {
        const text: string = captions[shot][lang];
        expect(text.length).toBeLessThanOrEqual(CAPTION.maxLength);
        expect(text).not.toMatch(roles);
        // Quiet signposts: no full stop at the end.
        expect(text).not.toMatch(/\.$/);
      }
    }
  });

  it('has a spoken line for every shot, in both languages, not the caption', () => {
    for (const lang of CAPTION_LANGS) {
      const lines = readNarration('editor', lang);
      expect(lines.map((line) => line.id)).toEqual(SHOTS);
      for (const line of lines) {
        expect(line.text).not.toBe(captions[line.id]?.[lang]);
        expect(line.text).not.toMatch(
          /\b(reviewer|author|writer|Prüfer\w*|Autor\w*)\b/i,
        );
      }
    }
  });

  it('writes the same things in both languages, short enough to type', () => {
    expect(Object.keys(EDITOR_TEXTS.de)).toEqual(Object.keys(EDITOR_TEXTS.en));
    for (const lang of CAPTION_LANGS) {
      const texts: Record<string, string> = EDITOR_TEXTS[lang];
      for (const [key, text] of Object.entries(texts)) {
        if (key === 'changeSet') continue;
        // Typed at about 40 ms a character: no line takes the viewer more than 2 s.
        expect(text.length, `${lang} ${key}`).toBeLessThanOrEqual(50);
      }
    }
  });

  it('lasts 15 to 28 s in both languages before the voice exists (the owner’s limit)', () => {
    for (const lang of CAPTION_LANGS) {
      const plan = narrationPlan('editor', lang, { dir: '/nonexistent' });
      const lengths = shotLengths(plan);
      const total =
        Object.values(lengths).reduce((sum, ms) => sum + ms, 0) / 1000 -
        LOOP.blend;
      expect(total).toBeGreaterThanOrEqual(15);
      expect(total).toBeLessThanOrEqual(28);
    }
  });

  it('gives each shot at least its action, the ends the loop’s blend on top', () => {
    const plan = {
      shots: SHOTS.map((id) => ({ id, ms: 1000 })),
      voiced: false,
    };
    const lengths = shotLengths(plan as never);
    expect(lengths['02a']).toBe(LEAST_MS['02a']);
    expect(lengths['01a']).toBe(LEAST_MS['01a'] + LOOP.blend * 1000);
    expect(lengths['05a']).toBe(LEAST_MS['05a'] + LOOP.blend * 1000);
  });
});

describe('the scene’s length', () => {
  const meta = {
    trim: 2000,
    shots: [
      { id: '01a', start: 2000, end: 6000 },
      { id: '02a', start: 6000, end: 20000 },
    ],
  };

  it('ends a tab video where its last shot ends, not where the recording stopped', () => {
    expect(sceneLength(21.3, meta, { loops: true })).toBe(18);
    // A recording that stopped first (never in practice) keeps what there is.
    expect(sceneLength(15, meta, { loops: true })).toBe(13);
  });

  it('keeps the whole take for the hero and for a take without shots', () => {
    expect(sceneLength(19.4, meta, { loops: false })).toBeCloseTo(17.4);
    expect(sceneLength(10, { trim: 0, shots: [] }, { loops: true })).toBe(10);
  });
});
