// The voice-over of a tab video through ElevenLabs (#441, "Sound"): one mp3 per shot from the
// video's narration (`narration.mjs`), into `.demo/voice/<video>-<lang>/<shot>.mp3`. Each line is
// read knowing the lines around it (`previous_text`, `next_text`), so the video sounds like one
// read while each shot keeps its own file and can be made again alone.
//
// Run by the owner, in their own terminal: the key is read from ELEVENLABS_API_KEY or asked for
// without echo, and never written or printed.
//
//   node scripts/demo/voice.mjs review --lang en --dry-run     the lines and characters, no key
//   DEMO_VOICE_EN=<voice id> node scripts/demo/voice.mjs review --lang en
//   DEMO_VOICE_DE=<voice id> node scripts/demo/voice.mjs review --lang de [--shot 02a]
//
// The voice per language: DEMO_VOICE_EN / DEMO_VOICE_DE (a voice ID of the account's voices).
// ELEVENLABS_API_BASE is for a local test against a stub. Then film the take again (its shots
// last as long as their lines) and assemble it: the voiced and the silent cut.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { CAPTION_LANGS } from './captions.mjs';
import { readNarration, voiceDir, withPauses } from './narration.mjs';

const MODEL = 'eleven_multilingual_v2';
/** The same seed and settings for every line: no drift in tone between takes. */
const SEED = 4711;
const VOICE_SETTINGS = {
  stability: 0.55,
  similarity_boost: 0.75,
  style: 0,
  use_speaker_boost: true,
};

/**
 * The requests to make: each shot's line, with a pause between its sentences (`withPauses`), and
 * its neighbours as written, for `previous_text`/`next_text`.
 */
export function voiceRequests(shots, only = []) {
  return shots
    .map((shot, i) => ({
      id: shot.id,
      text: withPauses(shot.text),
      previous: shots[i - 1]?.text,
      next: shots[i + 1]?.text,
    }))
    .filter((request) => only.length === 0 || only.includes(request.id));
}

/** The key, asked for on the terminal without echo. */
function askKey() {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) {
      reject(
        new Error(
          'ELEVENLABS_API_KEY is not set, and there is no terminal to ask',
        ),
      );
      return;
    }
    stdout.write('ElevenLabs API key (not shown): ');
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let key = '';
    const onData = (chunk) => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          stdout.write('\n');
          resolve(key.trim());
          return;
        }
        if (c === '\u0003') {
          stdin.setRawMode(false);
          stdout.write('\n');
          process.exit(130);
        }
        if (c === '\u007f') key = key.slice(0, -1);
        else key += c;
      }
    };
    stdin.on('data', onData);
  });
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      lang: { type: 'string' },
      shot: { type: 'string', multiple: true },
      'dry-run': { type: 'boolean' },
    },
  });
  const [video, ...rest] = positionals;
  if (!video || rest.length || !/^[a-z-]+$/.test(video)) {
    throw new Error(
      'Usage: node scripts/demo/voice.mjs <video> --lang en|de [--shot 01a] [--dry-run]',
    );
  }
  const lang = values.lang;
  if (!CAPTION_LANGS.includes(lang))
    throw new Error(`--lang: one of ${CAPTION_LANGS}`);
  const shots = readNarration(video, lang);
  const only = values.shot ?? [];
  const unknown = only.filter((id) => !shots.some((shot) => shot.id === id));
  if (unknown.length) throw new Error(`--shot: no line for ${unknown}`);
  const requests = voiceRequests(shots, only);
  for (const { id, text } of requests)
    console.log(`${id}: ${text.length} characters`);
  console.log(
    `total: ${requests.reduce((sum, r) => sum + r.text.length, 0)} characters, ${requests.length} line(s)`,
  );
  if (values['dry-run']) return;

  const voiceId = process.env[`DEMO_VOICE_${lang.toUpperCase()}`]?.trim();
  if (!voiceId) {
    throw new Error(
      `DEMO_VOICE_${lang.toUpperCase()}: the ID of a ${lang} voice of the account`,
    );
  }
  const key = process.env.ELEVENLABS_API_KEY?.trim() || (await askKey());
  // Printable characters only: a stray control character would make the request fail with an
  // error that quotes the header, and so the key.
  if (!/^[\x21-\x7e]+$/.test(key)) throw new Error('not a key');
  const base = (
    process.env.ELEVENLABS_API_BASE ?? 'https://api.elevenlabs.io'
  ).replace(/\/$/, '');
  const dir = voiceDir(video, lang);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const { id, text, previous, next } of requests) {
    let response;
    try {
      response = await fetch(
        `${base}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
        {
          method: 'POST',
          headers: { 'xi-api-key': key, 'content-type': 'application/json' },
          body: JSON.stringify({
            text,
            model_id: MODEL,
            seed: SEED,
            voice_settings: VOICE_SETTINGS,
            ...(previous && { previous_text: previous }),
            ...(next && { next_text: next }),
          }),
        },
      );
    } catch {
      // Never the error itself: it could quote the request's headers.
      throw new Error(`${id}: the request failed`);
    }
    // The status only: an error body could echo the request.
    if (!response.ok) throw new Error(`${id}: HTTP ${response.status}`);
    const file = join(dir, `${id}.mp3`);
    writeFileSync(file, Buffer.from(await response.arrayBuffer()));
    console.log(`wrote ${file}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
