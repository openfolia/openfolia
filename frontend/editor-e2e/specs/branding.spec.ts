import { crc32, deflateSync } from 'node:zlib';

import type { Page } from '@playwright/test';

import { type Api, unique } from '../src/api.ts';
import { expect, signIn, test, USERS } from '../src/fixtures.ts';

/** A PNG of `width` × `height` in one colour, made here (no image tool in the suite). */
function png(
  width: number,
  height: number,
  rgb: [number, number, number],
): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(Array(width).fill(rgb).flat()),
  ]);
  const pixels = deflateSync(Buffer.concat(Array(height).fill(row)));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', pixels),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** `still` with an animation control chunk after its header: an animated PNG (APNG). */
function animated(still: Buffer): Buffer {
  const control = Buffer.alloc(20);
  control.writeUInt32BE(8, 0);
  control.write('acTL', 4, 'latin1');
  control.writeUInt32BE(2, 8); // two frames
  control.writeUInt32BE(crc32(control.subarray(4, 16)), 16);
  // After the signature (8 bytes) and the IHDR chunk (25 bytes).
  return Buffer.concat([still.subarray(0, 33), control, still.subarray(33)]);
}

const RESET = {
  productName: null,
  logoLight: null,
  logoDark: null,
  mark: null,
  favicon: null,
  appIcon: null,
  primary: null,
  accent: null,
};

/** The branding back to the defaults: it is the whole installation's, shared by every flow. */
async function reset(admin: Api): Promise<void> {
  await admin.json(
    admin.send('PATCH', '/branding', {
      data: { type: 'Branding', id: 'branding', attributes: RESET },
    }),
  );
}

const patched = (page: Page) =>
  page.waitForResponse(
    (r) =>
      r.request().method() === 'PATCH' && r.url().endsWith('/api/branding'),
  );

const tokenOf = (page: Page, token: string) =>
  page.evaluate(
    (name) =>
      getComputedStyle(document.documentElement).getPropertyValue(name).trim(),
    token,
  );

// Admin → Branding (`/admin/branding`, #169): the product name, the logos and icons and the
// colours, applied to the whole editor at once and kept for the next load. The branding is one
// for the installation, so the flows run one after the other and put the defaults back.
test.describe('branding @area:admin @area:shell @api:branding @api:blobs', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ consoleAllow: [/status of 422/] });

  test.afterEach(async ({ api }) => {
    await reset(await api(USERS.admin));
  });

  test('names the product, uploads a favicon, sets the primary colour, keeps them on reload and resets them', async ({
    page,
  }) => {
    const name = unique('E2E Docs');
    await signIn(page, USERS.admin);
    await page.goto('/admin/branding');
    const field = page.getByRole('textbox', { name: 'Name', exact: true });
    await expect(field).toHaveAttribute('placeholder', 'OpenFolia');
    const defaultPrimary = await tokenOf(page, '--primary');

    // The name: shown at once, in the title too.
    const named = patched(page);
    await field.fill(name);
    await field.press('Enter');
    expect((await named).status()).toBe(200);
    await expect(page).toHaveTitle(new RegExp(`· ${name}$`));

    // A square favicon: uploaded, named, linked in the head.
    const favicon = page.locator('li[data-field="favicon"]');
    const uploaded = page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' &&
        r.url().endsWith('/api/branding/images'),
    );
    const linked = patched(page);
    await favicon.locator('input[type="file"]').setInputFiles({
      name: 'icon.png',
      mimeType: 'image/png',
      buffer: png(64, 64, [29, 78, 216]),
    });
    // 200 when a retry uploads the same bytes again.
    expect([200, 201]).toContain((await uploaded).status());
    expect((await linked).status()).toBe(200);
    await expect(favicon.locator('img')).toHaveAttribute(
      'src',
      /\/api\/branding\/images\/[0-9a-f]{64}$/,
    );
    await expect(
      page.locator('head link[rel="icon"][href*="/api/branding/images/"]'),
    ).toHaveCount(1);
    // Served to anyone, as an image.
    const href = await page
      .locator('head link[rel="icon"][href*="/api/branding/images/"]')
      .getAttribute('href');
    const served = await page.request.get(href ?? '');
    expect(served.status()).toBe(200);
    expect(served.headers()['content-type']).toBe('image/png');
    expect(served.headers()['x-content-type-options']).toBe('nosniff');

    // The primary colour: the whole page takes it, with its contrast shown.
    const primary = page.getByRole('textbox', {
      name: 'Primary colour',
      exact: true,
    });
    const coloured = patched(page);
    await primary.fill('#1d4ed8');
    await primary.press('Enter');
    expect((await coloured).status()).toBe(200);
    await expect.poll(() => tokenOf(page, '--primary')).toBe('#1d4ed8');
    await expect(page.locator('[data-field="primary"]')).toContainText(
      'Primary colour on the page',
    );

    // The next load (everyone else's) shows the same.
    await page.reload();
    await expect(
      page.getByRole('textbox', { name: 'Name', exact: true }),
    ).toHaveValue(name);
    await expect(page).toHaveTitle(new RegExp(`· ${name}$`));
    await expect.poll(() => tokenOf(page, '--primary')).toBe('#1d4ed8');

    // Reset to default, after asking.
    await page.getByRole('button', { name: 'Reset to default' }).click();
    const resetting = patched(page);
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Reset' })
      .click();
    expect((await resetting).status()).toBe(200);
    await expect(
      page.getByRole('textbox', { name: 'Name', exact: true }),
    ).toHaveValue('');
    await expect.poll(() => tokenOf(page, '--primary')).toBe(defaultPrimary);
    await expect(page).toHaveTitle(/· OpenFolia$/);
  });

  test('refuses a colour with too little contrast, a favicon that is not square and an animated image, keeping what was saved', async ({
    page,
  }) => {
    await signIn(page, USERS.admin);
    await page.goto('/admin/branding');
    const primary = page.getByRole('textbox', {
      name: 'Primary colour',
      exact: true,
    });
    const refused = patched(page);
    await primary.fill('#ffff00');
    await primary.press('Enter');
    expect((await refused).status()).toBe(422);
    const row = page.locator('[data-field="primary"]');
    await expect(row.getByRole('alert')).toContainText(
      'Too little contrast on light pages',
    );
    await expect(primary).toHaveValue('');

    const favicon = page.locator('li[data-field="favicon"]');
    await favicon.locator('input[type="file"]').setInputFiles({
      name: 'wide.png',
      mimeType: 'image/png',
      buffer: png(64, 32, [0, 0, 0]),
    });
    await expect(favicon.getByRole('alert')).toContainText('must be square');

    // An animated PNG: refused, whatever the slot (#559).
    const mark = page.locator('li[data-field="mark"]');
    await mark.locator('input[type="file"]').setInputFiles({
      name: 'moving.png',
      mimeType: 'image/png',
      buffer: animated(png(16, 16, [29, 78, 216])),
    });
    await expect(mark.getByRole('alert')).toContainText('one still picture');
    await expect(
      page.locator('head link[rel="icon"][href*="/api/branding/images/"]'),
    ).toHaveCount(0);
  });

  test('is not offered to someone without admin.branding', async ({ page }) => {
    await signIn(page, USERS.author);
    await page.goto('/admin/branding');
    await expect(page.getByTestId('no-access-page')).toBeVisible();
    await expect(
      page.getByRole('textbox', { name: 'Primary colour', exact: true }),
    ).toHaveCount(0);
  });
});
