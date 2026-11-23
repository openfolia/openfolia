// The tab videos' captions (#441, `docs/demo-videos.md`, "Captions"): a few short signposts per
// video (three, as a rule), in English and German, shown on the graphite under the window. A
// video's captions are a JSON file, `scripts/demo/captions/<video>.json`, keyed by the kit's shot
// ID where each caption starts:
//
//   { "01a": { "en": "Mira opens the module", "de": "Mira öffnet das Modul" }, "02a": … }
//
// A caption holds from its shot until the next caption starts, or the take's end, and fades only
// there: shots in between carry it on. Plain text only: no markup, one line, no closing full stop.

import { CAPTION } from './look.mjs';

export const CAPTION_LANGS = ['en', 'de'];

/** The captions file, checked: every entry in both languages, one line, short enough. */
export function checkCaptions(data, name = 'captions') {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error(`${name}: an object of shot IDs`);
  }
  for (const [shot, texts] of Object.entries(data)) {
    if (!/^[0-9a-z][0-9a-z-]*$/.test(shot)) {
      throw new Error(`${name}: "${shot}" is not a shot ID`);
    }
    if (typeof texts !== 'object' || texts === null) {
      throw new Error(`${name} ${shot}: { "en": …, "de": … }`);
    }
    const extra = Object.keys(texts).filter((l) => !CAPTION_LANGS.includes(l));
    if (extra.length) throw new Error(`${name} ${shot}: unknown ${extra}`);
    for (const lang of CAPTION_LANGS) {
      const text = texts[lang];
      if (typeof text !== 'string' || !text.trim()) {
        throw new Error(`${name} ${shot}: no ${lang} caption`);
      }
      if (/[\r\n<>]/.test(text)) {
        throw new Error(`${name} ${shot} ${lang}: one line of plain text`);
      }
      if (/\.\s*$/.test(text) && !/\.\.\.\s*$/.test(text)) {
        throw new Error(`${name} ${shot} ${lang}: no full stop at the end`);
      }
      if (text.length > CAPTION.maxLength) {
        throw new Error(
          `${name} ${shot} ${lang}: ${text.length} characters, at most ${CAPTION.maxLength}`,
        );
      }
    }
  }
  return data;
}

/**
 * The captions on a take's timeline, in seconds: each from the start of its shot to the start of
 * the next shot with a caption (the last one to the last shot's end), as the kit recorded them
 * (milliseconds from the take's start), less the take's trim and within its length. Throws for a
 * caption whose shot the take does not have, and for one too short to read.
 */
export function captionCues(shots, captions, lang, { trim = 0, length } = {}) {
  if (!CAPTION_LANGS.includes(lang)) throw new Error(`no captions in ${lang}`);
  const ids = new Set(shots.map((shot) => shot.id));
  const unknown = Object.keys(captions).filter((id) => !ids.has(id));
  if (unknown.length) {
    throw new Error(`captions for shots the take does not have: ${unknown}`);
  }
  const starts = shots.filter((shot) => Object.hasOwn(captions, shot.id));
  const last = shots.at(-1);
  return starts.map((shot, k) => {
    const until = starts[k + 1]?.start ?? last.end;
    const start = Math.max(0, (shot.start - trim) / 1000);
    const end = Math.min(length ?? Infinity, (until - trim) / 1000);
    if (end - start < CAPTION.minSeconds) {
      throw new Error(
        `shot ${shot.id}: ${(end - start).toFixed(2)} s, a caption needs ${CAPTION.minSeconds} s`,
      );
    }
    return { shot: shot.id, text: captions[shot.id][lang], start, end };
  });
}

/**
 * The ffmpeg filter that lays the captions over `input` (a label such as `[framed]`): caption k
 * is the picture at input `first + k` (a frame-sized PNG, looped for the caption's length), faded
 * in and out only at its start and its end (a caption over several shots does not fade between them). Ends in `output`.
 */
export function captionFilter(cues, { input, output, first }) {
  if (cues.length === 0) return `${input}null${output}`;
  const fade = CAPTION.fade;
  const parts = cues.map((cue, k) => {
    const length = cue.end - cue.start;
    return (
      `[${first + k}:v]format=rgba,` +
      `fade=t=in:st=0:d=${fade}:alpha=1,` +
      `fade=t=out:st=${(length - fade).toFixed(3)}:d=${fade}:alpha=1,` +
      `setpts=PTS-STARTPTS+${cue.start.toFixed(3)}/TB[c${k}]`
    );
  });
  let previous = input;
  cues.forEach((cue, k) => {
    const label = k === cues.length - 1 ? output : `[o${k}]`;
    parts.push(
      `${previous}[c${k}]overlay=0:0:eof_action=pass:` +
        `enable='between(t,${cue.start.toFixed(3)},${cue.end.toFixed(3)})'${label}`,
    );
    previous = label;
  });
  return parts.join(';');
}

/** The ffmpeg inputs for the captions' pictures, in the order `captionFilter` expects. */
export function captionInputs(cues, pictures, fps = 30) {
  return cues.flatMap((cue, k) => [
    ...['-loop', '1', '-framerate', String(fps)],
    ...['-t', (cue.end - cue.start).toFixed(3), '-i', pictures[k]],
  ]);
}
