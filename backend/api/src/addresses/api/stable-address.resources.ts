import {
  ConfigKey,
  DELIVERY_ACCESS,
  LanguageTag,
  ModuleId,
} from '@openfolia/content-model';
import { z } from 'zod';
import {
  PageLinks,
  PageMeta,
  resourceObject,
  toOne,
} from '../../base/api/json-api.js';
import type { ListedAddress } from '../core/actions/list-stable-addresses.action.js';
import {
  absoluteUrl,
  addressPath,
  latestOf,
  type StableAddress,
  type StableAddressSettings,
} from '../core/stable-address.js';

const AddressLink = z
  .object({
    path: z
      .string()
      .describe(
        'From the API’s root, e.g. `/d/north/operating/model=large/en`; behind the editor’s web server, at its root too.',
      ),
    url: z
      .string()
      .nullable()
      .describe(
        'The absolute URL readers open (`CCMS_PUBLIC_URL` and `path`), what the QR code holds; null while `CCMS_PUBLIC_URL` is not set.',
      ),
  })
  .meta({ id: 'StableAddressLink' });

const AddressPair = z.object({
  html: AddressLink.describe('The manual as a web page.'),
  pdf: AddressLink.describe('The release’s PDF of it.'),
});

export const StableAddressResource = resourceObject('StableAddress', {
  attributes: z.object({
    product: z
      .string()
      .describe('The release’s product, a value of the product facet.'),
    manual: z.string().describe('The manual’s ID at the release.'),
    slug: z
      .string()
      .describe(
        'Its address segment: `delivery.manuals.<id>.slug` in `openfolia.yaml` on `main`, else its ID.',
      ),
    variant: z.string().describe('The variant’s slug, e.g. `model=large`.'),
    lang: z.string().describe('The language, a language tag.'),
    revision: z.string().describe('The release’s revision.'),
    latest: AddressPair.describe(
      'Always the product’s latest release (the newest of `main` not withdrawn): what to print.',
    ),
    pinned: AddressPair.describe('This release, for good (`@<revision>`).'),
  }),
  relationships: z.object({ release: toOne('Release') }),
  meta: z.object({
    latestRelease: z
      .boolean()
      .describe(
        'The release is its product’s latest: the latest address opens it now.',
      ),
    withdrawn: z
      .boolean()
      .describe(
        'The release is withdrawn: its pinned address shows a notice that links the latest.',
      ),
    pdfReady: z
      .boolean()
      .describe('The PDF is rendered (its output `done`), so `pdf` opens it.'),
  }),
})
  .describe(
    'A manual’s stable addresses in one variant and language (#450): where readers open it, with a QR code at `<path>/qr.svg` and `<path>/qr.png`.',
  )
  .meta({ id: 'StableAddressResource' });

export const StableAddressPageDocument = z
  .object({
    data: z.array(StableAddressResource),
    meta: z.object({
      page: PageMeta,
      access: z
        .enum(DELIVERY_ACCESS)
        .describe(
          'Who may open the addresses (`delivery.access` on `main`): `public` (anyone, up to `delivery.publicAudience`), `signed-in` (a reader with a token, in their scope) or `off` (nobody: every address is 404).',
        ),
      publicUrl: z
        .string()
        .nullable()
        .describe(
          '`CCMS_PUBLIC_URL`; null when not set (no URLs, no QR codes).',
        ),
    }),
    links: PageLinks,
  })
  .meta({ id: 'StableAddressPageDocument' });

/** Filter parameters of `GET /stable-addresses`, validated before any query. */
export const addressFilters = {
  release: z.uuid(),
  product: ConfigKey,
  manual: ModuleId,
  lang: LanguageTag,
};

const link = (
  settings: StableAddressSettings,
  address: StableAddress,
  kind: 'html' | 'pdf',
) => {
  const path = addressPath(address, kind);
  return { path, url: absoluteUrl(settings, path) ?? null };
};

export function toStableAddressResource(
  settings: StableAddressSettings,
  listed: ListedAddress,
): z.infer<typeof StableAddressResource> {
  const { release, output, pinned } = listed;
  const latest = latestOf(pinned);
  return {
    type: 'StableAddress',
    id: `${release.id}/${output.manualId}/${output.variant}/${output.lang}`,
    attributes: {
      product: release.product,
      manual: output.manualId,
      slug: pinned.slug,
      variant: output.variant,
      lang: output.lang,
      revision: release.revision,
      latest: {
        html: link(settings, latest, 'html'),
        pdf: link(settings, latest, 'pdf'),
      },
      pinned: {
        html: link(settings, pinned, 'html'),
        pdf: link(settings, pinned, 'pdf'),
      },
    },
    relationships: { release: { data: { type: 'Release', id: release.id } } },
    meta: {
      latestRelease: listed.latest,
      withdrawn: release.withdrawal !== null,
      pdfReady: output.state === 'done',
    },
  };
}
