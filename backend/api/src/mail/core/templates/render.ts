import { DEFAULT_PRODUCT_NAME } from '../../../branding/core/branding.js';
import type { MailBrand } from '../mail-ports.js';
import {
  headerText,
  type InlineImage,
  MAX_SENDER_NAME,
  MAX_SUBJECT,
  type MailLanguage,
  type MailRecipient,
  type RenderedMail,
} from '../mail.js';
import { LOGO_CID, renderHtml, renderText } from './layout.js';
import {
  footer,
  MAIL_TEMPLATES,
  type MailTemplate,
  type MailTemplateName,
} from './templates.js';

/** A link under the public URL; null without one. A path never leaves it. */
export function publicLink(
  publicUrl: string | null,
  path: string,
): string | null {
  if (publicUrl === null) return null;
  if (/^[a-z][a-z0-9+.-]*:|^[/\\]/i.test(path)) {
    throw new Error('An email link is a path under the public URL.');
  }
  const url = new URL(path, publicUrl);
  if (!url.href.startsWith(publicUrl)) {
    throw new Error('An email link is a path under the public URL.');
  }
  return url.href;
}

/**
 * One email, ready to send: the template's words in `language`, laid out with the branding, as
 * HTML and plain text, the logo inline. Params are checked against the template's schema again
 * (they were stored); a mismatch throws. The subject and the sender's name are header text
 * (`headerText`): one line, no control characters.
 */
export function renderMail(input: {
  template: MailTemplateName;
  params: unknown;
  language: MailLanguage;
  to: MailRecipient;
  from: string;
  brand: MailBrand;
  publicUrl: string | null;
}): RenderedMail {
  // One template, whichever: its params are checked against its own schema first.
  const template = MAIL_TEMPLATES[input.template] as unknown as MailTemplate<
    Record<string, unknown>
  >;
  const params = template.params.parse(input.params);
  const productName =
    headerText(input.brand.productName, MAX_SENDER_NAME) ||
    DEFAULT_PRODUCT_NAME;
  const brand = { ...input.brand, productName };
  const words = template.texts[input.language](params, {
    productName,
    link: (path) => publicLink(input.publicUrl, path),
  });
  const content = {
    ...words,
    subject: headerText(words.subject, MAX_SUBJECT),
    footer: footer(input.language, productName, input.publicUrl),
  };
  const images: InlineImage[] = brand.logo
    ? [
        {
          cid: LOGO_CID,
          filename: 'logo.png',
          contentType: 'image/png',
          content: brand.logo.png,
        },
      ]
    : [];
  const name = input.to.name ? headerText(input.to.name, MAX_SENDER_NAME) : '';
  return {
    from: { name: productName, address: input.from },
    to: { address: input.to.address, name: name || null },
    subject: content.subject,
    html: renderHtml(content, brand, input.language),
    text: renderText(content),
    images,
    language: input.language,
  };
}
