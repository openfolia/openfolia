import { z } from 'zod';
import {
  RENDITION_WIDTHS,
  type RenditionWidth,
} from '../core/asset-rendition.js';

/** `?width=`: one of the rendition widths, as text. */
export const WidthParam = z
  .enum(RENDITION_WIDTHS.map(String) as [string, ...string[]], {
    error: `One of ${RENDITION_WIDTHS.join(', ')}.`,
  })
  .transform((value) => Number(value) as RenditionWidth);
export type Width = RenditionWidth;

export const WIDTH_QUERY = {
  name: 'width',
  required: false,
  description: `A rendition instead of the file: a WebP at most this many pixels wide (${RENDITION_WIDTHS.join(', ')}), never upscaled. Only for PNG, JPEG, GIF and WebP images.`,
  schema: { type: 'integer' as const, enum: [...RENDITION_WIDTHS] },
};
