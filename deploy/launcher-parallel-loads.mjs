// Many loads of one sandbox's editor at once, through the demo's launcher (#870): starts a sandbox
// as the start page does, opens the editor in N tabs of one browser at the same moment, and says
// which rendered the editor, which showed its error state or stayed blank, and every request that
// failed. Ends the sandbox afterwards,
// whatever happened, so it never holds the address's one sandbox for long.
//
//   node deploy/launcher-parallel-loads.mjs https://demo.example.org [N=20]
//
// Uses Playwright's Chromium (`pnpm nx run editor-e2e:browsers` installs it). Exits 1 unless every
// tab rendered the editor. A start counts against the address's daily limit (CCMS_LAUNCHER_PER_ADDRESS_DAILY).
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';

const base = (process.argv[2] ?? '').replace(/\/$/, '');
const tabs = Number(process.argv[3] ?? 20);
if (!/^https?:\/\//.test(base) || !(tabs >= 1 && tabs <= 50)) {
  console.error(
    'usage: node deploy/launcher-parallel-loads.mjs <launcher URL> [tabs, 1 to 50]',
  );
  process.exit(2);
}
const json = {
  'content-type': 'application/json',
  origin: new URL(base).origin,
  'sec-fetch-site': 'same-origin',
};
const zeroBits = (digest) => {
  let n = 0;
  for (const byte of digest) {
    if (byte === 0) {
      n += 8;
      continue;
    }
    return n + Math.clz32(byte) - 24;
  }
  return n;
};

const challenge = await (
  await fetch(`${base}/_demo/api/challenge`, {
    method: 'POST',
    headers: json,
    body: '{}',
  })
).json();
let nonce = 0;
while (
  zeroBits(
    createHash('sha256').update(`${challenge.challenge}:${nonce}`).digest(),
  ) < challenge.bits
)
  nonce++;
const started = await fetch(`${base}/_demo/api/start`, {
  method: 'POST',
  headers: json,
  body: JSON.stringify({
    challenge: challenge.challenge,
    nonce: String(nonce),
    lang: 'en',
  }),
});
const cookie = started.headers.getSetCookie()[0]?.split(';')[0];
if (!cookie) {
  console.error(`start: ${started.status} ${await started.text()}`);
  process.exit(1);
}
console.log(`start: ${started.status}`);
const [name, value] = cookie.split('=');

let missed = 0;
const browser = await chromium.launch();
try {
  const context = await browser.newContext();
  await context.addCookies([
    {
      name,
      value,
      url: `${base}/`,
      secure: true,
      httpOnly: true,
      sameSite: 'Strict',
    },
  ]);
  const failed = [];
  context.on('response', (res) => {
    if (res.status() >= 400)
      failed.push(`${res.status()} ${new URL(res.url()).pathname}`);
  });
  context.on('requestfailed', (req) =>
    failed.push(`failed ${new URL(req.url()).pathname}`),
  );
  const pages = await Promise.all(
    Array.from({ length: tabs }, () => context.newPage()),
  );
  await Promise.all(
    pages.map((page) =>
      page.goto(`${base}/`, { waitUntil: 'load' }).catch(() => undefined),
    ),
  );
  for (const [i, page] of pages.entries()) {
    // The editor's shell, or its error state (#of-boot-error); blank: neither within 15 s.
    const shown = await page
      .locator('of-root main, #of-boot-error:not([hidden])')
      .first()
      .waitFor({ timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    const error = await page.locator('#of-boot-error:not([hidden])').count();
    if (!shown || error) missed++;
    console.log(
      `tab ${i + 1}: ${!shown ? 'BLANK' : error ? 'error state' : 'rendered'}`,
    );
  }
  console.log(`${tabs - missed} of ${tabs} rendered the editor`);
  if (failed.length) console.log(`failed requests:\n  ${failed.join('\n  ')}`);
} finally {
  await browser.close();
  const end = await fetch(`${base}/_demo/api/end`, {
    method: 'POST',
    headers: { ...json, cookie },
    body: '{"lang":"en"}',
  });
  console.log(`end: ${end.status}`);
}
process.exit(missed ? 1 : 0);
