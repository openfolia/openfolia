import { ConfigKey, LanguageTag } from '@openfolia/content-model';
import { z } from 'zod';
import {
  PageLinks,
  PageMeta,
  resourceObject,
} from '../../base/api/json-api.js';
import type { Release } from '../../releases/core/release.js';
import {
  DOWNLOAD_KINDS,
  type Download,
  type DownloadVersion,
  VERSION_STATES,
} from '../core/download.js';

/** The release a download's file comes from: enough to name it and read at its tag. */
const DownloadRelease = z
  .object({
    id: z.string().describe('The release’s ID (`GET /releases/{releaseId}`).'),
    tag: z
      .string()
      .describe('The release’s tag: content as released, `?ref=<tag>`.'),
    revision: z.string().describe('The product revision, e.g. `2.1`.'),
    publishedAt: z.iso
      .datetime({ offset: true })
      .describe('When the release was cut.'),
  })
  .meta({ id: 'DownloadRelease' });

const releaseOf = (release: Release): z.infer<typeof DownloadRelease> => ({
  id: release.id,
  tag: release.tag,
  revision: release.revision,
  publishedAt: release.publishedAt.toISOString(),
});

/** What a download's file is, at a release: shared by a download and its versions. */
const fileMembers = {
  sha256: z
    .string()
    .describe(
      'The file’s SHA-256, hex: its checksum, and the blob store’s key.',
    ),
  size: z.number().int().describe('The file’s size in bytes.'),
  mediaType: z
    .string()
    .describe('The file’s media type, e.g. `application/pdf`.'),
  fileName: z
    .string()
    .describe(
      'The name it downloads as: an attachment’s `fileName`, a PDF’s `<manual>_<variant>_<lang>_<revision>.pdf`.',
    ),
};

export const DownloadResource = resourceObject('Download', {
  attributes: z.object({
    kind: z
      .enum(DOWNLOAD_KINDS)
      .describe(
        '`attachment`: a file attached in a module (an attachment block); `manual`: a manual’s PDF in one variant and language.',
      ),
    product: z
      .string()
      .describe('The product (a value of the product facet) it is a file of.'),
    lang: z.string().describe('Its language, a language tag.'),
    name: z
      .string()
      .describe(
        'The attachment’s name (its link text), or the manual’s title.',
      ),
    description: z
      .string()
      .nullable()
      .describe('What the attachment is for; null for none and for a manual.'),
    ...fileMembers,
    moduleId: z
      .string()
      .nullable()
      .describe('The module it is attached in; null for a manual.'),
    blockId: z
      .string()
      .nullable()
      .describe('The attachment block’s ID in that module; null for a manual.'),
    manualId: z
      .string()
      .nullable()
      .describe('The manual; null for an attachment.'),
    variant: z
      .string()
      .nullable()
      .describe(
        'The manual’s variant, its slug (e.g. `model=large`); null for an attachment.',
      ),
    release: DownloadRelease.describe(
      'The product’s latest release (the newest that stands, cut from `main`), which holds this file.',
    ),
  }),
  meta: z.object({
    moduleTitle: z
      .string()
      .nullable()
      .describe(
        'The title of the module it is attached in; null for a manual.',
      ),
  }),
  links: z.object({
    versions: z
      .string()
      .describe(
        'Its versions across the product’s releases (`GET …/versions`).',
      ),
    file: z
      .string()
      .describe(
        'The file at the latest release (`GET …/versions/{releaseId}/file`).',
      ),
  }),
})
  .describe(
    'A downloadable file of a product (#139): an attachment block of a module for the product (module, block and language), or a manual’s PDF (manual, variant and language), as the product’s latest release holds it. Its ID stays across releases, so its versions share it.',
  )
  .meta({ id: 'DownloadResource' });

export const DownloadPageDocument = z
  .object({
    data: z.array(DownloadResource),
    meta: z.object({ page: PageMeta }),
    links: PageLinks,
  })
  .meta({ id: 'DownloadPageDocument' });

export const DownloadVersionResource = resourceObject('DownloadVersion', {
  attributes: z.object({
    state: z
      .enum(VERSION_STATES)
      .describe(
        '`current`: the file the product’s latest release holds; `superseded`: a later file took its place; `withdrawn`: every release that held it is withdrawn.',
      ),
    ...fileMembers,
    release: DownloadRelease.describe(
      'The release in which the file changed to this one (its first).',
    ),
    changeNote: z
      .object({
        notes: z
          .string()
          .nullable()
          .describe(
            'The notes of that release, in the download’s language when it has them (else its notes); null for none.',
          ),
        description: z
          .string()
          .nullable()
          .describe(
            'The attachment’s description at that release; null for none and for a manual.',
          ),
      })
      .describe(
        'What changed: the release notes, and the attachment’s description.',
      ),
  }),
  links: z.object({
    file: z
      .string()
      .describe('This version’s file (`GET …/versions/{releaseId}/file`).'),
  }),
})
  .describe(
    'One version of a download: its file from the release it first appeared in, listed only where the file’s hash differs from the version before.',
  )
  .meta({ id: 'DownloadVersionResource' });

export const DownloadVersionPageDocument = z
  .object({
    data: z.array(DownloadVersionResource),
    meta: z.object({
      page: PageMeta,
      truncated: z
        .boolean()
        .describe(
          'The product has more releases than are looked through (the 500 newest): older versions are not listed.',
        ),
    }),
    links: PageLinks,
  })
  .meta({ id: 'DownloadVersionPageDocument' });

/** Filter parameters of `GET /downloads`, validated before anything is read. */
export const downloadFilters = {
  product: ConfigKey,
  lang: LanguageTag,
  kind: z.enum(DOWNLOAD_KINDS),
  q: z.string().trim().min(1).max(200),
  mediaType: z
    .string()
    .regex(
      /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/(?:\*|[a-z0-9][a-z0-9!#$&^_.+-]{0,62})$/,
      'a lowercase media type (`application/pdf`) or a top-level type (`image/*`)',
    ),
};

/** A download's ID in a path, checked for its length only: its form is the action's (404). */
export const DownloadIdParam = z
  .string()
  .min(1)
  .max(1_400)
  .describe(
    'The download’s ID, as `GET /downloads` gives it: `attachment:<product>:<module>:<block>:<lang>` or `manual:<product>:<manual>:<lang>:<variant>`.',
  );

const path = (id: string) => `/downloads/${encodeURIComponent(id)}`;

export function toDownloadResource(
  download: Download,
): z.infer<typeof DownloadResource> {
  const { key } = download;
  return {
    type: 'Download',
    id: download.id,
    attributes: {
      kind: key.kind,
      product: key.product,
      lang: key.lang,
      name: download.name,
      description: download.description,
      sha256: download.sha256,
      size: download.size,
      mediaType: download.mediaType,
      fileName: download.fileName,
      moduleId: key.kind === 'attachment' ? key.moduleId : null,
      blockId: key.kind === 'attachment' ? key.blockId : null,
      manualId: key.kind === 'manual' ? key.manualId : null,
      variant: key.kind === 'manual' ? key.variant : null,
      release: releaseOf(download.release),
    },
    meta: { moduleTitle: download.moduleTitle },
    links: {
      versions: `${path(download.id)}/versions`,
      file: `${path(download.id)}/versions/${download.release.id}/file`,
    },
  };
}

export function toDownloadVersionResource(
  downloadId: string,
  version: DownloadVersion,
): z.infer<typeof DownloadVersionResource> {
  return {
    type: 'DownloadVersion',
    id: version.release.id,
    attributes: {
      state: version.state,
      sha256: version.sha256,
      size: version.size,
      mediaType: version.mediaType,
      fileName: version.fileName,
      release: releaseOf(version.release),
      changeNote: { notes: version.notes, description: version.description },
    },
    links: { file: `${path(downloadId)}/versions/${version.release.id}/file` },
  };
}
