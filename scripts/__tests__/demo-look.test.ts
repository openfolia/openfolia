import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  captionCues,
  captionFilter,
  captionInputs,
  checkCaptions,
} from '@/scripts/demo/captions.mjs';
import {
  frameFilter,
  hasCards,
  joinFilter,
  parseAssemble,
} from '@/scripts/demo/assemble.mjs';
import {
  animatedLogo,
  CARD_TEXTS,
  CARDS,
  cardPage,
  STILL_TIMES,
} from '@/scripts/demo/cards/cards.mjs';
import {
  CAPTION,
  captionPage,
  LOCKUP_FILE,
  LOOK,
} from '@/scripts/demo/look.mjs';

/** The films' shared look (#441): the frame, the captions under it, the hero's cards. */
describe('the frame', () => {
  it('keeps the window inside the frame, with the caption band below it', () => {
    const { frame, window: w } = LOOK;
    expect(w.x * 2 + w.width).toBe(frame.width);
    const below = frame.height - w.y - w.height;
    expect(below).toBeGreaterThan(w.y);
    expect(CAPTION.centerY - CAPTION.lineHeight / 2).toBeGreaterThan(
      w.y + w.height,
    );
    expect(CAPTION.centerY + CAPTION.lineHeight / 2).toBeLessThan(frame.height);
  });
});

describe('the captions', () => {
  const captions = {
    '01a': { en: 'Open the module', de: 'Das Modul öffnen' },
    '01c': { en: 'Change a step', de: 'Einen Schritt ändern' },
  };
  const shots = [
    { id: '01a', start: 500, end: 3500 },
    { id: '01b', start: 3500, end: 5000 },
    { id: '01c', start: 5000, end: 9000 },
  ];

  it('are one line of plain text, in English and German, with no full stop', () => {
    expect(checkCaptions(captions)).toBe(captions);
    expect(() => checkCaptions({ '01a': { en: 'Only English' } })).toThrow(
      /no de caption/,
    );
    expect(() =>
      checkCaptions({ '01a': { en: 'Two\nlines.', de: 'Zwei.' } }),
    ).toThrow(/one line/);
    expect(() =>
      checkCaptions({ '01a': { en: '<b>Bold</b>', de: 'Fett.' } }),
    ).toThrow(/plain text/);
    expect(() =>
      checkCaptions({ '01a': { en: 'x'.repeat(71), de: 'Kurz.' } }),
    ).toThrow(/at most 70/);
    expect(() =>
      checkCaptions({ '01a': { en: 'A.', de: 'B.', fr: 'C.' } }),
    ).toThrow(/unknown fr/);
    expect(() => checkCaptions(['01a'])).toThrow(/shot IDs/);
    expect(() =>
      checkCaptions({ '01a': { en: 'Ends in a stop.', de: 'Ohne Punkt' } }),
    ).toThrow(/01a en: no full stop/);
    expect(
      checkCaptions({ '01a': { en: 'Version 1.2 is out', de: 'Und dann…' } }),
    ).toBeTruthy();
  });

  it("hold from their shot until the next caption starts, less the take's trim", () => {
    expect(
      captionCues(shots, captions, 'de', { trim: 500, length: 8 }),
    ).toEqual([
      { shot: '01a', text: 'Das Modul öffnen', start: 0, end: 4.5 },
      { shot: '01c', text: 'Einen Schritt ändern', start: 4.5, end: 8 },
    ]);
  });

  it('refuse a caption for a shot the take does not have, or a shot too short to read', () => {
    expect(() =>
      captionCues(shots, { ...captions, '02a': { en: 'A.', de: 'B.' } }, 'en'),
    ).toThrow(/02a/);
    expect(() =>
      captionCues(
        [{ id: '01a', start: 0, end: 1000 }],
        { '01a': captions['01a'] },
        'en',
      ),
    ).toThrow(/needs 1.5 s/);
  });

  it('are laid over the framed take, faded only where one caption gives way to the next', () => {
    const cues = captionCues(shots, captions, 'en', { trim: 500 });
    const filter = captionFilter(cues, {
      input: '[framed]',
      output: '[out]',
      first: 3,
    });
    expect(filter).toContain(
      '[3:v]format=rgba,fade=t=in:st=0:d=0.25:alpha=1,fade=t=out:st=4.250:d=0.25:alpha=1,setpts=PTS-STARTPTS+0.000/TB[c0]',
    );
    expect(filter).toContain(
      "[framed][c0]overlay=0:0:eof_action=pass:enable='between(t,0.000,4.500)'[o0]",
    );
    expect(filter).toContain(
      "[o0][c1]overlay=0:0:eof_action=pass:enable='between(t,4.500,8.500)'[out]",
    );
    expect(captionInputs(cues, ['a.png', 'b.png'])).toEqual([
      ...['-loop', '1', '-framerate', '30', '-t', '4.500', '-i', 'a.png'],
      ...['-loop', '1', '-framerate', '30', '-t', '4.000', '-i', 'b.png'],
    ]);
    expect(captionFilter([], { input: '[a]', output: '[b]', first: 3 })).toBe(
      '[a]null[b]',
    );
  });

  it('are set in the theme’s type, centred under the window, the text escaped', () => {
    const page = captionPage('Steps & <notes>');
    expect(page).toContain('Steps &amp; &lt;notes&gt;');
    expect(page).toContain(`font-size:${CAPTION.size}px`);
    expect(page).toContain(`top:${CAPTION.centerY - CAPTION.lineHeight / 2}px`);
    expect(page).toContain("font-family:'Geist'");
    expect(page).toContain('data:font/woff2;base64,');
  });
});

describe('the assembly', () => {
  it('puts cards only around the hero, captions only under the tab videos', () => {
    expect(hasCards('hero')).toBe(true);
    expect(hasCards('hero-dark')).toBe(true);
    expect(hasCards('review')).toBe(false);
    expect(parseAssemble(['review', '--lang', 'de'])).toMatchObject({
      video: 'review',
      lang: 'de',
    });
    expect(parseAssemble(['review', '--lang', 'de']).out).toMatch(
      /\.demo\/films\/review-de\.mp4$/,
    );
    expect(() => parseAssemble(['promo', '--lang', 'en'])).toThrow(/Usage/);
    expect(() => parseAssemble(['review', '--lang', 'fr'])).toThrow(/--lang/);
  });

  it('frames the take in the window and joins clips with 0.3 s crossfades', () => {
    const { window: w } = LOOK;
    expect(frameFilter('[f]')).toContain(`scale=${w.width}:${w.height}`);
    expect(frameFilter('[f]')).toContain(`overlay=${w.x}:${w.y}`);
    expect(joinFilter([7.4, 20, 6.6])).toContain(
      'xfade=transition=fade:duration=0.3:offset=7.100[x1]',
    );
    expect(joinFilter([7.4, 20, 6.6])).toContain('offset=26.800[out]');
  });
});

describe('the cards', () => {
  it('use the theme’s lockup, its green leaf the only colour', () => {
    const logo = animatedLogo();
    expect(logo).toContain('class="spine"');
    expect(logo).toContain('class="leaf back"');
    expect(logo).toContain('class="leaf signal" fill="#69995D"');
    expect(logo).toContain('class="word"');
    const lockup = readFileSync(LOCKUP_FILE, 'utf8');
    for (const [, d] of lockup.matchAll(/ d="([^"]+)"/g)) {
      expect(logo).toContain(d);
    }
    expect(() => animatedLogo('<svg></svg>')).toThrow(/not the lockup/);
  });

  it.each(['en', 'de'])(
    'fill every slot in %s, on the frame’s background',
    (lang) => {
      for (const card of Object.keys(CARDS)) {
        const page = cardPage(card, lang);
        expect(page).not.toMatch(/\{\{\w+\}\}/);
        expect(page).toContain(LOOK.background);
        expect(page).toContain(CARD_TEXTS[lang].first);
        expect(page).toContain(CARD_TEXTS[lang].second);
        expect(page).toContain(`lang="${lang}"`);
      }
      const intro = cardPage('intro', lang);
      expect(intro).toContain(CARD_TEXTS[lang].module);
      for (const manual of CARD_TEXTS[lang].manuals) {
        expect(intro).toContain(manual.replace("'", '&#39;'));
      }
    },
  );

  it('say the approved line, second beat brighter', () => {
    expect(CARD_TEXTS.en).toMatchObject({
      first: 'Write it once.',
      second: 'Publish every manual.',
    });
    expect(CARD_TEXTS.de).toMatchObject({
      first: 'Ein Modul.',
      second: 'Jede Anleitung.',
    });
  });

  it('take their stills inside the card', () => {
    for (const [card, times] of Object.entries(STILL_TIMES)) {
      for (const seconds of Object.values(times)) {
        expect(seconds).toBeGreaterThan(0);
        expect(seconds).toBeLessThan(CARDS[card as keyof typeof CARDS].seconds);
      }
    }
  });
});
