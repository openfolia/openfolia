import { AssetRef, FileName } from '@openfolia/content-model';
import { z } from 'zod';
import { pagedDocument, resourceObject } from '../../base/api/json-api.js';
import { assetReference } from '../core/asset-upload.js';
import {
  type ListedAsset,
  USED_IN_SHOWN,
} from '../core/actions/list-assets.action.js';

export const AssetUse = z
  .object({
    moduleId: z.string(),
    lang: z.string(),
    title: z.string().describe('The module’s title in that language.'),
  })
  .meta({ id: 'AssetUse' });

export const AssetFont = z
  .object({
    format: z.enum(['ttf', 'otf', 'woff', 'woff2']),
    family: z
      .string()
      .describe(
        'The family the font names itself (its typographic family, else its family): what the design screen shows and writes as a page design’s `fonts.<role>.family`. The PDF finds a design’s font by its role, whatever family it is named.',
      ),
    subfamily: z.string().describe('Its style as it names it (`Bold Italic`).'),
    weight: z
      .int()
      .min(1)
      .max(1000)
      .describe('1 to 1000, as the font states it: 400 regular, 700 bold.'),
    italic: z.boolean(),
    copyright: z
      .string()
      .nullable()
      .describe('The copyright notice the font states; null for none.'),
    licence: z
      .string()
      .nullable()
      .describe(
        'The licence description the font states (check it allows embedding in PDFs); null for none.',
      ),
    licenceUrl: z
      .string()
      .nullable()
      .describe(
        'The licence’s address as the font states it, unchecked text; null for none.',
      ),
  })
  .meta({ id: 'AssetFont' });

export const AssetResource = resourceObject('Asset', {
  attributes: z.object({
    reference: AssetRef.describe(
      'How a module refers to the file: `sha256:<hash>`, an image or attachment block’s `asset`.',
    ),
    fileName: FileName.nullable().describe(
      'The name a download of it is saved under: the first attachment block the reader may see that attaches it (by module ID and language), else its upload’s into the change set of `filter[changeSet]`; null when neither names one.',
    ),
    contentType: z
      .string()
      .nullable()
      .describe(
        'The stored media type (sniffed from the bytes for older content); null when the file is missing (`meta.missing`).',
      ),
    size: z.int().min(0).nullable().describe('In bytes; null when missing.'),
    width: z
      .int()
      .min(1)
      .nullable()
      .describe(
        'In pixels, as the file’s header states it (PNG, JPEG, GIF, WebP); null for an SVG, a header not found, or a missing file.',
      ),
    height: z.int().min(1).nullable().describe('In pixels; null as `width`.'),
    font: AssetFont.nullable().describe(
      'A font’s facts, read from the file (#555); null for any other file and a missing one. A font’s `contentType` is its format’s (`font/ttf`, `font/otf`, `font/woff`, `font/woff2`).',
    ),
  }),
  meta: z.object({
    usedIn: z
      .array(AssetUse)
      .describe(
        `The modules the reader may see that show the image at this ref, by module ID and language; at most ${USED_IN_SHOWN} (\`usedInCount\` counts them all). Empty for an image only uploaded into the change set.`,
      ),
    usedInCount: z.int().min(0),
    usedInManuals: z
      .array(
        z.object({
          manualId: z.string(),
          title: z.string(),
        }),
      )
      .describe(
        `The manuals the reader may see that have the image as their cover image, or a variant's (#394), at this ref; at most ${USED_IN_SHOWN}. Such an image is in use: it is never listed as unused.`,
      ),
    languages: z
      .array(z.string())
      .describe(
        'The languages of the modules the reader may see that use it (all of them, not only those in `usedIn`), sorted. Empty for an upload no module uses yet, and for an unused file.',
      ),
    usedAs: z
      .array(z.enum(['image', 'attachment']))
      .describe(
        'How the modules the reader may see use it: shown by an image block, attached by an attachment block, both, or neither (an upload no module uses yet).',
      ),
    uploaded: z
      .boolean()
      .describe(
        'Uploaded into the change set of `filter[changeSet]`: preview it at `GET /change-sets/{changeSetId}/assets/{hash}` until a module at the ref shows it (then `GET /assets/{hash}`).',
      ),
    missing: z
      .boolean()
      .describe(
        'Neither the blob store nor the repository holds the file a module refers to.',
      ),
  }),
})
  .describe('`id` is the SHA-256 of the file, 64 lowercase hex characters.')
  .meta({ id: 'AssetResource' });

export const AssetPageDocument = pagedDocument(AssetResource).meta({
  id: 'AssetPageDocument',
});

export function toAssetResource(
  asset: ListedAsset,
): z.infer<typeof AssetResource> {
  const { info } = asset;
  return {
    type: 'Asset',
    id: asset.sha256,
    attributes: {
      reference: assetReference(asset.sha256),
      fileName: asset.fileName ?? null,
      contentType: info?.contentType ?? null,
      size: info?.size ?? null,
      width: info?.dimensions?.width ?? null,
      height: info?.dimensions?.height ?? null,
      font: info?.font
        ? {
            format: info.font.format,
            family: info.font.family,
            subfamily: info.font.subfamily,
            weight: info.font.weight,
            italic: info.font.italic,
            copyright: info.font.copyright,
            licence: info.font.licence,
            licenceUrl: info.font.licenceUrl,
          }
        : null,
    },
    meta: {
      usedIn: asset.usedIn.map(({ moduleId, lang, title }) => ({
        moduleId,
        lang,
        title,
      })),
      usedInCount: asset.usedInCount,
      usedInManuals: asset.usedInManuals.map(({ manualId, title }) => ({
        manualId,
        title,
      })),
      languages: [...asset.languages],
      usedAs: [
        ...(asset.usedAsImage ? (['image'] as const) : []),
        ...(asset.usedAsAttachment ? (['attachment'] as const) : []),
      ],
      uploaded: asset.uploaded,
      missing: info === undefined,
    },
  };
}
