import { describe, expect, it } from 'vitest';
import {
  END_CARD_HIT,
  musicFromEnv,
  SOUND_TAG,
  soundPlan,
} from '@/scripts/demo/assemble.mjs';
import {
  CARD_COLORS,
  CARD_SURFACES,
  cardPage,
  contrastRatio,
} from '@/scripts/demo/cards/cards.mjs';
import { LEAD_MS, readNarration, TAIL_MS } from '@/scripts/demo/narration.mjs';
import {
  PART_LEAD_MS,
  PART_TAIL_MS,
  partShots,
  partsFilter,
} from '@/scripts/demo/record.mjs';
import {
  cropAround,
  editedStep,
  HERO_EDIT,
  heroPlan,
  HERO_SHOTS,
  HERO_TEXTS,
  outputsLayer,
  pageWords,
  parseHero,
  phraseBox,
} from '@/scripts/demo/scenes/hero.mjs';
import { voiceRequests } from '@/scripts/demo/voice.mjs';
import { cutKind, HERO_POSTER_AT } from '@/scripts/demo/web.mjs';

/** The hero (#442): its take, its voice-over and its sound, and the cards' contrast. */
describe('a take in parts', () => {
  // What `Take.finish` returns: each part's shots in its own recording's time.
  const parts = [
    {
      file: 'a.webm',
      trim: 1350,
      shots: [
        { id: '01a', start: 1350, end: 4000 },
        { id: '01b', start: 4000, end: 8650 },
      ],
    },
    {
      file: 'b.webm',
      trim: 2350,
      shots: [{ id: '03a', start: 2350, end: 6650 }],
    },
  ];

  it('cuts each part around its shots and joins them with the 0.3 s crossfade', () => {
    expect(PART_LEAD_MS).toBeGreaterThan(300);
    expect(PART_TAIL_MS).toBeGreaterThan(300);
    expect(partShots(parts)).toEqual([
      { id: '01a', start: 350, end: 3000 },
      { id: '01b', start: 3000, end: 7650 },
      // The first part runs 1.000 to 9.000 s: 8 s, less the fade.
      { id: '03a', start: 8050, end: 12350 },
    ]);
    const filter = partsFilter(parts);
    expect(filter).toContain('[0:v]trim=start=1.000:end=9.000');
    expect(filter).toContain('[1:v]trim=start=2.000:end=7.000');
    expect(filter).toContain(
      '[p0][p1]xfade=transition=fade:duration=0.3:offset=7.700[out]',
    );
  });

  it('refuses a shot that is in the take twice, or a part without shots', () => {
    expect(() => partShots([parts[0], parts[0]])).toThrow(/01a/);
    expect(() => partShots([{ file: 'c.webm', trim: 0, shots: [] }])).toThrow(
      /no shots/,
    );
  });
});

describe('the hero take', () => {
  it.each(['en', 'de'] as const)(
    'types the words where they go in %s',
    (lang) => {
      expect(editedStep(HERO_EDIT[lang])).toBe(HERO_EDIT[lang].after);
      expect(HERO_EDIT[lang].after).toContain('120 Nm');
    },
  );

  it('writes its texts in both languages', () => {
    for (const texts of Object.values(HERO_TEXTS)) {
      expect(texts.changeSet).toBeTruthy();
      expect(texts.notes).toBeTruthy();
    }
  });

  it('finds the new words on a PDF page and shows the lines around them', () => {
    const xhtml = `<word xMin="84.2" yMin="463.4" xMax="112.3" yMax="476.4">Lower</word>
      <word xMin="294.5" yMin="463.4" xMax="342.0" yMax="476.4">crosswise</word>
      <word xMin="345.0" yMin="463.4" xMax="356.0" yMax="476.4">to</word>
      <word xMin="359.0" yMin="463.4" xMax="377.0" yMax="476.4">120</word>
      <word xMin="380.0" yMin="463.4" xMax="398.5" yMax="476.4">Nm.</word>
      <word xMin="84.0" yMin="500.0" xMax="110.0" yMax="512.0">120</word>`;
    const words = pageWords(xhtml);
    expect(words).toHaveLength(6);
    const box = phraseBox(words);
    expect(box).toEqual({ x0: 359, y0: 463.4, x1: 398.5, y1: 476.4 });
    expect(phraseBox(words, ['Nm', '120'])).toBeNull();
    if (!box) throw new Error('no box');
    const crop = cropAround(box);
    expect(crop.y).toBeLessThan(box.y0);
    expect(crop.y + crop.height).toBeGreaterThan(box.y1);
  });

  it('labels the files as plain text', () => {
    const layer = outputsLayer([
      {
        label: 'Owner’s <manual>',
        lang: 'en',
        picture: 'data:image/png;base64,AA==',
        pageWidth: 595,
        crop: { x: 72, y: 400, width: 451, height: 96 },
        box: { x0: 359, y0: 463, x1: 398, y1: 476 },
      },
    ]);
    expect(layer).toContain('Owner’s &lt;manual&gt;');
    expect(layer).not.toContain('<manual>');
  });

  it('reads its options', () => {
    expect(parseHero(['--lang', 'de'])).toMatchObject({
      lang: 'de',
      theme: 'light',
      reset: true,
      name: 'hero-de',
    });
    expect(parseHero(['--lang', 'en', '--theme', 'dark']).name).toBe(
      'hero-dark-en',
    );
    expect(() => parseHero(['--lang', 'fr'])).toThrow(/--lang/);
    expect(() => parseHero(['--lang', 'en', '--theme', 'sepia'])).toThrow(
      /--theme/,
    );
  });
});

describe('the voice-over', () => {
  it.each(['en', 'de'] as const)(
    'has a line for every shot of the hero in %s',
    (lang) => {
      const ids = readNarration('hero', lang).map((shot) => shot.id);
      expect(ids).toEqual(Object.keys(HERO_SHOTS));
    },
  );

  it('makes a shot as long as its actions, or its line with room around it', () => {
    const line = (id: string, spokenMs: number, voice?: string) => ({
      id,
      spokenMs,
      voice,
      ms: LEAD_MS + spokenMs + TAIL_MS,
    });
    const holds = { '01a': 2000, '01b': 3000 };
    const plan = heroPlan(
      { shots: [line('01a', 5000), line('01b', 1000, 'b.mp3')] },
      holds,
    );
    expect(plan[0]).toMatchObject({ id: '01a', voiced: false, spokenMs: 5000 });
    expect(plan[0].ms).toBe(5000 + LEAD_MS + TAIL_MS);
    expect(plan[1]).toMatchObject({ id: '01b', voiced: true, ms: 3000 });
  });

  it('refuses a narration whose shots are not the take’s', () => {
    expect(() => heroPlan({ shots: [] }, { '01a': 2000 })).toThrow(/01a/);
  });

  it('asks for each of the hero’s lines with its neighbours', () => {
    const requests = voiceRequests(readNarration('hero', 'de'));
    expect(requests).toHaveLength(Object.keys(HERO_SHOTS).length);
    expect(requests[0].previous).toBeUndefined();
    expect(requests[1].previous).toBe(requests[0].text);
    expect(requests.at(-1)?.next).toBeUndefined();
  });
});

describe('the hero’s web files', () => {
  it('names what each cut has, and takes the poster at the intro’s line', () => {
    expect(cutKind('hero', false)).toBe('captions, no sound');
    expect(cutKind('hero-dark', true)).toBe('voice, music and captions');
    expect(cutKind('hero', true, SOUND_TAG.bed)).toBe(
      'voice, music, bed and captions',
    );
    expect(cutKind('review', false)).toBe('captions, no sound');
    expect(HERO_POSTER_AT).toBe(6.3);
  });
});

describe('the hero’s sound', () => {
  const film = { sceneStart: 7.1, endStart: 31.0, total: 37.6 };

  it('is none without a voice or music: the silent cut only', () => {
    expect(soundPlan(film)).toBeNull();
  });

  it('puts each line at its place', () => {
    const plan = soundPlan({
      ...film,
      voices: [
        { file: 'a.mp3', at: 7.55 },
        { file: 'b.mp3', at: 10.5 },
      ],
    }) as NonNullable<ReturnType<typeof soundPlan>>;
    expect(plan.inputs).toEqual(['-i', 'a.mp3', '-i', 'b.mp3']);
    expect(plan.filter).toContain(
      '[1:a]aformat=sample_rates=44100:channel_layouts=stereo,adelay=7550|7550[v0]',
    );
    expect(plan.filter).toContain(
      '[2:a]aformat=sample_rates=44100:channel_layouts=stereo,adelay=10500|10500[v1]',
    );
    expect(plan.filter).toContain('[v0][v1]amix=inputs=2:normalize=0');
    expect(plan.filter).toMatch(/atrim=0:37\.600\[a\]$/);
  });

  it('plays the sting under the intro and lands the ending’s last hit on the logo', () => {
    const plan = soundPlan({
      ...film,
      music: { file: 'm.mp3', seconds: 30, stingFrom: 2, hit: 28 },
    }) as NonNullable<ReturnType<typeof soundPlan>>;
    const hitFrom = 28 - END_CARD_HIT - 0.3;
    expect(plan.inputs).toEqual([
      ...['-ss', '2.000', '-i', 'm.mp3'],
      ...['-ss', hitFrom.toFixed(3), '-i', 'm.mp3'],
    ]);
    // Out from a second before the first shot, over 3 s: gone 2 s into it.
    expect(plan.filter).toContain(
      'volume=0.5,afade=t=in:d=0.4,afade=t=out:st=6.10:d=3',
    );
    // The ending starts with the end card's crossfade: its hit at the card's start plus 1.6 s.
    expect(plan.filter).toContain('adelay=30700|30700[outro]');
  });

  it('takes the music from DEMO_MUSIC, its times checked against the track', () => {
    expect(musicFromEnv({})).toBeNull();
    expect(() => musicFromEnv({ DEMO_MUSIC: '/no/such/track.mp3' })).toThrow(
      /no file/,
    );
    const here = import.meta.filename;
    expect(musicFromEnv({ DEMO_MUSIC: here }, () => 20)).toMatchObject({
      stingFrom: 0,
      hit: 19.5,
    });
    expect(() =>
      musicFromEnv({ DEMO_MUSIC: here, DEMO_MUSIC_HIT: '25' }, () => 20),
    ).toThrow(/DEMO_MUSIC_HIT/);
  });
});

describe('the cards’ contrast', () => {
  const ratio = (
    step: 'ink' | 'muted' | 'dim',
    surface: keyof typeof CARD_SURFACES,
  ) => contrastRatio(CARD_COLORS[step], CARD_SURFACES[surface]);

  it('measures as WCAG does', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#777777')).toBe(1);
  });

  it('keeps every text at 4.5:1 or better on the lightest background behind it', () => {
    for (const surface of Object.keys(
      CARD_SURFACES,
    ) as (keyof typeof CARD_SURFACES)[]) {
      for (const step of ['ink', 'muted', 'dim'] as const) {
        expect(ratio(step, surface)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('keeps the first beat and the labels visibly dimmer than the bright beat', () => {
    expect(
      ratio('ink', 'graphite') / ratio('muted', 'graphite'),
    ).toBeGreaterThan(1.8);
    expect(ratio('muted', 'manualPage')).toBeGreaterThan(
      ratio('dim', 'manualPage'),
    );
  });

  it('fills the colours into both cards', () => {
    for (const card of ['intro', 'end']) {
      const page = cardPage(card, 'en');
      expect(page).toContain(`--ink: ${CARD_COLORS.ink}`);
      expect(page).toContain(`--muted: ${CARD_COLORS.muted}`);
    }
    expect(cardPage('intro', 'de')).toContain(`--dim: ${CARD_COLORS.dim}`);
  });
});
