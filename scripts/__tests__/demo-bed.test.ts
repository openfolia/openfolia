import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BED,
  bedCopies,
  bedFilter,
  bedFromEnv,
  bedGain,
  duckExpression,
  SOUND_TAG,
  VOICE,
  voiceFilter,
  voiceGain,
  voiceJoinFilter,
} from '@/scripts/demo/assemble.mjs';
import { LOOP } from '@/scripts/demo/look.mjs';
import { cutKind } from '@/scripts/demo/web.mjs';

/** A tab video's music bed (`DEMO_BED`, `docs/demo-videos.md`, "Music, tab videos"). */
describe('the tab videos’ music bed', () => {
  it('sits at about −29 LUFS, ducks 3–4 dB under a line and fades 1 s in, 1.5 s out', () => {
    expect(BED.lufs).toBeGreaterThanOrEqual(-30);
    expect(BED.lufs).toBeLessThanOrEqual(-28);
    expect(BED.duck).toBeGreaterThanOrEqual(3);
    expect(BED.duck).toBeLessThanOrEqual(4);
    expect(BED.fadeIn).toBe(1);
    expect(BED.fadeOut).toBe(1.5);
  });

  it('brings any track to the bed’s level, and refuses a silent one', () => {
    expect(bedGain(-14)).toBe(-15);
    expect(bedGain(-35.5)).toBe(6.5);
    expect(() => bedGain(-Infinity)).toThrow(/silent/);
    expect(() => bedGain(Number.NaN)).toThrow(/silent/);
  });

  it('loops a short track with crossfades until it covers the film', () => {
    expect(bedCopies(30, 22)).toBe(1);
    expect(bedCopies(22, 22)).toBe(1);
    // 10 s copies overlapping by 1.5 s: 10, 18.5, 27 s.
    expect(bedCopies(10, 22)).toBe(3);
    const copies = bedCopies(10, 22);
    expect(copies * 10 - (copies - 1) * BED.crossfade).toBeGreaterThanOrEqual(
      22,
    );
    expect(() => bedCopies(2, 22)).toThrow(/too short/);
  });

  it('dips while a line is spoken, ramped, and stays at 0 dB without lines', () => {
    expect(duckExpression([])).toBe('1');
    const expression = duckExpression([
      { from: 1, to: 3 },
      { from: 5, to: 6 },
    ]);
    // The expression (quoted in the filter, so its commas need no escape), evaluated here as
    // JavaScript at a few moments.
    const gain = (t: number) =>
      new Function(
        't',
        'const { min, max, pow } = Math; const clip = (x, a, b) => min(max(x, a), b);' +
          `return ${expression};`,
      )(t) as number;
    const db = (t: number) => 20 * Math.log10(gain(t));
    expect(db(0)).toBeCloseTo(0, 5);
    expect(db(2)).toBeCloseTo(-BED.duck, 5);
    expect(db(1 - BED.ramp / 2)).toBeCloseTo(-BED.duck / 2, 5);
    expect(db(4)).toBeCloseTo(0, 5);
    expect(db(5.5)).toBeCloseTo(-BED.duck, 5);
    expect(db(6 + BED.ramp)).toBeCloseTo(0, 5);
  });

  it('joins, levels, ducks, fades and cuts the bed to the film', () => {
    const { inputs, filter } = bedFilter({
      file: 'bed.mp3',
      copies: 3,
      gain: -6.5,
      length: 22,
      spans: [{ from: 1, to: 3 }],
      first: 4,
    });
    expect(inputs).toEqual(['-i', 'bed.mp3', '-i', 'bed.mp3', '-i', 'bed.mp3']);
    expect(filter).toContain('[4:a]');
    expect(filter).toContain('[6:a]');
    expect(filter.match(/acrossfade=d=1\.5/g)).toHaveLength(2);
    expect(filter).toContain('atrim=0:22.000');
    expect(filter).toContain('volume=-6.5dB');
    expect(filter).toContain(':eval=frame');
    expect(filter).toContain('afade=t=in:d=1,');
    // The fade out ends on the film's last frame: where it loops into its silent start.
    expect(filter).toContain('afade=t=out:st=20.500:d=1.5[bed]');
    expect(filter.endsWith('[bed]')).toBe(true);
  });

  it('meets cleanly across the loop’s blend: both ends faded to silence', () => {
    // The loop crossfades the film's last blend into its first: both lie inside the fades.
    expect(BED.fadeIn).toBeGreaterThan(LOOP.blend);
    expect(BED.fadeOut).toBeGreaterThan(LOOP.blend);
  });

  it('comes only from DEMO_BED, and names a missing file', () => {
    expect(bedFromEnv({})).toBeNull();
    expect(bedFromEnv({ DEMO_BED: '  ' })).toBeNull();
    expect(() => bedFromEnv({ DEMO_BED: '/nowhere/bed.mp3' })).toThrow(
      /DEMO_BED: no file/,
    );
    const dir = mkdtempSync(join(tmpdir(), 'bed-'));
    try {
      const file = join(dir, 'bed.mp3');
      writeFileSync(file, '');
      expect(bedFromEnv({ DEMO_BED: file })).toBe(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('names the bed in the README line of the cut with sound', () => {
    expect(cutKind('releases', true, SOUND_TAG.bed)).toBe(
      'voice, music bed and captions',
    );
    expect(cutKind('releases', true, SOUND_TAG.voice)).toBe(
      'voice and captions',
    );
    expect(cutKind('releases', true)).toBe('voice and captions');
    expect(cutKind('releases', false, SOUND_TAG.bed)).toBe(
      'captions, no sound',
    );
  });
});

/** The voice-over's level in a tab video's cut (#805): one gain per cut, to `VOICE.lufs`. */
describe('the tab videos’ voice level', () => {
  it('aims at about −23 LUFS, well above the bed', () => {
    expect(VOICE.lufs).toBeGreaterThanOrEqual(-24);
    expect(VOICE.lufs).toBeLessThanOrEqual(-22);
    expect(VOICE.lufs - BED.lufs).toBeGreaterThanOrEqual(5);
  });

  it('brings a loud and a quiet language to the same level, and refuses silence', () => {
    // As measured: German lines about −19 LUFS, English about −26.
    expect(voiceGain(-18.76)).toBe(Number((VOICE.lufs + 18.76).toFixed(2)));
    expect(voiceGain(-26.23)).toBe(Number((VOICE.lufs + 26.23).toFixed(2)));
    expect(-18.76 + voiceGain(-18.76)).toBeCloseTo(-26.23 + voiceGain(-26.23));
    expect(() => voiceGain(-Infinity)).toThrow(/silent/);
    expect(() => voiceGain(Number.NaN)).toThrow(/silent/);
  });

  it('measures all the lines together and applies one gain to the whole track', () => {
    expect(voiceJoinFilter(3)).toBe(
      '[0:a]aresample=48000,aformat=channel_layouts=stereo[l0];' +
        '[1:a]aresample=48000,aformat=channel_layouts=stereo[l1];' +
        '[2:a]aresample=48000,aformat=channel_layouts=stereo[l2];' +
        '[l0][l1][l2]concat=n=3:v=0:a=1,',
    );
    const cues = [
      { shot: '01a', file: 'a.mp3', start: 0.75 },
      { shot: '01b', file: 'b.mp3', start: 4.25 },
    ];
    const levelled = voiceFilter(cues, { first: 1, length: 10, gain: -4.2 });
    // Once, after the lines are mixed: never per line.
    expect(levelled.match(/volume=/g)).toHaveLength(1);
    expect(levelled.endsWith(',volume=-4.2dB[aout]')).toBe(true);
    expect(voiceFilter(cues, { first: 1, length: 10 })).not.toContain(
      'volume=',
    );
  });
});
