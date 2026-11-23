import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { escapeHtml } from '@openfolia/render-html';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { Env } from '../../config/env.js';
import type { Preview } from '../core/actions/preview-manual.action.js';

/**
 * `auto` follows the viewer's `prefers-color-scheme` (a stylesheet linked
 * with a media query, so no script); `light` and `dark` force one, for a
 * host that has its own switch (the editor).
 */
export const PreviewTheme = z
  .enum(['auto', 'light', 'dark'])
  .describe(
    'Colour scheme. `auto` (default) follows the viewer’s `prefers-color-scheme`; `light` and `dark` force one.',
  );
export type PreviewTheme = z.infer<typeof PreviewTheme>;

/**
 * No script of any kind, nothing from another origin. Styles come from this
 * origin only (the linked stylesheets); the one inline style the renderer
 * writes is a `style` attribute holding a width (`width:NN%` on images and
 * table columns), so `style-src-attr 'unsafe-inline'` allows attributes and
 * nothing else: no `<style>` element, no `style-src 'unsafe-inline'`.
 * Images and fonts are this origin's (`/assets/:sha256`, the theme's fonts).
 * `frame-ancestors` lets the editor embed the page: this origin and the
 * configured `CCMS_EDITOR_ORIGINS` (`X-Frame-Options` is not sent: it
 * cannot name an allow-list).
 */
export function contentSecurityPolicy(editorOrigins: readonly string[]) {
  return [
    "default-src 'none'",
    "script-src 'none'",
    "object-src 'none'",
    "style-src 'self'",
    "style-src-attr 'unsafe-inline'",
    "img-src 'self'",
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors 'self' ${editorOrigins.join(' ')}`.trim(),
  ].join('; ');
}

/**
 * Where the page's links lead, relative to the page's own URL, so they
 * resolve wherever the API is mounted (behind a proxy's `/api`, say) and the
 * stylesheets, fonts and images come from the origin that served the page.
 */
export function relativeRoot(path: string): string {
  const segments = path.split('/').filter((s) => s.length > 0);
  const up = path.endsWith('/') ? segments.length : segments.length - 1;
  return '../'.repeat(Math.max(up, 0));
}

/**
 * `assetUrl` for the renderer: `GET /assets/:sha256`, at the same `?ref=` as
 * the page. A page of a change set's working copies (#237) links an image
 * uploaded into the change set to `GET /change-sets/:id/assets/:sha256`
 * (its author's to see, as the page is), any other image as a branch's.
 */
export function assetUrlFor(
  path: string,
  ref: string | undefined,
  workingCopies?: {
    readonly changeSetId: string;
    readonly uploaded: ReadonlySet<string>;
  },
): (sha256: string) => string {
  const root = relativeRoot(path);
  const query = ref === undefined ? '' : `?ref=${encodeURIComponent(ref)}`;
  return (sha256) =>
    workingCopies?.uploaded.has(sha256)
      ? `${root}change-sets/${encodeURIComponent(workingCopies.changeSetId)}/assets/${sha256}`
      : `${root}assets/${sha256}${query}`;
}

/**
 * The URL a preview names a safety symbol's artwork by: `GET /symbols/:id`,
 * at the same `?ref=` as the page (a change set's branch included: symbols
 * have no working copies, so the branch's are the ones shown).
 */
export function symbolUrlFor(
  path: string,
  ref: string | undefined,
): (id: string) => string {
  const root = relativeRoot(path);
  const query = ref === undefined ? '' : `?ref=${encodeURIComponent(ref)}`;
  return (id) => `${root}symbols/${encodeURIComponent(id)}${query}`;
}

export function pageHtml(
  preview: Preview,
  theme: PreviewTheme,
  root: string,
  /** Where the stylesheets are (and the fonts, under `fonts/`); default `<root>preview/`. */
  files = `${root}preview/`,
): string {
  const css = (name: string, media?: string) =>
    `<link rel="stylesheet" href="${files}${name}"${media ? ` media="${media}"` : ''}>`;
  const scheme = theme === 'auto' ? 'light dark' : theme;
  return [
    '<!doctype html>',
    `<html lang="${escapeHtml(preview.lang)}" dir="${preview.dir === 'rtl' ? 'rtl' : 'ltr'}"${theme === 'dark' ? ' class="dark"' : ''}>`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta name="color-scheme" content="${scheme}">`,
    '<meta name="referrer" content="no-referrer">',
    `<title>${escapeHtml(preview.title)}</title>`,
    css('theme.css'),
    theme === 'auto'
      ? css('theme-dark.css', '(prefers-color-scheme: dark)')
      : '',
    css('render-html.css'),
    css('page.css'),
    '</head>',
    '<body>',
    preview.html,
    '</body>',
    '</html>',
    '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/** Sends a preview as a page; what every preview route ends with. */
@Injectable()
export class PreviewResponder {
  private readonly editorOrigins: readonly string[];

  constructor(config: ConfigService<Env, true>) {
    this.editorOrigins =
      config.get('CCMS_EDITOR_ORIGINS', { infer: true }) ?? [];
  }

  send(
    req: Request,
    res: Response,
    preview: Preview,
    theme: PreviewTheme,
  ): string {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      contentSecurityPolicy(this.editorOrigins),
    );
    res.setHeader('X-Ccms-Issues', String(preview.issueCount));
    return pageHtml(preview, theme, relativeRoot(req.path));
  }
}
