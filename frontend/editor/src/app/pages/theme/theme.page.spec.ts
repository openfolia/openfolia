import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { docsConfig } from '../../../docs.config';
import { TOKEN_GROUPS } from './theme-tokens';
import { ThemePage } from './theme.page';

describe('ThemePage (screen 0)', () => {
  async function render() {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const fixture = TestBed.createComponent(ThemePage);
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }

  it('lists every token in a light and a dark panel', async () => {
    const el = await render();
    const names = TOKEN_GROUPS.flatMap((g) => g.tokens);
    for (const mode of ['light', 'dark']) {
      const panel = el.querySelector(`[data-mode="${mode}"]`)!;
      const shown = [...panel.querySelectorAll('li code')].map(
        (c) => c.textContent,
      );
      expect(shown).toEqual(names);
    }
    expect(
      el.querySelector('[data-mode="dark"]')!.classList.contains('dark'),
    ).toBe(true);
    expect(
      el.querySelector('[data-mode="light"]')!.classList.contains('dark'),
    ).toBe(false);
  });

  it('shows both logo slots, with the product name', async () => {
    const el = await render();
    const imgs = [...el.querySelectorAll('of-logo img')].map((i) =>
      i.getAttribute('src'),
    );
    const { small, smallDark, full, fullDark } = docsConfig.branding.logo;
    // Each slot: the light image, then its dark one where configured.
    expect(imgs).toEqual(
      [small, smallDark, full ?? small, full ? fullDark : smallDark].filter(
        Boolean,
      ),
    );
    expect(el.textContent).toContain(docsConfig.branding.productName);
  });

  it('shows only tokens that exist in its swatch grid', async () => {
    const el = await render();
    const names = new Set(TOKEN_GROUPS.flatMap((g) => g.tokens));
    const swatches = [
      ...el.querySelectorAll('[aria-labelledby="theme-colours"] li code'),
    ].map((c) => c.textContent?.trim() ?? '');
    expect(swatches.length).toBe(16);
    for (const token of swatches) expect(names.has(token)).toBe(true);
  });

  it('names every status in words, not by colour alone', async () => {
    const el = await render();
    const text = el.querySelector(
      '[aria-label="Status samples"]',
    )!.textContent!;
    for (const word of ['Success', 'Warning', 'Info', 'Error'])
      expect(text).toContain(word);
  });
});
