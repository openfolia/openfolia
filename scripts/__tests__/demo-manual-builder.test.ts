import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CAPTION_LANGS, checkCaptions } from '@/scripts/demo/captions.mjs';
import { LOOP } from '@/scripts/demo/look.mjs';
import {
  loopedSeconds,
  narrationPlan,
  readNarration,
} from '@/scripts/demo/narration.mjs';
import {
  BUILDER_TEXTS,
  LAYER_HOLD_MS,
  LEAST_MS,
  SHOTS,
  pdfLayer,
  pdfPages,
  shotLengths,
  splitPages,
} from '@/scripts/demo/scenes/manual-builder.mjs';

/** The Manual builder tab video (#444): its captions, its voice-over, its timing and its PDF. */
describe('the Manual builder video', () => {
  const captions = JSON.parse(
    readFileSync(
      new URL('../demo/captions/manual-builder.json', import.meta.url),
      'utf8',
    ),
  );
  const roles = /\b(reviewer|author|admin|Prüfer\w*|Autor\w*|he|she|er|sie)\b/i;

  it('has three captions from the first shot on, in both languages, short and neutral', () => {
    checkCaptions(captions, 'manual-builder.json');
    const starts = Object.keys(captions);
    expect(starts).toEqual(['01a', '01c', '03a']);
    for (const lang of CAPTION_LANGS) {
      for (const shot of starts) {
        const text: string = captions[shot][lang];
        expect(text.length).toBeLessThanOrEqual(60);
        expect(text).not.toMatch(roles);
        expect(text).not.toMatch(/\.$/);
      }
    }
  });

  it('has a spoken line for every shot, in both languages, without role nouns', () => {
    for (const lang of CAPTION_LANGS) {
      const lines = readNarration('manual-builder', lang);
      expect(lines.map((line) => line.id)).toEqual(SHOTS);
      for (const line of lines) {
        expect(line.text).not.toMatch(
          /\b(reviewer|author|Prüfer\w*|Autor\w*)\b/i,
        );
      }
    }
  });

  it('lasts at most 28 s in both languages before the voice exists', () => {
    for (const lang of CAPTION_LANGS) {
      const plan = narrationPlan('manual-builder', lang, {
        dir: '/nonexistent',
      });
      const lengths = shotLengths(plan);
      expect(Object.keys(lengths)).toEqual(SHOTS);
      // The ends carry the loop's blend, so no line is under it.
      expect(lengths['03a']).toBeGreaterThanOrEqual(
        LEAST_MS['03a'] + LOOP.blend * 1000,
      );
      const total = loopedSeconds(lengths);
      expect(total).toBeGreaterThanOrEqual(15);
      expect(total).toBeLessThanOrEqual(28);
    }
  });

  it('holds the PDF long enough to read before the loop', () => {
    // The last shot's least: the build, the pages drawn, then the hold and the blend.
    expect(LEAST_MS['03a']).toBeGreaterThan(LAYER_HOLD_MS + LOOP.blend * 1000);
    expect(LAYER_HOLD_MS).toBeGreaterThanOrEqual(2_000);
  });

  it('finds the contents line and the heading in the PDF’s words', () => {
    const word = (text: string, x0: number, y0: number, size: number) => ({
      text,
      x0,
      y0,
      x1: x0 + 40,
      y1: y0 + size,
    });
    const { title } = BUILDER_TEXTS.en;
    const pages = [
      [word('Quick', 50, 50, 20)],
      // The contents: the title in body size.
      [
        word('3', 50, 120, 10),
        word(title[0], 60, 120, 10),
        word(title[1], 110, 120, 10),
      ],
      // Body text that names it in lower case is no heading.
      [
        word('the', 50, 60, 10),
        word('high-voltage', 70, 60, 10),
        word('system', 120, 60, 10),
      ],
      // The module's page: the title set large.
      [
        word('3', 50, 80, 22),
        word(title[0], 70, 80, 22),
        word(title[1], 160, 80, 22),
      ],
    ];
    const [contents, heading] = pdfPages(pages, title);
    expect(contents.page).toBe(2);
    expect(heading.page).toBe(4);
    expect(heading.box.y1 - heading.box.y0).toBe(22);
    expect(() => pdfPages([pages[0]], title)).toThrow(/no contents line/);
  });

  it('reads the pages of one pdftotext run', () => {
    const xhtml =
      '<doc><page width="595" height="842"><word xMin="1" yMin="2" xMax="3" yMax="4">A</word></page>' +
      '<page width="595" height="842"><word xMin="5" yMin="6" xMax="7" yMax="8">B</word></page></doc>';
    const pages = splitPages(xhtml);
    expect(pages).toHaveLength(2);
    expect(pages[1]).toContain('>B<');
  });

  it('lays the pages side by side, each title marked', () => {
    const page = {
      picture: 'data:image/png;base64,AA==',
      width: 595,
      height: 842,
      box: { x0: 50, y0: 80, x1: 250, y1: 102 },
    };
    const html = pdfLayer([page, page], { height: 842 });
    expect(html.match(/<img /g)).toHaveLength(2);
    expect(html.match(/<i style/g)).toHaveLength(2);
    // At scale 1 the mark sits on the box, padded.
    expect(html).toContain(
      'left:45.0px;top:77.0px;width:210.0px;height:28.0px',
    );
  });

  it('writes the take’s texts in both languages', () => {
    for (const lang of CAPTION_LANGS) {
      const texts = BUILDER_TEXTS[lang as 'en' | 'de'];
      expect(texts.changeSet).toBeTruthy();
      expect(texts.title.length).toBeGreaterThan(0);
    }
  });
});
