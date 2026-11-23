import {
  contrast,
  type Hex,
  oklchToHex,
  parseOklch,
  TEXT_CONTRAST,
} from '../../../branding/core/brand-colours.js';
import type { MailBrand } from '../mail-ports.js';
import type { MailLanguage } from '../mail.js';

/** What one email says, before it is laid out: plain text throughout, never markup. */
export interface MailContent {
  readonly subject: string;
  readonly heading: string;
  readonly paragraphs: readonly string[];
  /** A one-time code shown large after the paragraphs (#634), digits only; absent for none. */
  readonly code?: string | undefined;
  /** The button, and the same link in the text part; null for none. */
  readonly action: { readonly label: string; readonly href: string } | null;
  /** Why the person gets this email. */
  readonly reason: string;
  /** The footer line ("Sent by …"). */
  readonly footer: string;
}

/**
 * Text as HTML: `&`, `<`, `>`, `"` and `'` escaped, so nothing in it is markup or leaves an
 * attribute. Every value placed in the HTML goes through it.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The theme's primary colour (`frontend/theme/src/theme.css`, light), for a brand that sets none. */
export const DEFAULT_PRIMARY: Hex = oklchToHex(
  parseOklch('oklch(0.5222 0.0965 139.98)')!,
);

const WHITE: Hex = '#ffffff';
/** The theme's dark text, for a light primary. */
const INK: Hex = '#1f2a2c';

/**
 * The button's fill and text: the brand's primary with white or dark text, whichever reads at
 * 4.5:1 or better; a primary neither reads on is replaced by the theme's.
 */
export function buttonColours(primary: Hex | null): {
  fill: Hex;
  text: Hex;
} {
  for (const fill of primary === null
    ? [DEFAULT_PRIMARY]
    : [primary, DEFAULT_PRIMARY]) {
    const text = contrast(WHITE, fill) >= contrast(INK, fill) ? WHITE : INK;
    if (contrast(text, fill) >= TEXT_CONTRAST) return { fill, text };
  }
  return { fill: DEFAULT_PRIMARY, text: WHITE };
}

/** A code is digits only; anything else is a programming error. */
function checkedCode(code: string): string {
  if (!/^[0-9]{4,10}$/.test(code)) {
    throw new Error('An email code is digits only.');
  }
  return code;
}

/** The `cid` of the inline logo. */
export const LOGO_CID = 'logo';

/** Only an http(s) URL is a link; anything else is a programming error. */
function checkedHref(href: string): string {
  const url = URL.canParse(href) ? new URL(href) : undefined;
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
    throw new Error('An email link must be an http(s) URL.');
  }
  return url.href;
}

/**
 * The HTML part: one column of tables with inline styles (what mail clients render), the logo
 * from the message itself (`cid:`), never a remote image, and nothing but escaped text.
 */
export function renderHtml(
  content: MailContent,
  brand: MailBrand,
  language: MailLanguage,
): string {
  const { fill, text } = buttonColours(brand.primary);
  const header = brand.logo
    ? `<img src="cid:${LOGO_CID}" width="${brand.logo.width}" height="${brand.logo.height}" alt="${escapeHtml(brand.productName)}" style="display:block;border:0;outline:none;max-width:100%;height:auto">`
    : `<span style="font-size:18px;font-weight:600;color:#1f2a2c">${escapeHtml(brand.productName)}</span>`;
  const paragraphs = content.paragraphs
    .map(
      (p) =>
        `<p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#33413f">${escapeHtml(p)}</p>`,
    )
    .join('');
  const code =
    content.code === undefined
      ? ''
      : `<p style="margin:0 0 20px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:30px;line-height:1.2;font-weight:600;letter-spacing:6px;color:#1f2a2c">${escapeHtml(checkedCode(content.code))}</p>`;
  const action = content.action
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px"><tr><td style="border-radius:8px;background:${fill}"><a href="${escapeHtml(checkedHref(content.action.href))}" style="display:inline-block;padding:12px 20px;font-size:15px;font-weight:600;color:${text};text-decoration:none;border-radius:8px">${escapeHtml(content.action.label)}</a></td></tr></table>` +
      `<p style="margin:0 0 16px;font-size:13px;line-height:1.5;color:#5b6866;word-break:break-all">${escapeHtml(checkedHref(content.action.href))}</p>`
    : '';
  return [
    '<!doctype html>',
    `<html lang="${language}">`,
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">',
    `<title>${escapeHtml(content.subject)}</title></head>`,
    '<body style="margin:0;padding:0;background:#f4f2ef">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f2ef"><tr><td align="center" style="padding:24px 12px">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif">',
    `<tr><td style="padding:0 4px 16px">${header}</td></tr>`,
    '<tr><td style="background:#ffffff;border:1px solid #e4dfd9;border-radius:12px;padding:28px 28px 12px">',
    `<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;font-weight:600;color:#1f2a2c">${escapeHtml(content.heading)}</h1>`,
    paragraphs,
    code,
    action,
    '</td></tr>',
    `<tr><td style="padding:16px 4px 0;font-size:12px;line-height:1.5;color:#5b6866">${escapeHtml(content.reason)}<br>${escapeHtml(content.footer)}</td></tr>`,
    '</table></td></tr></table></body></html>',
  ].join('\n');
}

/** The plain-text part: the same words, the link on a line of its own. */
export function renderText(content: MailContent): string {
  const lines = [
    content.heading,
    '',
    ...content.paragraphs.flatMap((p) => [p, '']),
  ];
  if (content.code !== undefined) {
    lines.push(checkedCode(content.code), '');
  }
  if (content.action) {
    lines.push(
      `${content.action.label}:`,
      checkedHref(content.action.href),
      '',
    );
  }
  lines.push('--', content.reason, content.footer, '');
  return lines.join('\n');
}
