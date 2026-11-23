import { Injectable } from '@nestjs/common';
import {
  deliverySlug,
  type DeliveryAccess,
  productFacet,
} from '@openfolia/content-model';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { NotFoundError } from '../../../base/core/errors.js';
import type { PageRequest, Paginated } from '../../../base/core/paging.js';
import { OpenSnapshotAction } from '../../../content/core/actions/open-snapshot.action.js';
import type { ReadableContent } from '../../../content/core/readable-content.js';
import type { Release } from '../../../releases/core/release.js';
import type { ReleaseOutput } from '../../../releases/core/release-output.js';
import { ReleaseOutputStore } from '../../../releases/core/release-output-store.js';
import { ReleaseStore } from '../../../releases/core/release-store.js';
import { visibleIn } from '../../../releases/core/actions/release-outputs.action.js';
import {
  deliveryAccess,
  type StableAddress,
  StableAddressSettings,
} from '../stable-address.js';
import { StableAddressAccessAction } from './open-stable-address.action.js';

/** Which addresses to list; every field optional. */
export interface AddressFilter {
  /** One release's: its pinned addresses (and the latest ones beside them). */
  readonly release?: string;
  /** Only this product's latest release (without `release`). */
  readonly product?: string;
  readonly manual?: string;
  readonly lang?: string;
}

/** One manual, variant and language of a release, and its addresses. */
export interface ListedAddress {
  readonly release: Release;
  readonly output: ReleaseOutput;
  /** Its address, pinned to the release. */
  readonly pinned: StableAddress;
  /** Whether the release is its product's latest, so the latest address opens it now. */
  readonly latest: boolean;
}

export interface AddressPage extends Paginated<ListedAddress> {
  /** Who may open them (`delivery.access` on `main`, at most `CCMS_DELIVERY_MAX_ACCESS`). */
  readonly access: DeliveryAccess;
}

/**
 * `GET /stable-addresses` (#450): the stable addresses of the manuals a reader may read, one
 * per manual, variant and language of a release's outputs (#249), for the editor's Copy and
 * QR code: of one release (`release`), else of each product's latest release (the product
 * facet's values in order, or `product` alone). Filtered as the outputs list is
 * (`seesWholeManualIn` over the distinct audiences and languages, before paging), so neither
 * the list nor the total tells of a manual outside the reader's scope. Paged across the
 * releases in that order, each release's outputs by manual, variant and language.
 */
@Injectable()
export class ListStableAddressesAction extends ActorAction<
  { actor: Actor; filter: AddressFilter; page: PageRequest },
  AddressPage
> {
  readonly policy = 'content.read';

  constructor(
    private readonly releases: ReleaseStore,
    private readonly outputs: ReleaseOutputStore,
    private readonly snapshots: OpenSnapshotAction,
    private readonly access: StableAddressAccessAction,
    private readonly settings: StableAddressSettings,
  ) {
    super();
  }

  protected async run({
    actor,
    filter,
    page,
  }: {
    actor: Actor;
    filter: AddressFilter;
    page: PageRequest;
  }): Promise<AddressPage> {
    const config = await this.access.mainConfig();
    let releases: Release[];
    if (filter.release !== undefined) {
      const release = await this.releases.find(filter.release);
      if (!release) throw new NotFoundError(`No release "${filter.release}".`);
      releases = [release];
    } else {
      const products =
        filter.product !== undefined
          ? [filter.product]
          : (productFacet(config)?.values.map((v) => v.id) ?? []);
      const latest = await Promise.all(
        products.map((p) => this.releases.latest(p)),
      );
      releases = latest.filter((r): r is Release => r !== undefined);
    }
    // A manual's PDFs: an offline package (#59) has no stable address.
    const outputFilter = {
      kind: 'pdf' as const,
      ...(filter.manual !== undefined && { manual: filter.manual }),
      ...(filter.lang !== undefined && { lang: filter.lang }),
    };
    // Each release's readable outputs, counted, then the page cut across them.
    const parts: {
      release: Release;
      visible: Awaited<ReturnType<typeof visibleIn>>;
      total: number;
    }[] = [];
    for (const release of releases) {
      let content: ReadableContent;
      try {
        content = await this.snapshots.handle({ actor, ref: release.tag });
      } catch (error) {
        if (error instanceof NotFoundError) continue;
        throw error;
      }
      if (content.commit !== release.commit) continue;
      const visible = await visibleIn(this.outputs, content, release.id);
      const { total } = await this.outputs.list(
        release.id,
        outputFilter,
        visible,
        { number: 1, size: 1 },
      );
      parts.push({ release, visible, total });
    }
    const total = parts.reduce((sum, part) => sum + part.total, 0);
    const items: ListedAddress[] = [];
    let skip = (page.number - 1) * page.size;
    for (const part of parts) {
      if (items.length >= page.size) break;
      if (skip >= part.total) {
        skip -= part.total;
        continue;
      }
      const latest =
        filter.release === undefined ||
        (await this.releases.latest(part.release.product))?.id ===
          part.release.id;
      // The window [offset, offset + want) of this release's outputs, read in the page's
      // own size: it spans at most two of the store's pages.
      const offset = skip;
      skip = 0;
      const want = Math.min(page.size - items.length, part.total - offset);
      const size = page.size;
      for (
        let number = Math.floor(offset / size) + 1;
        (number - 1) * size < offset + want;
        number++
      ) {
        const { items: rows } = await this.outputs.list(
          part.release.id,
          outputFilter,
          part.visible,
          { number, size },
        );
        rows.forEach((output, i) => {
          const index = (number - 1) * size + i;
          if (index < offset || index >= offset + want) return;
          items.push({
            release: part.release,
            output,
            latest,
            pinned: {
              product: part.release.product,
              slug: deliverySlug(config, output.manualId),
              variant: output.variant,
              lang: output.lang,
              revision: part.release.revision,
            },
          });
        });
        if (rows.length < size) break;
      }
    }
    return {
      items,
      total,
      access: deliveryAccess(config, this.settings),
    };
  }
}
