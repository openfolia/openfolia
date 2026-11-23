// Puts one video together from its take (#441, `docs/demo-videos.md`, "The shared look"): the
// recording as the rounded window on the graphite; for a tab video, its captions under the
// window; for the hero, the intro and end cards around it with 0.3 s crossfades. The master is
// 1920×1080, 30 fps, H.264 `crf 18`. A tab video loops: its last 0.5 s blend into its opening.
// It comes out silent (`<video>-<lang>-silent.mp4`, captions only) and, once the voice-over
// exists (`narration.mjs`, `voice.mjs`), voiced (`<video>-<lang>.mp4`, captions and voice).
//
//   node scripts/demo/assemble.mjs <video> --lang en|de [--take <file.webm>] [--shots <file.json>]
//                                  [--captions <file.json>] [--voice <dir>] [--out <file.mp4>]
//
// The take and its shots come from the recording kit (`/demo-video`): by default
// `.demo/takes/<video>-<lang>.webm` and `.demo/takes/<video>-<lang>.json` (the kit's segment
// file: `{ "trim": <ms>, "shots": [{ "id", "start", "end" }] }`, in milliseconds). Captions by
// default from `scripts/demo/captions/<video>.json`. The cards from `.demo/cards/`
// (`cards/render.mjs`). The voice from `.demo/voice/<video>-<lang>/<shot>.mp3`, each line laid
// in at its shot's start. Writes `.demo/films/<video>-<lang>[-silent].mp4`.
// With `DEMO_BED=<file>`, a tab video's cut with sound has a quiet music bed under the voice
// (`BED`, "Music, tab videos" in the doc); the silent cut never does.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  CAPTION_LANGS,
  captionCues,
  captionFilter,
  captionInputs,
  checkCaptions,
} from './captions.mjs';
import { captionPage, GRAIN_SVG, LOOK, LOOP } from './look.mjs';
import {
  LEAD_MS,
  narrationFile,
  narrationPlan,
  voiceDir,
} from './narration.mjs';
import { DEMO_DIR } from './paths.mjs';
import { chromium } from './playwright.mjs';

/** The five videos; the hero's dark cut is a video of its own. Only the hero has cards. */
export const VIDEOS = [
  'hero',
  'hero-dark',
  'editor',
  'manual-builder',
  'review',
  'releases',
];
export const hasCards = (video) => video.startsWith('hero');

const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';
const FFPROBE = process.env.FFPROBE ?? 'ffprobe';
const FADE = 0.3;
/** The intermediate a tab video is looped from: lossless, so the loop costs no quality. */
const LOSSLESS = [
  ...['-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0'],
  ...['-pix_fmt', 'yuv420p', '-r', '30'],
];
const ENCODE = [
  ...['-c:v', 'libx264', '-preset', 'medium', '-crf', '18'],
  ...['-pix_fmt', 'yuv420p', '-r', '30'],
];

const ff = (args) =>
  execFileSync(FFMPEG, ['-loglevel', 'error', '-y', ...args], {
    stdio: 'inherit',
  });
const duration = (file) =>
  Number(
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

/**
 * The ffmpeg filter that frames the take (input 0) with the background (input 1) and the
 * window's mask (input 2), ending in `output`.
 */
export function frameFilter(output) {
  const w = LOOK.window;
  return (
    `[0:v]fps=30,scale=${w.width}:${w.height}:flags=lanczos,format=rgba[app];` +
    `[2:v]format=gray[mask];[app][mask]alphamerge[window];` +
    `[1:v][window]overlay=${w.x}:${w.y}:shortest=1,format=yuv420p${output}`
  );
}

/** The ffmpeg filter that joins `count` clips with 0.3 s crossfades, given their lengths. */
export function joinFilter(lengths) {
  let graph = lengths
    .map((_, i) => `[${i}:v]settb=AVTB,fps=30,format=yuv420p[n${i}]`)
    .join(';');
  if (lengths.length === 1) return graph.replace('[n0]', '[out]');
  let previous = '[n0]';
  let offset = 0;
  for (let i = 1; i < lengths.length; i++) {
    offset += lengths[i - 1] - FADE;
    const label = i === lengths.length - 1 ? '[out]' : `[x${i}]`;
    graph += `;${previous}[n${i}]xfade=transition=fade:duration=${FADE}:offset=${offset.toFixed(3)}${label}`;
    previous = label;
  }
  return graph;
}

/**
 * How much of the take the scene keeps, in seconds from its trim. A tab video ends where its last
 * shot ends: what the browser recorded while the take was closing (up to a second or more) would
 * be a still tail before the loop's blend. The hero keeps all of its take: its parts are already
 * cut, with their tails (`record.mjs`, `joinParts`).
 */
export function sceneLength(takeSeconds, { trim = 0, shots = [] }, { loops }) {
  const recorded = takeSeconds - trim / 1000;
  if (!loops || shots.length === 0) return recorded;
  return Math.min(recorded, (shots.at(-1).end - trim) / 1000);
}

/**
 * The ffmpeg filter that makes a clip of `length` seconds loop, given twice (inputs 0 and 1, so
 * nothing is held in memory): it starts `blend` seconds in, and its last `blend` seconds fade into
 * its first, so its end is its start.
 */
export function loopFilter(length, blend = LOOP.blend) {
  const offset = length - 2 * blend;
  if (offset <= 0) throw new Error(`${length} s is too short to loop`);
  return (
    `[0:v]trim=start=${blend},setpts=PTS-STARTPTS[rest];` +
    `[1:v]trim=end=${blend},setpts=PTS-STARTPTS[head];` +
    `[rest][head]xfade=transition=fade:duration=${blend}:offset=${offset.toFixed(3)},format=yuv420p[out]`
  );
}

/**
 * The voice-over's lines on the take's timeline, in seconds: each at its shot's start plus the
 * lead (the first after the loop's blend too, so the loop cuts none of it). Throws for a line
 * longer than its shot: the take was filmed before the voice, so it is filmed again.
 */
export function voiceCues(shots, lines, { trim = 0, blend = LOOP.blend } = {}) {
  const byId = new Map(shots.map((shot) => [shot.id, shot]));
  return lines.map((line, i) => {
    const shot = byId.get(line.id);
    if (!shot) throw new Error(`a voice for shot ${line.id}, not in the take`);
    const start = (shot.start - trim + LEAD_MS) / 1000 + (i === 0 ? blend : 0);
    const end = (shot.end - trim) / 1000;
    if (start + line.seconds > end + 0.05) {
      throw new Error(
        `shot ${line.id}: its line runs ${(start + line.seconds - end).toFixed(2)} s past it; film the take again now that the voice exists`,
      );
    }
    return { shot: line.id, file: line.file, start };
  });
}

/**
 * The voice-over's level in a tab video's cut with sound (#805): the voice files of one
 * language can come out several LU louder than the other's, so a cut's lines are measured
 * together (`voiceLoudness`) and brought to `VOICE.lufs` integrated by one fixed gain per cut.
 * The lines keep their dynamics against each other: no line is normalised alone, no compressor.
 * The bed keeps its own level under it (`BED`).
 */
export const VOICE = { lufs: -23 };

/** The gain in dB that brings the voice, measured at `measured` LUFS, to `VOICE.lufs`. */
export function voiceGain(measured, target = VOICE.lufs) {
  if (!Number.isFinite(measured) || measured < -70) {
    throw new Error(
      `the voice's loudness ${measured} LUFS: silent or unreadable`,
    );
  }
  return Number((target - measured).toFixed(2));
}

/**
 * The ffmpeg filter that lays the voice's lines (inputs `first`…) on one track of `length`
 * seconds, then cuts the loop's first `blend` seconds, as `loopFilter` does to the picture; with
 * a `gain` (dB, from `voiceGain`), the whole track is raised or lowered by it.
 */
export function voiceFilter(cues, { first, length, blend = LOOP.blend, gain }) {
  const parts = cues.map((cue, k) => {
    const ms = Math.round(cue.start * 1000);
    return `[${first + k}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${ms}|${ms}[v${k}]`;
  });
  const inputs = cues.map((_, k) => `[v${k}]`).join('');
  parts.push(
    `${inputs}amix=inputs=${cues.length}:normalize=0:dropout_transition=0,apad,` +
      `atrim=start=${blend}:end=${length.toFixed(3)},asetpts=PTS-STARTPTS` +
      (gain === undefined ? '' : `,volume=${gain}dB`) +
      '[aout]',
  );
  return parts.join(';');
}

/**
 * A tab video's music bed (#441, `docs/demo-videos.md`, "Music, tab videos"), from `DEMO_BED`:
 * very quiet, under the voice. The track is measured (`loudness`) and brought to `BED.lufs`
 * integrated, about 24 dB under the voice-over's lines; while a line is spoken it dips a further
 * `BED.duck` dB, ramped over `BED.ramp` s (volume automation from the voice's cues: simpler and
 * steadier than a compressor keyed on the voice). A track shorter than the film is laid end to
 * end with `BED.crossfade` s equal-power crossfades. It fades in over `BED.fadeIn` s and out over
 * `BED.fadeOut` s, so where the film loops (its end into its start) both sides are silent: no bump.
 */
export const BED = {
  lufs: -29,
  duck: 3.5,
  ramp: 0.25,
  crossfade: 1.5,
  fadeIn: 1,
  fadeOut: 1.5,
};

/** The gain in dB that brings a track measured at `measured` LUFS to the bed's level. */
export function bedGain(measured, target = BED.lufs) {
  if (!Number.isFinite(measured) || measured < -70) {
    throw new Error(
      `the bed's loudness ${measured} LUFS: silent or unreadable`,
    );
  }
  return Number((target - measured).toFixed(2));
}

/** How many copies of a `track`-second bed cover `film` seconds, joined with crossfades. */
export function bedCopies(track, film, crossfade = BED.crossfade) {
  if (track >= film) return 1;
  if (track <= 2 * crossfade) {
    throw new Error(`the bed (${track.toFixed(1)} s) is too short to loop`);
  }
  return Math.ceil((film - crossfade) / (track - crossfade));
}

/**
 * The bed's gain over time as an ffmpeg `volume` expression (dB to a factor): 0 dB, and `duck`
 * dB down while a line is spoken (`spans`: `{ from, to }` in seconds on the film), ramped in and
 * out over `ramp` s around each.
 */
export function duckExpression(
  spans,
  { duck = BED.duck, ramp = BED.ramp } = {},
) {
  if (spans.length === 0) return '1';
  const r = ramp.toFixed(3);
  const depth = spans
    .map(
      ({ from, to }) =>
        `clip(min((t-${from.toFixed(3)}+${r})/${r},(${to.toFixed(3)}+${r}-t)/${r}),0,1)`,
    )
    .reduce((a, b) => `max(${a},${b})`);
  return `pow(10,-${duck}*${depth}/20)`;
}

/**
 * The bed's part of the sound: its inputs (`copies` times the track, after inputs `first`…) and
 * the filter that joins them, sets its level (`gain` dB), ducks it under the voice, fades it in
 * and out, and cuts it to the film's `length`, ending in `[bed]`.
 */
export function bedFilter({ file, copies, gain, length, spans, first }) {
  const stereo = 'aresample=48000,aformat=channel_layouts=stereo';
  const inputs = Array.from({ length: copies }, () => ['-i', file]).flat();
  const parts = Array.from(
    { length: copies },
    (_, k) => `[${first + k}:a]${stereo}[b${k}]`,
  );
  let previous = '[b0]';
  for (let k = 1; k < copies; k++) {
    parts.push(
      `${previous}[b${k}]acrossfade=d=${BED.crossfade}:c1=qsin:c2=qsin[j${k}]`,
    );
    previous = `[j${k}]`;
  }
  const out = Math.max(0, length - BED.fadeOut).toFixed(3);
  parts.push(
    `${previous}atrim=0:${length.toFixed(3)},asetpts=PTS-STARTPTS,volume=${gain}dB,` +
      `volume='${duckExpression(spans)}':eval=frame,` +
      `afade=t=in:d=${BED.fadeIn},afade=t=out:st=${out}:d=${BED.fadeOut}[bed]`,
  );
  return { inputs, filter: parts.join(';') };
}

/** The voiced cut's metadata comment: what its sound holds. */
export const SOUND_TAG = { voice: 'demo: voice', bed: 'demo: voice and bed' };

/** The bed's file from `DEMO_BED`, or null: never committed (the owner's own track). */
export function bedFromEnv(env = process.env) {
  const file = env.DEMO_BED?.trim();
  if (!file) return null;
  if (!existsSync(file)) throw new Error(`DEMO_BED: no file ${file}`);
  return file;
}

/**
 * A track's integrated loudness in LUFS (ffmpeg's `loudnorm`, measured only), over its first
 * `seconds` (all of it by default): the part the film plays, since a track's opening can be much
 * quieter than its whole.
 */
export function loudness(file, seconds) {
  return measureLoudness(
    [...(seconds ? ['-t', seconds.toFixed(3)] : []), '-i', file],
    '',
    file,
  );
}

/**
 * The filter that joins a cut's voice lines (inputs 0…) into one track for `voiceLoudness`: the
 * lines one after the other; the silence between them would be gated out of an integrated
 * measurement anyway.
 */
export function voiceJoinFilter(count) {
  const stereo = 'aresample=48000,aformat=channel_layouts=stereo';
  const parts = Array.from(
    { length: count },
    (_, k) => `[${k}:a]${stereo}[l${k}]`,
  );
  const inputs = parts.map((_, k) => `[l${k}]`).join('');
  return `${parts.join(';')};${inputs}concat=n=${count}:v=0:a=1,`;
}

/** The integrated loudness in LUFS of a cut's voice lines, all together (`voiceJoinFilter`). */
export function voiceLoudness(files) {
  if (files.length === 0) throw new Error('no voice lines to measure');
  return measureLoudness(
    files.flatMap((file) => ['-i', file]),
    voiceJoinFilter(files.length),
    'the voice',
  );
}

function measureLoudness(inputs, before, name) {
  const result = spawnSync(
    FFMPEG,
    [
      '-hide_banner',
      '-nostats',
      ...inputs,
      ...(before
        ? ['-filter_complex', `${before}loudnorm=print_format=json`]
        : ['-af', 'loudnorm=print_format=json']),
      '-f',
      'null',
      '-',
    ],
    { encoding: 'utf8' },
  );
  const json = /\{[^{}]*"input_i"[^{}]*\}/.exec(result.stderr ?? '');
  if (!json) throw new Error(`${name}: no loudness measured`);
  return Number(JSON.parse(json[0]).input_i);
}

/** The music's level under the cards, as the skill's pitch film has it. */
export const MUSIC_VOLUME = 0.5;
/** Where the end card's logo lands (its green leaf), in seconds into the card. */
export const END_CARD_HIT = 1.6;

/** The hero's bed (#804): in under the sting's fade, out over the app's last 1.5 s. */
export const HERO_BED = { fadeIn: 2, lead: 1, fadeOut: 1.5 };

/**
 * The hero's sound (#442): each shot's line of the voice-over at its place, and, with a music
 * file, the logo sting under the intro card (fading out about 2 s into the first shot), and the
 * track's ending under the end card with its last hit on the logo. Times in seconds on the film;
 * `music` is `{ file, seconds, stingFrom, hit }` (`hit`: the track's last hit, `stingFrom`: where
 * the sting starts), or null. With `bed` (`{ file, gain, spans }`, #804), the tab videos' quiet
 * bed plays under the app: it comes in under the sting's fade (`HERO_BED.lead` s before the first
 * shot, over `HERO_BED.fadeIn` s), at `gain` dB, dips under each spoken line (`spans`, on the
 * film), and fades out over the app's last `HERO_BED.fadeOut` s, so the ending lands clean.
 * `voiceGain` (dB, from `voiceGain`) brings the lines to `VOICE.lufs`, as in the tab videos.
 * Resolves to ffmpeg's inputs (after the video, which is input 0) and the filter, which ends in
 * `[a]`; null without any sound.
 */
export function soundPlan({
  sceneStart,
  endStart,
  total,
  voices = [],
  music = null,
  bed = null,
  voiceGain: gain,
}) {
  const inputs = [];
  const parts = [];
  const labels = [];
  const stereo = 'aformat=sample_rates=44100:channel_layouts=stereo';
  const delayed = (seconds) => {
    const ms = Math.max(0, Math.round(seconds * 1000));
    return `adelay=${ms}|${ms}`;
  };
  for (const voice of voices) {
    inputs.push('-i', voice.file);
    const k = labels.length;
    const level = gain === undefined ? '' : `volume=${gain}dB,`;
    parts.push(`[${k + 1}:a]${stereo},${level}${delayed(voice.at)}[v${k}]`);
    labels.push(`[v${k}]`);
  }
  if (music) {
    const sting = labels.length + 1;
    inputs.push('-ss', music.stingFrom.toFixed(3), '-i', music.file);
    parts.push(
      `[${sting}:a]volume=${MUSIC_VOLUME},afade=t=in:d=0.4,afade=t=out:st=${Math.max(0, sceneStart - 1).toFixed(2)}:d=3:curve=qsin,${stereo}[sting]`,
    );
    labels.push('[sting]');
    // The ending starts with the end card's crossfade, so its last hit lands on the logo.
    const from = Math.max(0, music.hit - END_CARD_HIT - FADE);
    inputs.push('-ss', from.toFixed(3), '-i', music.file);
    parts.push(
      `[${sting + 1}:a]volume=${MUSIC_VOLUME},afade=t=in:d=0.6:curve=qsin,${stereo},${delayed(endStart + END_CARD_HIT - music.hit + from)}[outro]`,
    );
    labels.push('[outro]');
  }
  if (bed) {
    const k = labels.length + 1;
    const from = Math.max(0, sceneStart - HERO_BED.lead);
    // The app ends where the end card's crossfade does.
    const length = endStart + FADE - from;
    inputs.push('-stream_loop', '-1', '-i', bed.file);
    const spans = bed.spans.map((span) => ({
      from: span.from - from,
      to: span.to - from,
    }));
    parts.push(
      `[${k}:a]${stereo},atrim=0:${length.toFixed(3)},asetpts=PTS-STARTPTS,volume=${bed.gain}dB,` +
        `volume='${duckExpression(spans)}':eval=frame,` +
        `afade=t=in:d=${HERO_BED.fadeIn}:curve=qsin,` +
        `afade=t=out:st=${Math.max(0, length - HERO_BED.fadeOut).toFixed(3)}:d=${HERO_BED.fadeOut},` +
        `${delayed(from)}[bed]`,
    );
    labels.push('[bed]');
  }
  if (!labels.length) return null;
  parts.push(
    `${labels.join('')}amix=inputs=${labels.length}:normalize=0:dropout_transition=0,apad,atrim=0:${total.toFixed(3)}[a]`,
  );
  return { inputs, filter: parts.join(';') };
}

/** The music file from `DEMO_MUSIC`, with where its sting starts and its last hit. */
export function musicFromEnv(env = process.env, seconds = duration) {
  const file = env.DEMO_MUSIC?.trim();
  if (!file) return null;
  if (!existsSync(file)) throw new Error(`DEMO_MUSIC: no file ${file}`);
  const length = seconds(file);
  const number = (name, fallback) => {
    const value = env[name]?.trim();
    if (!value) return fallback;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > length) {
      throw new Error(
        `${name}: seconds into the track, 0 to ${length.toFixed(1)}`,
      );
    }
    return n;
  };
  return {
    file,
    seconds: length,
    stingFrom: number('DEMO_MUSIC_STING_FROM', 0),
    hit: number('DEMO_MUSIC_HIT', Math.max(0, length - 0.5)),
  };
}

/** The frame's two pictures: the background with the window's shadow, and its mask. */
async function frameAssets(browser, dir) {
  const background = join(dir, 'background.png');
  const mask = join(dir, 'mask.png');
  // Made again every time (it is quick), so a change to the look is never missed.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { frame, window: w } = LOOK;
  const page = await browser.newPage({ viewport: frame });
  await page.setContent(`<body style="margin:0;width:${frame.width}px;height:${frame.height}px;overflow:hidden;position:relative;background:${LOOK.background}">
    <div style="position:absolute;left:${w.x}px;top:${w.y}px;width:${w.width}px;height:${w.height}px;border-radius:${w.radius}px;background:#0b0c0e;box-shadow:${LOOK.shadow}"></div>
    ${GRAIN_SVG}</body>`);
  await page.screenshot({ path: background });
  await page.setViewportSize({ width: w.width, height: w.height });
  await page.setContent(
    `<body style="margin:0;background:#000"><div style="width:${w.width}px;height:${w.height}px;border-radius:${w.radius}px;background:#fff"></div></body>`,
  );
  await page.screenshot({ path: mask });
  await page.close();
  return { background, mask };
}

/** Each caption as a transparent frame-sized picture. */
async function captionPictures(browser, cues, dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const page = await browser.newPage({ viewport: LOOK.frame });
  const files = [];
  for (const [k, cue] of cues.entries()) {
    await page.setContent(captionPage(cue.text));
    await page.evaluate(() => document.fonts.ready);
    const file = join(dir, `${String(k).padStart(2, '0')}.png`);
    await page.screenshot({ path: file, omitBackground: true });
    files.push(file);
  }
  await page.close();
  return files;
}

export function parseAssemble(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      lang: { type: 'string' },
      take: { type: 'string' },
      shots: { type: 'string' },
      captions: { type: 'string' },
      voice: { type: 'string' },
      out: { type: 'string' },
    },
  });
  const [video, ...rest] = positionals;
  if (!VIDEOS.includes(video) || rest.length) {
    throw new Error(
      `Usage: node scripts/demo/assemble.mjs <${VIDEOS.join('|')}> --lang en|de`,
    );
  }
  if (!CAPTION_LANGS.includes(values.lang)) {
    throw new Error(`--lang: one of ${CAPTION_LANGS}`);
  }
  const lang = values.lang;
  const takes = join(DEMO_DIR, 'takes');
  return {
    video,
    lang,
    take: values.take ?? join(takes, `${video}-${lang}.webm`),
    shots: values.shots ?? join(takes, `${video}-${lang}.json`),
    // The hero's dark cut has the light one's captions.
    captions:
      values.captions ??
      join(
        import.meta.dirname,
        'captions',
        `${video.replace(/-dark$/, '')}.json`,
      ),
    voice: values.voice ?? voiceDir(video, lang),
    voiceSet: values.voice !== undefined,
    out: values.out ?? join(DEMO_DIR, 'films', `${video}-${lang}.mp4`),
  };
}

/** The silent cut's name beside the voiced one: `<name>-silent.mp4`. */
export const silentName = (out) => out.replace(/(\.mp4)?$/, '-silent.mp4');

async function main() {
  const options = parseAssemble(process.argv.slice(2));
  const { video, lang, take, out } = options;
  const work = join(DEMO_DIR, 'films', 'work');
  mkdirSync(work, { recursive: true, mode: 0o700 });
  const meta = JSON.parse(readFileSync(options.shots, 'utf8'));
  const trim = meta.trim ?? 0;
  const length = sceneLength(duration(take), meta, { loops: !hasCards(video) });

  const browser = await chromium.launch();
  let cues = [];
  let pictures = [];
  let frame;
  try {
    frame = await frameAssets(browser, join(DEMO_DIR, 'films', 'frame'));
    // A tab video always has captions; the hero has them since #804, when its file exists.
    if (!hasCards(video) || existsSync(options.captions)) {
      const captions = checkCaptions(
        JSON.parse(readFileSync(options.captions, 'utf8')),
        options.captions,
      );
      cues = captionCues(meta.shots ?? [], captions, lang, { trim, length });
      pictures = await captionPictures(
        browser,
        cues,
        join(work, `${video}-${lang}-captions`),
      );
    }
  } finally {
    await browser.close();
  }

  // The take in the frame, with its captions; a tab video then looped (from a lossless copy),
  // silent.
  const loops = !hasCards(video);
  const scene = join(work, `${video}-${lang}-scene.mp4`);
  ff([
    ...['-ss', String(trim / 1000), '-i', take],
    // At 30 fps: the background is the overlay's main input, so its rate is the film's.
    ...['-loop', '1', '-framerate', '30', '-i', frame.background],
    ...['-loop', '1', '-framerate', '30', '-i', frame.mask],
    ...captionInputs(cues, pictures),
    '-filter_complex',
    `${frameFilter('[framed]')};${captionFilter(cues, { input: '[framed]', output: '[out]', first: 3 })}`,
    ...['-map', '[out]', '-t', length.toFixed(3)],
    ...(loops ? LOSSLESS : ENCODE),
    ...['-movflags', '+faststart', scene],
  ]);
  const silent = silentName(out);
  if (loops) {
    mkdirSync(join(silent, '..'), { recursive: true, mode: 0o700 });
    ff([
      ...['-i', scene, '-i', scene],
      ...['-filter_complex', loopFilter(length)],
      ...['-map', '[out]', ...ENCODE, '-movflags', '+faststart', silent],
    ]);
    rmSync(scene, { force: true });
    console.log(`${silent} (${duration(silent).toFixed(1)} s, silent)`);

    // The voiced cut: the silent one with the voice-over, once every line has its voice. Never
    // an old one beside a new silent cut.
    const plan = existsSync(narrationFile(video, lang))
      ? narrationPlan(video, lang, { dir: options.voice })
      : undefined;
    if (!plan?.voiced) {
      if (resolve(out).startsWith(`${DEMO_DIR}/`)) rmSync(out, { force: true });
      const missing = plan?.shots
        .filter((shot) => !shot.voice)
        .map((shot) => shot.id);
      console.log(
        `no voiced cut: ${plan ? `no voice for ${missing} in ${options.voice} (node scripts/demo/voice.mjs ${video} --lang ${lang})` : 'no narration'}`,
      );
      return;
    }
    const lines = voiceCues(
      meta.shots ?? [],
      plan.shots.map((shot) => ({
        id: shot.id,
        file: shot.voice,
        seconds: shot.spokenMs / 1000,
      })),
      { trim },
    );
    // The voice at its level: one gain for the whole cut (`VOICE`).
    const measured = voiceLoudness(lines.map((line) => line.file));
    const voice = voiceGain(measured);
    console.log(
      `voice: ${measured.toFixed(1)} LUFS, ${voice >= 0 ? '+' : ''}${voice} dB to ${VOICE.lufs}`,
    );
    // With a bed (`DEMO_BED`): under the voice, ducked while a line is spoken. The film's
    // timeline is the take's less the loop's blend, as `voiceFilter` cuts it.
    const bedFile = bedFromEnv();
    const filmLength = duration(silent);
    const seconds = new Map(
      plan.shots.map((shot) => [shot.id, shot.spokenMs / 1000]),
    );
    const track = bedFile ? duration(bedFile) : 0;
    const bed = bedFile
      ? bedFilter({
          file: bedFile,
          copies: bedCopies(track, filmLength),
          // Measured over what plays: the opening, or the whole track when it loops.
          gain: bedGain(loudness(bedFile, Math.min(track, filmLength))),
          length: filmLength,
          spans: lines.map((line) => ({
            from: line.start - LOOP.blend,
            to: line.start - LOOP.blend + seconds.get(line.shot),
          })),
          first: 1 + lines.length,
        })
      : null;
    ff([
      ...['-i', silent],
      ...lines.flatMap((line) => ['-i', line.file]),
      ...(bed?.inputs ?? []),
      ...[
        '-filter_complex',
        voiceFilter(lines, { first: 1, length, gain: voice }) +
          (bed
            ? `;${bed.filter};[aout][bed]amix=inputs=2:normalize=0:duration=first[mix]`
            : ''),
      ],
      ...['-map', '0:v', '-map', bed ? '[mix]' : '[aout]', '-c:v', 'copy'],
      ...['-c:a', 'aac', '-b:a', '160k', '-shortest'],
      // What the cut holds, for `web.mjs`'s README line.
      ...['-metadata', `comment=${bed ? SOUND_TAG.bed : SOUND_TAG.voice}`],
      ...['-movflags', '+faststart', out],
    ]);
    console.log(
      `${out} (${duration(out).toFixed(1)} s, voiced${bed ? ', with the bed' : ''})`,
    );
    return;
  }

  // The hero: between its cards.
  if (hasCards(video)) {
    const clips = [
      join(DEMO_DIR, 'cards', `intro-${lang}.mp4`),
      scene,
      join(DEMO_DIR, 'cards', `end-${lang}.mp4`),
    ];
    for (const clip of clips) {
      if (!existsSync(clip)) {
        throw new Error(`no ${clip}: node scripts/demo/cards/render.mjs`);
      }
    }
    const lengths = clips.map(duration);
    // The muted cut for autoplay; the cut with sound only when there is a voice or music.
    ff([
      ...clips.flatMap((clip) => ['-i', clip]),
      ...['-filter_complex', joinFilter(lengths)],
      ...['-map', '[out]', ...ENCODE, '-movflags', '+faststart', silent],
    ]);
    rmSync(scene, { force: true });
    const sceneStart = lengths[0] - FADE;
    // The voice is the light cut's (`.demo/voice/hero-<lang>/`): the dark one says the same.
    const plan = narrationPlan('hero', lang, {
      dir: options.voiceSet ? options.voice : voiceDir('hero', lang),
    });
    const voiced = plan.shots.filter((shot) => shot.voice);
    const voices = voiceCues(
      meta.shots ?? [],
      voiced.map((shot) => ({
        id: shot.id,
        file: shot.voice,
        seconds: shot.spokenMs / 1000,
      })),
      { trim, blend: 0 },
    ).map((cue) => ({
      file: cue.file,
      at: sceneStart + cue.start,
      seconds: voiced.find((shot) => shot.id === cue.shot).spokenMs / 1000,
    }));
    const endStart = sceneStart + lengths[1] - FADE;
    // With `DEMO_BED`, the tab videos' bed under the app (#804), measured over what plays.
    const bedFile = bedFromEnv();
    const bed = bedFile
      ? {
          file: bedFile,
          gain: bedGain(
            loudness(
              bedFile,
              Math.min(duration(bedFile), endStart - sceneStart + 2),
            ),
          ),
          spans: voices.map((v) => ({ from: v.at, to: v.at + v.seconds })),
        }
      : null;
    // The voice at the tab videos' level (`VOICE`): one gain for the whole cut.
    const measured = voices.length
      ? voiceLoudness(voices.map((v) => v.file))
      : undefined;
    const level = measured === undefined ? undefined : voiceGain(measured);
    if (level !== undefined) {
      console.log(
        `voice: ${measured.toFixed(1)} LUFS, ${level >= 0 ? '+' : ''}${level} dB to ${VOICE.lufs}`,
      );
    }
    const sound = soundPlan({
      sceneStart,
      endStart,
      total: duration(silent),
      voices,
      music: musicFromEnv(),
      bed,
      voiceGain: level,
    });
    if (resolve(out).startsWith(`${DEMO_DIR}/`)) rmSync(out, { force: true });
    console.log(`${silent} (${duration(silent).toFixed(1)} s, silent)`);
    if (!sound) {
      console.log(
        `no cut with sound: no voice (node scripts/demo/voice.mjs hero --lang ${lang}) and no DEMO_MUSIC`,
      );
      return;
    }
    ff([
      ...['-i', silent, ...sound.inputs],
      ...['-filter_complex', sound.filter, '-map', '0:v', '-map', '[a]'],
      ...['-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k'],
      // What the cut holds, for `web.mjs`'s README line, as a tab video's.
      ...['-metadata', `comment=${bed ? SOUND_TAG.bed : SOUND_TAG.voice}`],
      ...['-movflags', '+faststart', out],
    ]);
    console.log(
      `${out} (${duration(out).toFixed(1)} s, ${voices.length} of ${plan.shots.length} lines, ${process.env.DEMO_MUSIC ? 'music' : 'no music'}${bed ? ', the bed' : ''})`,
    );
    return;
  }
  console.log(
    `${out} (${duration(out).toFixed(1)} s${cues.length ? `, ${cues.length} captions` : ''})`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
