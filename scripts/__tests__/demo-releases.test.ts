import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CAPTION_LANGS, checkCaptions } from '@/scripts/demo/captions.mjs';
import { LOOP } from '@/scripts/demo/look.mjs';
import { narrationPlan, readNarration } from '@/scripts/demo/narration.mjs';
import {
  LEAST_MS,
  NOTES,
  PARTS,
  RELEASE,
  SHOTS,
  newStep,
  pageDown,
  shotLengths,
} from '@/scripts/demo/scenes/releases.mjs';
import { outputsLayer, phraseBox } from '@/scripts/demo/scenes/hero.mjs';

/** The Releases tab video (#446): its captions, its voice-over, its parts and its opened PDF. */
describe('the Releases video', () => {
  const captions = JSON.parse(
    readFileSync(
      new URL('../demo/captions/releases.json', import.meta.url),
      'utf8',
    ),
  );
  const roles = /\b(reviewer|author|admin|Prüfer\w*|Autor\w*|he|she|er|sie)\b/i;

  it('has three captions from the first shot on, in both languages, short and neutral', () => {
    checkCaptions(captions, 'releases.json');
    // Each caption holds until the next starts: keyed by its start shot, in the take's order.
    const starts = Object.keys(captions);
    expect(starts).toHaveLength(3);
    expect(starts[0]).toBe(SHOTS[0]);
    expect(starts).toEqual(SHOTS.filter((shot) => starts.includes(shot)));
    for (const lang of CAPTION_LANGS) {
      for (const shot of starts) {
        const text: string = captions[shot][lang];
        expect(text.length).toBeLessThanOrEqual(60);
        expect(text).not.toMatch(roles);
      }
    }
  });

  it('has a spoken line for every shot, in both languages, not the caption', () => {
    for (const lang of CAPTION_LANGS) {
      const lines = readNarration('releases', lang);
      expect(lines.map((line) => line.id)).toEqual(SHOTS);
      for (const line of lines) {
        expect(line.text).not.toBe(captions[line.id]?.[lang]);
        expect(line.text).not.toMatch(roles);
      }
    }
  });

  it('lasts 15 to 25 s in both languages before the voice exists', () => {
    for (const lang of CAPTION_LANGS) {
      const plan = narrationPlan('releases', lang, { dir: '/nonexistent' });
      const lengths = shotLengths(plan);
      // The parts are joined with the look's 0.3 s crossfade; the loop takes its blend.
      const total =
        Object.values(lengths).reduce((sum, ms) => sum + ms, 0) / 1000 -
        LOOP.blend -
        0.3 * (PARTS.length - 1);
      expect(total).toBeGreaterThanOrEqual(15);
      expect(total).toBeLessThanOrEqual(25);
    }
  });

  it('films every shot once, in its order, across the parts', () => {
    expect(PARTS.flat()).toEqual(SHOTS);
    expect(Object.keys(LEAST_MS)).toEqual(SHOTS);
    // The release after the demo's 1.0 and 1.1.
    expect(RELEASE).toBe('1.2');
    for (const lang of CAPTION_LANGS) expect(NOTES[lang]).toBeTruthy();
  });

  it('finds the new step in a page’s words and shows the page down to it', () => {
    expect(newStep('en')).toEqual(
      'After 50 km have the wheel bolts tightened to 120 Nm'.split(' '),
    );
    const words = ['After', '50', 'km,', 'have', 'the', 'wheel', 'bolts']
      .concat(['tightened', 'to', '120', 'Nm.'])
      .map((text, i) => ({
        text,
        x0: 80 + i * 30,
        y0: 480,
        x1: 105 + i * 30,
        y1: 492,
      }));
    const box = phraseBox(words, newStep('en'));
    expect(box).toEqual({ x0: 80, y0: 480, x1: 405, y1: 492 });
    expect(pageDown(box!)).toEqual({ x: 0, y: 0, width: 595.276, height: 538 });
    // One PDF on its own: one column, the tile's width.
    const layer = outputsLayer(
      [
        {
          label: 'Owner’s manual · Fenna Estate',
          lang: 'en',
          picture: 'data:image/png;base64,',
          pageWidth: 595.276,
          crop: pageDown(box!),
          box: box!,
        },
      ],
      { tileWidth: 860, columns: 1 },
    );
    expect(layer).toContain('grid-template-columns:repeat(1,860px)');
  });
});
