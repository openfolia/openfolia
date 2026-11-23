// The landing page's files of a video (`docs/demo-videos.md`, "The files and where they go"),
// encoded from its masters in `.demo/films/` into `.demo/out/`: the silent cut as MP4 and WebM,
// the voiced cut too once it exists, and the poster; then a line per file in `.demo/out/README.md`
// (the video, the language, the length and the commit it was filmed on).
//
//   node scripts/demo/web.mjs <video> --lang en|de [--out <dir>]
//
// The hero's poster is its intro card's line (`HERO_POSTER_AT`), not its opening frame.

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { hasCards, SOUND_TAG, VIDEOS } from './assemble.mjs';
import { CAPTION_LANGS } from './captions.mjs';
import { STILL_TIMES } from './cards/cards.mjs';
import { DEMO_DIR, ROOT } from './paths.mjs';

const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';
const FFPROBE = process.env.FFPROBE ?? 'ffprobe';

/** The hero's poster: the intro card's line, whole, before the card fades into the app. */
export const HERO_POSTER_AT = STILL_TIMES.intro.end;

/** Width and the most an MP4 may weigh (bytes), per video. */
export const TARGETS = {
  // About 1:46 since #804 (it was about 30 s): the budget grew with the length.
  hero: { width: 1600, mp4: 8e6 },
  'hero-dark': { width: 1600, mp4: 8e6 },
  tab: { width: 1280, mp4: 1.5e6 },
  poster: 150e3,
};
export const target = (video) => TARGETS[video] ?? TARGETS.tab;

/**
 * The WebM's quality steps: `crf 38` first; on a screen recording mostly at rest, H.264 can come
 * out smaller, so the next step is tried until the WebM is at most the MP4's size.
 */
export const WEBM_CRF = [38, 42, 46, 50];

/** The encodes of one master: H.264 and VP9, its sound (voice, and a bed or music) as AAC and Opus. */
export function webArgs(master, { width, voiced, crf = WEBM_CRF[0] }) {
  const scale = ['-vf', `scale=${width}:-2:flags=lanczos`];
  const audio = (codec) => (voiced ? ['-c:a', ...codec] : ['-an']);
  return {
    mp4: [
      ...['-i', master, ...scale],
      ...[
        '-c:v',
        'libx264',
        '-preset',
        'slow',
        '-crf',
        '28',
        '-pix_fmt',
        'yuv420p',
      ],
      ...audio(['aac', '-b:a', '96k']),
      ...['-movflags', '+faststart'],
    ],
    webm: [
      ...['-i', master, ...scale],
      ...[
        '-c:v',
        'libvpx-vp9',
        '-crf',
        String(crf),
        '-b:v',
        '0',
        '-row-mt',
        '1',
      ],
      ...audio(['libopus', '-b:a', '64k']),
    ],
  };
}

/** What a cut has: captions always (the hero's since #804), and the hero's music with its voice. */
export function cutKind(video, voiced, comment = '') {
  if (hasCards(video)) {
    if (!voiced) return 'captions, no sound';
    return comment === SOUND_TAG.bed
      ? 'voice, music, bed and captions'
      : 'voice, music and captions';
  }
  if (!voiced) return 'captions, no sound';
  return comment === SOUND_TAG.bed
    ? 'voice, music bed and captions'
    : 'voice and captions';
}

/** A master's metadata comment: what `assemble.mjs` says its sound holds. */
const commentOf = (file) =>
  execFileSync(
    FFPROBE,
    [
      '-v',
      'error',
      '-show_entries',
      'format_tags=comment',
      '-of',
      'csv=p=0',
      file,
    ],
    { encoding: 'utf8' },
  ).trim();

/** The README's line for a file: replaces the file's line, keeps the others, sorted. */
export function readmeLines(existing, line) {
  const name = line.split(' ')[1];
  const lines = existing
    .split('\n')
    .filter((l) => l.startsWith('- ') && l.split(' ')[1] !== name);
  return [...lines, line].sort();
}

const seconds = (file) =>
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
const ff = (args) =>
  execFileSync(FFMPEG, ['-loglevel', 'error', '-y', ...args], {
    stdio: 'inherit',
  });

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { lang: { type: 'string' }, out: { type: 'string' } },
  });
  const [video, ...rest] = positionals;
  if (!VIDEOS.includes(video) || rest.length) {
    throw new Error(
      `Usage: node scripts/demo/web.mjs <${VIDEOS.join('|')}> --lang en|de`,
    );
  }
  const lang = values.lang;
  if (!CAPTION_LANGS.includes(lang))
    throw new Error(`--lang: one of ${CAPTION_LANGS}`);
  const films = join(DEMO_DIR, 'films');
  const out = values.out ? resolve(values.out) : join(DEMO_DIR, 'out');
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const commit = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();
  const { width, mp4: mp4Limit } = target(video);

  const cuts = [
    { name: `${video}-${lang}-silent`, voiced: false },
    // Beside the silent cut, the cut with sound (voice, and the hero's music), once it exists.
    { name: `${video}-${lang}`, voiced: true },
  ].filter((cut) => existsSync(join(films, `${cut.name}.mp4`)));
  if (cuts.length === 0)
    throw new Error(`no master in ${films}: assemble.mjs first`);

  const readme = join(out, 'README.md');
  let text = existsSync(readme) ? readFileSync(readme, 'utf8') : '';
  const note = (file, what) => {
    const line = `- ${basename(file)}: ${video}, ${lang}, ${what}, ${(statSync(file).size / 1e6).toFixed(2)} MB, filmed on ${commit}`;
    text = readmeLines(text, line).join('\n');
    console.log(line.slice(2));
  };
  for (const cut of cuts) {
    const master = join(films, `${cut.name}.mp4`);
    const length = `${seconds(master).toFixed(1)} s`;
    const mp4 = join(out, `${cut.name}.mp4`);
    const webm = join(out, `${cut.name}.webm`);
    ff([...webArgs(master, { width, voiced: cut.voiced }).mp4, mp4]);
    for (const crf of WEBM_CRF) {
      ff([...webArgs(master, { width, voiced: cut.voiced, crf }).webm, webm]);
      if (statSync(webm).size <= statSync(mp4).size) break;
    }
    for (const file of [mp4, webm]) {
      note(file, `${length}, ${cutKind(video, cut.voiced, commentOf(master))}`);
    }
    if (statSync(mp4).size > mp4Limit)
      console.warn(`${mp4}: over ${mp4Limit / 1e6} MB`);
    if (statSync(webm).size > statSync(mp4).size)
      console.warn(`${webm}: larger than the MP4`);
  }

  // The poster: the frame a tab video opens on; the hero's intro line.
  const poster = join(out, `${video}-${lang}.jpg`);
  const at = hasCards(video) ? ['-ss', String(HERO_POSTER_AT)] : [];
  ff([
    ...[...at, '-i', join(films, `${cuts[0].name}.mp4`), '-frames:v', '1'],
    ...['-vf', 'scale=1600:900:flags=lanczos', '-q:v', '3', poster],
  ]);
  if (statSync(poster).size > TARGETS.poster)
    console.warn(`${poster}: over 150 KB`);
  note(
    poster,
    hasCards(video)
      ? `poster, the intro's line (${HERO_POSTER_AT} s)`
      : 'poster, the opening frame',
  );
  writeFileSync(
    readme,
    `# Landing page videos\n\nOne line per file: the video, the language, what it is, its size and the commit it was filmed on.\n\n${text}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
