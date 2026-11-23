// The voice-over of a tab video (#441, "Sound"; `docs/demo-videos.md`, "Voice-over"): what is
// spoken per shot, in the kit's narration format, and each shot's length from it. The voice is
// made by the owner (`voice.mjs`, their own ElevenLabs key); until it exists, a shot's length is
// estimated from its words.
//
// The script is `scripts/demo/captions/<video>.narration.<lang>.md`, one block per scene, one
// line per shot (the kit's format); the scene's number and the line's letter are the shot's ID:
//
//   ## 01-diff
//
//   - a: Mira's revision, every edit marked word by word.     → shot 01a
//   - b: Old and new text, side by side.                       → shot 01b
//
// The voice: one file per shot, `.demo/voice/<video>-<lang>/<shot>.mp3`.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CAPTION_LANGS } from './captions.mjs';
import { LOOP } from './look.mjs';
import { DEMO_DIR } from './paths.mjs';

const FFPROBE = process.env.FFPROBE ?? 'ffprobe';

/** Speaking rates for the estimate before the voice exists, in words per second. */
export const WORDS_PER_SECOND = { en: 2.6, de: 2.3 };
/** Silence before a shot's line, and after it, before the next shot starts. */
export const LEAD_MS = 250;
export const TAIL_MS = 450;
/**
 * The pause between two sentences in one line (#805): the voice reads it as a `<break>` tag, the
 * estimate counts it. Without it, "Jonas approves. Every word read…" runs on as one sentence.
 */
export const SENTENCE_PAUSE_MS = 450;

/** Words before a full stop that end no sentence: "Nr. 4", "vgl. Abschnitt 2". */
const ABBREVIATIONS = new Set(
  'bzw ca dr etc evtl ggf inkl mr mrs nr usw vgl vs'.split(' '),
);

/**
 * Where a line has a sentence end (`.`, `?`, `!`; never `…`), perhaps closed by a quote or a
 * bracket, followed by another sentence: the index just after each. No sentence ends at a full
 * stop after a single letter or letters with dots ("z. B.", "e.g."), after a number (a German
 * ordinal: "am 3. Mai") or after one of the abbreviations above.
 */
export function sentenceBreaks(text) {
  const breaks = [];
  const ends = /(\S*?)([.?!])(["“”’‘)]*)(?=\s+["„“‚‘(]?\p{Lu})/gu;
  for (const m of text.matchAll(ends)) {
    const [, word, mark] = m;
    if (mark === '.') {
      const bare = word.replace(/^["„“‚‘(]+/, '');
      if (bare.endsWith('.')) continue; // "..."
      if (/^(\p{L}\.)*\p{L}$/u.test(bare) || /^\d+$/.test(bare)) continue;
      if (ABBREVIATIONS.has(bare.toLowerCase())) continue;
    }
    breaks.push(m.index + m[0].length);
  }
  return breaks;
}

/** The line as the voice reads it: a `<break>` after each sentence end inside it. */
export function withPauses(text) {
  const tag = ` <break time="${SENTENCE_PAUSE_MS / 1000}s" />`;
  let out = '';
  let from = 0;
  for (const at of sentenceBreaks(text)) {
    out += text.slice(from, at) + tag;
    from = at;
  }
  return out + text.slice(from);
}

export const narrationFile = (video, lang) =>
  join(import.meta.dirname, 'captions', `${video}.narration.${lang}.md`);
export const voiceDir = (video, lang) =>
  join(DEMO_DIR, 'voice', `${video}-${lang}`);

export const countWords = (text) => text.split(/\s+/).filter(Boolean).length;

/** The script as `[{ id, text, words }]`, in order; refuses a line it cannot read. */
export function parseNarration(source, name = 'narration') {
  const shots = [];
  let scene;
  for (const [n, line] of source.split(/\r?\n/).entries()) {
    if (!line.trim() || line.startsWith('# ') || line.startsWith('>')) continue;
    const head = line.match(/^## (\d\d)-[a-z0-9-]+\s*$/);
    if (head) {
      scene = head[1];
      continue;
    }
    const shot = line.match(/^- ([a-z]): (\S.*)$/);
    if (!shot || !scene) {
      throw new Error(`${name}:${n + 1}: "## NN-scene" or "- a: line"`);
    }
    const id = `${scene}${shot[1]}`;
    if (shots.some((s) => s.id === id)) throw new Error(`${name}: ${id} twice`);
    const text = shot[2].trim();
    if (/[<>]/.test(text)) throw new Error(`${name} ${id}: plain text only`);
    shots.push({ id, text, words: countWords(text) });
  }
  return shots;
}

export function readNarration(video, lang) {
  if (!CAPTION_LANGS.includes(lang)) throw new Error(`no narration in ${lang}`);
  const file = narrationFile(video, lang);
  return parseNarration(readFileSync(file, 'utf8'), file);
}

export function audioSeconds(file) {
  return Number(
    execFileSync(
      FFPROBE,
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'csv=p=0',
        file,
      ],
      { encoding: 'utf8' },
    ).trim(),
  );
}

/**
 * Each shot's line and its length in ms: the voice's, when its file exists, else estimated from
 * the words and the pauses between its sentences; plus the lead and the tail. `voiced` says
 * whether every shot has its voice.
 */
export function narrationPlan(
  video,
  lang,
  { dir = voiceDir(video, lang), seconds = audioSeconds } = {},
) {
  const shots = readNarration(video, lang).map((shot) => {
    const file = join(dir, `${shot.id}.mp3`);
    const voice = existsSync(file) ? file : undefined;
    const length = voice ? seconds(voice) : undefined;
    if (voice && !Number.isFinite(length)) {
      throw new Error(`${voice}: not a sound file ffprobe can read`);
    }
    const spoken = voice
      ? length * 1000
      : (shot.words / WORDS_PER_SECOND[lang]) * 1000 +
        sentenceBreaks(shot.text).length * SENTENCE_PAUSE_MS;
    return {
      ...shot,
      voice,
      spokenMs: Math.round(spoken),
      ms: Math.round(LEAD_MS + spoken + TAIL_MS),
    };
  });
  return { shots, voiced: shots.every((shot) => shot.voice) };
}

/**
 * A tab video's shot lengths in ms (`plan` from `narrationPlan`): each shot as long as its line,
 * at least as long as its action needs (`leastMs`, by shot ID, in the take's order), and the
 * first and the last longer by the loop's blend, so no line is under it.
 */
export function timedShots(plan, leastMs) {
  const ids = plan.shots.map((shot) => shot.id);
  const shots = Object.keys(leastMs);
  if (ids.join() !== shots.join()) {
    throw new Error(`the narration's shots ${ids} are not the take's ${shots}`);
  }
  const blend = LOOP.blend * 1000;
  return Object.fromEntries(
    plan.shots.map((shot, i) => [
      shot.id,
      Math.max(shot.ms, leastMs[shot.id]) +
        (i === 0 || i === shots.length - 1 ? blend : 0),
    ]),
  );
}

/** The video's length in seconds from its shots' lengths: the loop's blend is shown once. */
export const loopedSeconds = (lengths) =>
  Object.values(lengths).reduce((sum, ms) => sum + ms, 0) / 1000 - LOOP.blend;
