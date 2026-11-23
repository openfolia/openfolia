import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  loopFilter,
  silentName,
  voiceCues,
  voiceFilter,
} from '@/scripts/demo/assemble.mjs';
import { CAPTION_LANGS, checkCaptions } from '@/scripts/demo/captions.mjs';
import { LOOP } from '@/scripts/demo/look.mjs';
import {
  LEAD_MS,
  narrationPlan,
  parseNarration,
  readNarration,
  TAIL_MS,
  WORDS_PER_SECOND,
} from '@/scripts/demo/narration.mjs';
import { LEAST_MS, SHOTS, shotLengths } from '@/scripts/demo/scenes/review.mjs';
import { voiceRequests } from '@/scripts/demo/voice.mjs';
import { readmeLines, webArgs } from '@/scripts/demo/web.mjs';

/** The Review tab video (#445): its captions, its voice-over, its loop and its files. */
describe('the Review video’s words', () => {
  const captions = JSON.parse(
    readFileSync(
      new URL('../demo/captions/review.json', import.meta.url),
      'utf8',
    ),
  );

  it('has three captions from the first shot on, in both languages, short and neutral', () => {
    checkCaptions(captions, 'review.json');
    // Each caption holds until the next starts: keyed by its start shot, in the take's order.
    const starts = Object.keys(captions);
    expect(starts).toHaveLength(3);
    expect(starts[0]).toBe(SHOTS[0]);
    expect(starts).toEqual(SHOTS.filter((shot) => starts.includes(shot)));
    for (const lang of CAPTION_LANGS) {
      for (const shot of starts) {
        const text: string = captions[shot][lang];
        expect(text.length).toBeLessThanOrEqual(60);
        // The owner's rule: no role nouns, names instead.
        expect(text).not.toMatch(
          /\b(reviewer|author|Prüfer\w*|Autor\w*|he|she|er|sie)\b/i,
        );
      }
    }
  });

  it('has a spoken line for every shot, in both languages, not the caption', () => {
    for (const lang of CAPTION_LANGS) {
      const lines = readNarration('review', lang);
      expect(lines.map((line) => line.id)).toEqual(SHOTS);
      for (const line of lines) {
        expect(line.text).not.toBe(captions[line.id]?.[lang]);
        expect(line.text).not.toMatch(
          /\b(reviewer|author|Prüfer\w*|Autor\w*)\b/i,
        );
      }
    }
  });

  it('lasts 15 to 25 s in both languages before the voice exists', () => {
    for (const lang of CAPTION_LANGS) {
      const plan = narrationPlan('review', lang, { dir: '/nonexistent' });
      expect(plan.voiced).toBe(false);
      const lengths = shotLengths(plan);
      const total =
        Object.values(lengths).reduce((sum, ms) => sum + ms, 0) / 1000 -
        LOOP.blend;
      expect(total).toBeGreaterThanOrEqual(15);
      expect(total).toBeLessThanOrEqual(25);
    }
  });
});

describe('the narration', () => {
  const source = `# Title

> A note for the voice.

## 01-open

- a: Mira opens it.
- b: Side by side.

## 02-close

- a: Done.
`;

  it('reads the kit’s format, a shot per line, IDs from scene and letter', () => {
    expect(parseNarration(source)).toEqual([
      { id: '01a', text: 'Mira opens it.', words: 3 },
      { id: '01b', text: 'Side by side.', words: 3 },
      { id: '02a', text: 'Done.', words: 1 },
    ]);
    expect(() => parseNarration('- a: no scene')).toThrow(/:1:/);
    expect(() => parseNarration('## 01-x\n\nsome prose')).toThrow(/:3:/);
    expect(() => parseNarration('## 01-x\n- a: One.\n- a: Two.')).toThrow(
      /01a twice/,
    );
  });

  it('times a shot from its voice, else from its words, with lead and tail', () => {
    // Without a voice file: estimated at the language's speaking rate.
    const estimate = narrationPlan('review', 'en', { dir: '/nonexistent' });
    const first = estimate.shots[0];
    expect(first.spokenMs).toBe(
      Math.round((first.words / WORDS_PER_SECOND.en) * 1000),
    );
    expect(first.ms).toBe(first.spokenMs + LEAD_MS + TAIL_MS);
  });

  it('makes each shot at least as long as its action, the ends longer by the loop', () => {
    const plan = {
      shots: SHOTS.map((id) => ({ id, ms: 1000 })),
      voiced: false,
    };
    const lengths = shotLengths(plan as never);
    expect(lengths['01b']).toBe(LEAST_MS['01b']);
    expect(lengths['01a']).toBe(LEAST_MS['01a'] + LOOP.blend * 1000);
    expect(lengths['03a']).toBe(LEAST_MS['03a'] + LOOP.blend * 1000);
    expect(() =>
      shotLengths({ shots: [{ id: '01a', ms: 1 }], voiced: false } as never),
    ).toThrow(/not the take's/);
  });

  it('voices each line knowing its neighbours', () => {
    const shots = parseNarration(source);
    expect(voiceRequests(shots)).toEqual([
      { id: '01a', text: 'Mira opens it.', next: 'Side by side.' },
      {
        id: '01b',
        text: 'Side by side.',
        previous: 'Mira opens it.',
        next: 'Done.',
      },
      { id: '02a', text: 'Done.', previous: 'Side by side.' },
    ]);
    expect(voiceRequests(shots, ['01b']).map((r) => r.id)).toEqual(['01b']);
  });
});

describe('the loop and the voice', () => {
  it('starts half a second in and blends its end into its opening', () => {
    expect(loopFilter(20)).toBe(
      '[0:v]trim=start=0.5,setpts=PTS-STARTPTS[rest];' +
        '[1:v]trim=end=0.5,setpts=PTS-STARTPTS[head];' +
        '[rest][head]xfade=transition=fade:duration=0.5:offset=19.000,format=yuv420p[out]',
    );
    expect(() => loopFilter(0.8)).toThrow(/too short/);
  });

  it('lays each line in at its shot, the first after the blend', () => {
    const shots = [
      { id: '01a', start: 1000, end: 5000 },
      { id: '01b', start: 5000, end: 8000 },
    ];
    const cues = voiceCues(
      shots,
      [
        { id: '01a', file: 'a.mp3', seconds: 3 },
        { id: '01b', file: 'b.mp3', seconds: 2 },
      ],
      { trim: 1000 },
    );
    expect(cues).toEqual([
      { shot: '01a', file: 'a.mp3', start: 0.25 + LOOP.blend },
      { shot: '01b', file: 'b.mp3', start: 4.25 },
    ]);
    // A line longer than its shot: the take is filmed again.
    expect(() =>
      voiceCues(shots, [{ id: '01b', file: 'b.mp3', seconds: 3 }], {
        trim: 1000,
      }),
    ).toThrow(/film the take again/);
    expect(() =>
      voiceCues(shots, [{ id: '09a', file: 'x.mp3', seconds: 1 }]),
    ).toThrow(/not in the take/);
  });

  it('mixes the lines on one track, cut as the picture is', () => {
    const filter = voiceFilter(
      [
        { shot: '01a', file: 'a.mp3', start: 0.75 },
        { shot: '01b', file: 'b.mp3', start: 4.25 },
      ],
      { first: 1, length: 10 },
    );
    expect(filter).toContain('[1:a]');
    expect(filter).toContain('adelay=750|750');
    expect(filter).toContain('[2:a]');
    expect(filter).toContain('adelay=4250|4250');
    expect(filter).toContain('amix=inputs=2:normalize=0');
    expect(filter).toContain('atrim=start=0.5:end=10.000');
    expect(filter.endsWith('[aout]')).toBe(true);
  });

  it('names the silent cut beside the voiced one', () => {
    expect(silentName('/x/review-en.mp4')).toBe('/x/review-en-silent.mp4');
  });
});

describe('the landing page’s files', () => {
  it('encode without sound unless voiced, at the given width', () => {
    const silent = webArgs('m.mp4', { width: 1280, voiced: false });
    expect(silent.mp4).toContain('-an');
    expect(silent.mp4).toContain('scale=1280:-2:flags=lanczos');
    expect(silent.webm).toContain('libvpx-vp9');
    const voiced = webArgs('m.mp4', { width: 1280, voiced: true });
    expect(voiced.mp4).toContain('aac');
    expect(voiced.webm).toContain('libopus');
  });

  it('keep one README line per file', () => {
    const before = '# Videos\n\n- b.mp4: old\n- a.mp4: kept\n';
    expect(readmeLines(before, '- b.mp4: new')).toEqual([
      '- a.mp4: kept',
      '- b.mp4: new',
    ]);
  });
});
