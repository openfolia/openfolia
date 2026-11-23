// One still frame per language from the running demo, in the films' frame (#441,
// `docs/demo-videos.md`): the editor at the recording size (1728×972), scaled into the rounded
// window on the graphite background, 1920×1080. For approving the look before anything is filmed.
//
//   pnpm demo:stills [--lang en] [--lang de] [--screen /review] [--user reviewer] [--theme light]
//                    [--caption "A tab video's caption, to see it in the frame"]
//
// A language the running demo was not started in is started afresh (`demo.mjs reset`), so the
// texts the demo wrote through the API are in the still's language too. Writes
// `.demo/stills/<screen>-<lang>[-dark][-caption].png`.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DEMO_DIR, STATE_FILE } from './paths.mjs';
import { CAPTION, framePage, LOOK } from './look.mjs';
import { DEMO_PEOPLE } from './people.mjs';
import { chromium } from './playwright.mjs';
import { startUrl } from './demo.mjs';

export { framePage, LOOK } from './look.mjs';

const readState = () => JSON.parse(readFileSync(STATE_FILE, 'utf8'));

async function main() {
  const { values } = parseArgs({
    options: {
      lang: { type: 'string', multiple: true },
      screen: { type: 'string' },
      user: { type: 'string' },
      theme: { type: 'string' },
      caption: { type: 'string' },
    },
  });
  const langs = values.lang ?? ['en', 'de'];
  const screen = values.screen ?? '/review';
  if (!/^\/[a-z0-9/-]*$/.test(screen))
    throw new Error('--screen: a path like /review');
  const user = values.user ?? 'reviewer';
  if (!Object.hasOwn(DEMO_PEOPLE, user)) {
    throw new Error(`--user: one of ${Object.keys(DEMO_PEOPLE)}`);
  }
  const theme = values.theme ?? 'light';
  if (!['light', 'dark'].includes(theme))
    throw new Error('--theme: light or dark');
  const caption = values.caption;
  if (caption !== undefined && caption.length > CAPTION.maxLength)
    throw new Error(`--caption: at most ${CAPTION.maxLength} characters`);
  const out = join(DEMO_DIR, 'stills');
  mkdirSync(out, { recursive: true, mode: 0o700 });

  const browser = await chromium.launch();
  try {
    for (const lang of langs) {
      let state;
      try {
        state = readState();
      } catch {
        state = undefined;
      }
      if (state?.options?.lang !== lang) {
        execFileSync(
          process.execPath,
          [
            join(import.meta.dirname, 'demo.mjs'),
            'reset',
            '--lang',
            lang,
            '--no-build',
          ],
          { stdio: 'inherit' },
        );
        state = readState();
      }
      const app = await browser.newPage({ viewport: LOOK.recording });
      await app.goto(startUrl(state.editorUrl, { lang, user, theme }));
      await app.waitForURL((url) => !url.pathname.startsWith('/__start'));
      await app.goto(`${state.editorUrl}${screen}`);
      await app.waitForLoadState('load');
      // Lists and images load after the page: wait for skeletons to go, then a moment more. One
      // still there after 15 s is in the still, for the person to see.
      const skeletons = app.locator('[data-slot="skeleton"], .animate-pulse');
      await skeletons
        .first()
        .waitFor({ state: 'detached', timeout: 15_000 })
        .catch(() => console.warn(`${lang}: the screen is still loading`));
      await app
        .waitForFunction(
          () => [...document.images].every((image) => image.complete),
          undefined,
          { timeout: 15_000 },
        )
        .catch(() => console.warn(`${lang}: an image is still loading`));
      await app.waitForTimeout(1_500);
      const shot = (await app.screenshot()).toString('base64');
      await app.close();

      const frame = await browser.newPage({ viewport: LOOK.frame });
      await frame.setContent(framePage(shot, caption));
      await frame.evaluate(() => document.fonts.ready);
      const name = `${screen.slice(1).replaceAll('/', '-') || 'start'}-${lang}${theme === 'dark' ? '-dark' : ''}${caption === undefined ? '' : '-caption'}.png`;
      await frame.screenshot({ path: join(out, name) });
      await frame.close();
      console.log(join(out, name));
    }
  } finally {
    await browser.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
