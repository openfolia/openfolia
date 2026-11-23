// The recording side of a tab video (#441, `docs/demo-videos.md`): a take of the running demo,
// in the browser at the recording size, with the kit's visible cursor and click ring, its shots
// timed and written next to it for `assemble.mjs`. A scene (`scenes/<video>.mjs`) drives the
// editor through its shots; this file holds what every scene needs.
//
// A take writes `.demo/takes/<video>-<lang>.webm` and `.demo/takes/<video>-<lang>.json`
// (`{ "trim": <ms>, "shots": [{ "id", "start", "end" }] }`, in milliseconds from the take's
// start): the shape `assemble.mjs` reads.

import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { LOOK } from './look.mjs';
import { DEMO_DIR, STATE_FILE } from './paths.mjs';
import { startUrl } from './demo.mjs';

/**
 * The cursor: a dark dot with a white rim, pressed in on a click, with a grey ring that grows
 * and fades from the click (the kit's overlay). Injected into the page for the take only.
 */
const CURSOR = `(() => {
  if (window.__demoCursor) return;
  window.__demoCursor = true;
  const install = () => {
    if (!document.body) return requestAnimationFrame(install);
    const style = document.createElement('style');
    style.textContent = \`
      #demo-cursor { position: fixed; z-index: 2147483647; width: 18px; height: 18px;
        margin: -9px 0 0 -9px; border-radius: 50%; background: rgba(32, 34, 38, 0.92);
        border: 2px solid rgba(255, 255, 255, 0.95); box-shadow: 0 1px 6px rgba(0,0,0,.45);
        pointer-events: none; left: -50px; top: -50px; transition: transform 80ms ease-out; }
      #demo-cursor.down { transform: scale(0.75); }
      .demo-ring { position: fixed; z-index: 2147483646; width: 44px; height: 44px;
        margin: -22px 0 0 -22px; border-radius: 50%; border: 3px solid rgba(90, 94, 102, 0.9);
        pointer-events: none; animation: demo-ring 450ms ease-out forwards; }
      @keyframes demo-ring { from { transform: scale(0.3); opacity: 1; } to { transform: scale(1.4); opacity: 0; } }
    \`;
    document.documentElement.appendChild(style);
    const cursor = document.createElement('div');
    cursor.id = 'demo-cursor';
    document.documentElement.appendChild(cursor);
    const pos = sessionStorage.getItem('demo-cursor');
    if (pos) { const [x, y] = pos.split(','); cursor.style.left = x + 'px'; cursor.style.top = y + 'px'; }
    addEventListener('mousemove', (e) => {
      cursor.style.left = e.clientX + 'px'; cursor.style.top = e.clientY + 'px';
      try { sessionStorage.setItem('demo-cursor', e.clientX + ',' + e.clientY); } catch {}
    }, true);
    addEventListener('mousedown', (e) => {
      cursor.classList.add('down');
      const ring = document.createElement('div');
      ring.className = 'demo-ring';
      ring.style.left = e.clientX + 'px'; ring.style.top = e.clientY + 'px';
      document.documentElement.appendChild(ring);
      setTimeout(() => ring.remove(), 500);
    }, true);
    addEventListener('mouseup', () => cursor.classList.remove('down'), true);
  };
  install();
})();`;

/** Pacing (`docs/demo-videos.md`, "Pacing"): about 1.2 s on an action's result. */
export const SETTLE_MS = 1_200;
/** Typed text: about 40 ms per character (the look's "Typing"). */
export const TYPE_DELAY = 40;
/** A cursor move's step: about one a frame, fewer when the page is busy. */
const MOVE_STEP_MS = 16;
/** The look's crossfade between clips, in seconds. */
export const FADE = 0.3;
/**
 * What a part of a take keeps before its first shot and after its last when parts are joined
 * (`joinParts`): more than the crossfade, so a fade never covers a shot.
 */
export const PART_LEAD_MS = 350;
export const PART_TAIL_MS = 350;
const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';

/**
 * A clean demo before a take (`demo.mjs reset --lang <lang> --no-build`, plus `args`), so every
 * take starts on the same data.
 */
export function resetDemo(lang, args = []) {
  execFileSync(
    process.execPath,
    [
      join(import.meta.dirname, 'demo.mjs'),
      ...['reset', '--lang', lang, '--no-build', ...args],
    ],
    { stdio: 'inherit' },
  );
}

/** The running demo's state (`.demo/state.json`); refuses one running in another language. */
export function demoState(lang) {
  const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  if (state.options?.lang !== lang) {
    throw new Error(
      `the demo runs in ${state.options?.lang}: reset it with --lang ${lang}`,
    );
  }
  return state;
}

/** One take: a recorded browser context on the running demo, and its shots. */
export class Take {
  #shots = [];
  #t0 = 0;
  #trim = -1;
  #mouse = { x: 0, y: 0 };

  constructor(video, lang, context, page) {
    this.video = video;
    this.lang = lang;
    this.context = context;
    this.page = page;
  }

  /**
   * A new take of `video` in `lang`, opened as `user` on the running demo (`state`): the start
   * address sets the editor's language, person and theme, then the take goes to `path`. With
   * `url` instead, the take opens that page alone (a page that is not the editor's, such as the
   * reader portal the hero films).
   */
  static async start(
    browser,
    { video, lang, user, theme = 'light', state, path, url },
  ) {
    const raw = join(DEMO_DIR, 'takes', 'raw');
    rmSync(raw, { recursive: true, force: true });
    mkdirSync(raw, { recursive: true, mode: 0o700 });
    const context = await browser.newContext({
      viewport: LOOK.recording,
      recordVideo: { dir: raw, size: LOOK.recording },
      deviceScaleFactor: 1,
      colorScheme: theme,
      locale: lang === 'de' ? 'de-DE' : 'en-GB',
      // The cursor is a style and a script the editor's policy does not know: the take only.
      bypassCSP: true,
    });
    await context.addInitScript(CURSOR);
    const page = await context.newPage();
    const take = new Take(video, lang, context, page);
    take.#t0 = Date.now();
    if (url) {
      await page.goto(url);
    } else {
      await page.goto(startUrl(state.editorUrl, { lang, user, theme }));
      await page.waitForURL((at) => !at.pathname.startsWith('/__start'));
      await page.goto(`${state.editorUrl}${path}`);
    }
    await take.settle();
    return take;
  }

  now() {
    return Date.now() - this.#t0;
  }

  pause(ms) {
    return this.page.waitForTimeout(ms);
  }

  /** Waits for the page's skeletons and images, then a moment more. */
  async settle(ms = 1_500) {
    await this.page.waitForLoadState('load').catch(() => undefined);
    await this.page
      .locator('[data-slot="skeleton"], .animate-pulse')
      .first()
      .waitFor({ state: 'detached', timeout: 15_000 })
      .catch(() => undefined);
    await this.page
      .waitForFunction(
        () => [...document.images].every((image) => image.complete),
        undefined,
        { timeout: 15_000 },
      )
      .catch(() => undefined);
    await this.pause(ms);
  }

  /** Puts the cursor at `x`, `y` at once (before the first shot, off camera). */
  async placeCursor(x, y) {
    await this.page.mouse.move(x, y);
    this.#mouse = { x, y };
  }

  /**
   * One shot: `act` runs, then the shot holds until it has lasted `ms` at least. The first shot
   * starts the film: what came before (the page loading) is trimmed.
   */
  async shot(id, ms, act = async () => undefined) {
    if (this.#trim < 0) this.#trim = this.now();
    const start = this.now();
    await act();
    const left = start + ms - this.now();
    if (left > 0) await this.pause(left);
    this.#shots.push({ id, start, end: this.now() });
  }

  /**
   * Moves the cursor onto `target`, eased, as a hand would: to its middle, or to `at` (fractions
   * of its width and height) or `offset` (pixels from its top left corner), so the dot need not
   * sit on the words the viewer reads.
   */
  async point(
    target,
    { duration = 650, at = { x: 0.5, y: 0.5 }, offset } = {},
  ) {
    const box = await target.first().boundingBox({ timeout: 10_000 });
    if (!box) throw new Error(`nothing to point at: ${target}`);
    const to = offset
      ? { x: box.x + offset.x, y: box.y + offset.y }
      : { x: box.x + box.width * at.x, y: box.y + box.height * at.y };
    await this.move(to.x, to.y, { duration });
    await this.pause(200);
  }

  /**
   * Moves the cursor to `x`, `y`, eased, in `duration` ms of the take's time: each step goes where
   * the time says, so a page slow to answer a move (a drag) does not stretch it.
   */
  async move(x, y, { duration = 650 } = {}) {
    const to = { x, y };
    const from = this.#mouse;
    // Driven by the clock, not by a count of steps: each step puts the dot where it belongs at
    // that moment (about one step a frame), so a busy page makes fewer steps, never a longer move.
    const start = Date.now();
    for (;;) {
      const step = Date.now();
      const t = duration > 0 ? Math.min(1, (step - start) / duration) : 1;
      const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
      await this.page.mouse.move(
        from.x + (to.x - from.x) * e,
        from.y + (to.y - from.y) * e,
      );
      if (t >= 1) break;
      const left = MOVE_STEP_MS - (Date.now() - step);
      if (left > 0) await this.pause(left);
    }
    this.#mouse = to;
  }

  /**
   * Clicks `target` with the visible cursor and its ring (where `point` puts it, moving for
   * `duration` ms), then waits `after` ms.
   */
  async click(target, { after = SETTLE_MS, at, offset, duration } = {}) {
    await target.first().waitFor({ state: 'visible', timeout: 10_000 });
    await this.point(target, { at, offset, duration });
    await this.page.mouse.down();
    await this.pause(90);
    await this.page.mouse.up();
    await this.pause(after);
  }

  /** Types `text` at the caret, about 40 ms per character. */
  type(text) {
    return this.page.keyboard.type(text, { delay: TYPE_DELAY });
  }

  /** Fades the cursor out: nothing left to point at. */
  async hideCursor() {
    await this.page.evaluate(() => {
      const cursor = document.getElementById('demo-cursor');
      if (!cursor) return;
      cursor.style.transition = 'opacity 250ms ease-out';
      cursor.style.opacity = '0';
    });
    await this.pause(250);
  }

  /**
   * Fades in a layer of the take's own over the page (`html`, trusted markup the scene builds
   * and escapes): a picture the editor does not show, for the take only. It fades in over any
   * layer already shown, which then goes.
   */
  async showLayer(html, fadeMs = 300) {
    await this.page.evaluate(
      ([markup, ms]) => {
        const layer = document.createElement('div');
        const earlier = [...document.querySelectorAll('.demo-layer')];
        layer.className = 'demo-layer';
        layer.style.cssText = `position:fixed;inset:0;z-index:2147483600;opacity:0;transition:opacity ${ms}ms ease-out`;
        layer.innerHTML = markup;
        document.documentElement.appendChild(layer);
        requestAnimationFrame(() =>
          requestAnimationFrame(() => (layer.style.opacity = '1')),
        );
        setTimeout(() => earlier.forEach((old) => old.remove()), ms + 50);
      },
      [html, fadeMs],
    );
    await this.pause(fadeMs);
  }

  /**
   * Ends the take: closes the browser context and writes the video and its shots, as
   * `.demo/takes/<name>.webm` and `.json` (by default `<video>-<lang>`).
   */
  async finish({ name = `${this.video}-${this.lang}` } = {}) {
    await this.pause(300);
    const video = this.page.video();
    await this.context.close();
    const dir = join(DEMO_DIR, 'takes');
    const file = join(dir, `${name}.webm`);
    renameSync(await video.path(), file);
    writeFileSync(
      join(dir, `${name}.json`),
      `${JSON.stringify({ trim: this.#trim, shots: this.#shots }, null, 2)}\n`,
    );
    return { file, shots: this.#shots, trim: this.#trim };
  }
}

/**
 * A take of several parts (a scene that leaves the camera between them, as the hero does while
 * its release builds) as one: each part cut from `PART_LEAD_MS` before its first shot to
 * `PART_TAIL_MS` after its last, the parts joined with the look's crossfade. `parts` are what
 * `finish` returns. The shots on the joined timeline, in ms.
 */
export function partShots(parts, fade = FADE) {
  const shots = [];
  let offset = 0;
  for (const part of partSpans(parts)) {
    for (const shot of part.shots) {
      shots.push({
        id: shot.id,
        start: Math.round(shot.start - part.from + offset),
        end: Math.round(shot.end - part.from + offset),
      });
    }
    offset += part.to - part.from - fade * 1000;
  }
  const ids = shots.map((shot) => shot.id);
  const twice = ids.find((id, i) => ids.indexOf(id) !== i);
  if (twice) throw new Error(`shot ${twice} is in the take twice`);
  return shots;
}

/** Each part's span in its recording: `from` and `to`, in ms. */
export const partSpans = (parts) =>
  parts.map((part) => {
    if (part.shots.length === 0) throw new Error(`${part.file}: no shots`);
    return {
      ...part,
      from: Math.max(0, part.shots[0].start - PART_LEAD_MS),
      to: part.shots.at(-1).end + PART_TAIL_MS,
    };
  });

/** The ffmpeg filter that cuts each part to its span and joins them with crossfades. */
export function partsFilter(parts, fade = FADE) {
  const spans = partSpans(parts);
  const seconds = (ms) => (ms / 1000).toFixed(3);
  const graph = spans.map(
    (part, i) =>
      `[${i}:v]trim=start=${seconds(part.from)}:end=${seconds(part.to)},setpts=PTS-STARTPTS,fps=30,format=yuv420p[p${i}]`,
  );
  if (spans.length === 1) return graph[0].replace('[p0]', '[out]');
  let previous = '[p0]';
  let offset = 0;
  for (let i = 1; i < spans.length; i++) {
    offset += (spans[i - 1].to - spans[i - 1].from) / 1000 - fade;
    const label = i === spans.length - 1 ? '[out]' : `[j${i}]`;
    graph.push(
      `${previous}[p${i}]xfade=transition=fade:duration=${fade}:offset=${offset.toFixed(3)}${label}`,
    );
    previous = label;
  }
  return graph.join(';');
}

/**
 * Joins the parts into the take `.demo/takes/<name>.webm` (VP9, near lossless: the assembly
 * encodes the master from it) and its shots `<name>.json`, then removes the parts.
 */
export function joinParts(parts, name) {
  const dir = join(DEMO_DIR, 'takes');
  const file = join(dir, `${name}.webm`);
  execFileSync(
    FFMPEG,
    [
      ...['-loglevel', 'error', '-y'],
      ...parts.flatMap((part) => ['-i', part.file]),
      ...['-filter_complex', partsFilter(parts)],
      ...['-map', '[out]', '-an'],
      ...['-c:v', 'libvpx-vp9', '-crf', '12', '-b:v', '0'],
      ...['-row-mt', '1', '-deadline', 'good', '-cpu-used', '4'],
      file,
    ],
    { stdio: 'inherit' },
  );
  const shots = partShots(parts);
  writeFileSync(
    join(dir, `${name}.json`),
    `${JSON.stringify({ trim: 0, shots }, null, 2)}\n`,
  );
  for (const part of parts) {
    rmSync(part.file, { force: true });
    rmSync(part.file.replace(/\.webm$/, '.json'), { force: true });
  }
  return { file, shots };
}
