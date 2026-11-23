import { Injectable, Logger } from '@nestjs/common';
import sharp from 'sharp';
import { BlobStore } from '../../blobs/core/blob-store.js';
import {
  DEFAULT_PRODUCT_NAME,
  MAX_BRANDING_IMAGE_BYTES,
} from '../../branding/core/branding.js';
import { BrandingStore } from '../../branding/core/branding-store.js';
import { type MailBrand, MailBrandSource } from '../core/mail-ports.js';

/** The logo's height in an email, in CSS pixels; it is rendered at twice that for sharp screens. */
export const LOGO_HEIGHT = 40;
/** And its widest. */
export const LOGO_MAX_WIDTH = 240;

/**
 * The branding (#169) as an email shows it: the product name (or the default), the primary
 * colour and the light logo, turned into a PNG (mail clients show WebP badly) at twice its size
 * in the email, kept per image hash. A logo that cannot be read leaves the email without one
 * (the name shows instead), with a warning; the next email tries again.
 */
@Injectable()
export class BrandingMailBrand extends MailBrandSource {
  private readonly logger = new Logger('Mail');
  private cached?: { sha256: string; logo: MailBrand['logo'] };

  constructor(
    private readonly branding: BrandingStore,
    private readonly blobs: BlobStore,
  ) {
    super();
  }

  async productName(): Promise<string> {
    const { branding } = await this.branding.read();
    return branding.productName ?? DEFAULT_PRODUCT_NAME;
  }

  async read(): Promise<MailBrand> {
    const { branding } = await this.branding.read();
    return {
      productName: branding.productName ?? DEFAULT_PRODUCT_NAME,
      primary: branding.primary,
      logo: branding.logoLight ? await this.logo(branding.logoLight) : null,
    };
  }

  private async logo(sha256: string): Promise<MailBrand['logo']> {
    if (this.cached?.sha256 === sha256) return this.cached.logo;
    let logo: MailBrand['logo'] = null;
    try {
      const blob = await this.blobs.get(sha256);
      if (blob) {
        const bytes = await readAll(blob.stream, MAX_BRANDING_IMAGE_BYTES);
        const { data, info } = await sharp(bytes, {
          limitInputPixels: 4096 * 4096,
        })
          .resize({
            height: LOGO_HEIGHT * 2,
            width: LOGO_MAX_WIDTH * 2,
            fit: 'inside',
            withoutEnlargement: true,
          })
          .png()
          .toBuffer({ resolveWithObject: true });
        const scale = Math.min(
          1,
          LOGO_HEIGHT / (info.height / 2),
          LOGO_MAX_WIDTH / (info.width / 2),
        );
        logo = {
          png: data,
          width: Math.max(1, Math.round((info.width / 2) * scale)),
          height: Math.max(1, Math.round((info.height / 2) * scale)),
        };
      }
    } catch (error) {
      this.logger.warn(
        `The branding's logo could not be read for emails (${error instanceof Error ? error.name : 'unknown error'}); they show the name instead.`,
      );
      // Tried again on the next email: a blob store that was down may be back.
      return null;
    }
    this.cached = { sha256, logo };
    return logo;
  }
}

async function readAll(
  stream: AsyncIterable<Buffer | string>,
  max: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    size += buffer.length;
    if (size > max) throw new Error('The logo is larger than allowed.');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
