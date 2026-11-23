import { DOCUMENT } from '@angular/common';
import { computed, effect, inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { docsConfig } from '../../docs.config';
import { API_BASE_URL, ApiClient } from '../api';
import {
  brandingCss,
  type BrandingFields,
  type BrandingResource,
  effectiveBranding,
} from './branding-model';

/** The `<style>` element holding the brand's tokens, after the theme's. */
export const BRAND_STYLE_ID = 'of-brand-tokens';

/** One `<link>` in the page's head. */
export interface HeadLink {
  rel: string;
  href: string;
  type?: string;
  sizes?: string;
}

/**
 * The icon and manifest links of a branding: the PNG tab icons first, then the main icon (a
 * browser that picks the last usable icon takes it; one that picks by size may take a PNG, the
 * same artwork), then the home-screen icon and the manifest.
 */
export function brandingLinks(
  branding: ReturnType<typeof effectiveBranding>,
): HeadLink[] {
  const { favicon, faviconPng, appleTouchIcon, manifest } = branding;
  const links: HeadLink[] = [];
  for (const size of [16, 32] as const) {
    const href = faviconPng?.[size];
    if (href) {
      links.push({
        rel: 'icon',
        href,
        type: 'image/png',
        sizes: `${size}x${size}`,
      });
    }
  }
  links.push({
    rel: 'icon',
    href: favicon,
    ...(/\.svg$/i.test(favicon) ? { type: 'image/svg+xml' } : {}),
  });
  if (appleTouchIcon) {
    links.push({
      rel: 'apple-touch-icon',
      href: appleTouchIcon,
      sizes: '180x180',
    });
  }
  if (manifest) links.push({ rel: 'manifest', href: manifest });
  return links;
}

/**
 * The platform's branding (#169): `GET /branding` read at start-up, laid over the defaults of
 * `docs.config.ts` (`branding()`, for the shell, the sign-in page and the title) and applied to
 * the page: the colour tokens as a style sheet over the theme's, the tab and home-screen icons as
 * links in the head. A failed read keeps the defaults. An admin's change is shown at once
 * (`show`), and put back when the API refuses it (`BrandingPage`); everyone else sees it on their
 * next load.
 */
@Injectable({ providedIn: 'root' })
export class BrandingService {
  private readonly api = inject(ApiClient);
  private readonly base = inject(API_BASE_URL);
  private readonly document = inject(DOCUMENT);
  private readonly current = signal<BrandingResource | null>(null);

  /** The API's branding, null until it answered (or when it could not). */
  readonly resource = this.current.asReadonly();

  /** What the shell shows. */
  readonly branding = computed(() =>
    effectiveBranding(
      docsConfig.branding,
      this.current()?.attributes ?? null,
      this.base,
    ),
  );

  /** The product's name without a branding: the config's. */
  readonly defaultProductName = docsConfig.branding.productName;

  /** The product's name, for the document title. */
  readonly productName = computed(() => this.branding().productName);

  constructor() {
    effect(() => this.applyTokens(this.current()));
    effect(() => this.applyLinks(this.branding()));
  }

  /** Reads `GET /branding`; resolves either way (a failure keeps the defaults). */
  async load(): Promise<void> {
    try {
      const document = await firstValueFrom(this.api.get('/branding'));
      this.current.set(document.data);
    } catch {
      // The defaults stay; the next load tries again.
    }
  }

  /** Shows `branding` at once: what the API answered, or an admin's change before it does. */
  show(branding: BrandingResource): void {
    this.current.set(branding);
  }

  /**
   * Shows the fields of `changes` laid over the current branding, before the API answers;
   * the colour tokens stay those last answered, as only the API derives them.
   */
  preview(changes: Partial<BrandingFields>): void {
    const now = this.current();
    if (!now) return;
    this.current.set({ ...now, attributes: { ...now.attributes, ...changes } });
  }

  /**
   * A theme token's colour on the page now, as `#rrggbb` (drawn on a canvas, which turns any CSS
   * colour into pixels); empty where it cannot be read (no canvas).
   */
  tokenNow(token: 'primary' | 'sidebar'): string {
    try {
      const value = getComputedStyle(this.document.documentElement)
        .getPropertyValue(`--${token}`)
        .trim();
      const canvas = this.document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d');
      if (!value || !context) return '';
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const [r = 0, g = 0, b = 0] = context.getImageData(0, 0, 1, 1).data;
      return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    } catch {
      return '';
    }
  }

  private applyTokens(branding: BrandingResource | null): void {
    const css = brandingCss(branding?.meta.tokens ?? null);
    let style = this.document.getElementById(BRAND_STYLE_ID);
    if (!css) {
      style?.remove();
      return;
    }
    if (!style) {
      style = this.document.createElement('style');
      style.id = BRAND_STYLE_ID;
    }
    // Always last in the head, after the theme's style sheet.
    this.document.head.appendChild(style);
    style.textContent = css;
  }

  private applyLinks(branding: ReturnType<typeof effectiveBranding>): void {
    const head = this.document.head;
    for (const old of Array.from(
      head.querySelectorAll('link[data-of-brand]'),
    )) {
      old.remove();
    }
    for (const { rel, href, type, sizes } of brandingLinks(branding)) {
      const link = this.document.createElement('link');
      link.rel = rel;
      link.href = href;
      link.setAttribute('data-of-brand', '');
      if (type) link.type = type;
      if (sizes) link.setAttribute('sizes', sizes);
      head.appendChild(link);
    }
  }
}
