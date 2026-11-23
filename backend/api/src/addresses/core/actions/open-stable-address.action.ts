import { Injectable } from '@nestjs/common';
import {
  deliverySlug,
  type DeliveryAccess,
  type Manifest,
  manualIdsOf,
  manualOfSlug,
  type ProjectConfig,
  textIn,
  variantSlug,
} from '@openfolia/content-model';
import type { Actor } from '../../../access/core/actor.js';
import {
  ActorAction,
  type UnguardedAction,
} from '../../../access/core/policy.js';
import { ConflictError, NotFoundError } from '../../../base/core/errors.js';
import { BlobStore, type StoredBlob } from '../../../blobs/core/blob-store.js';
import { OpenSnapshotAction } from '../../../content/core/actions/open-snapshot.action.js';
import type { ReadableContent } from '../../../content/core/readable-content.js';
import { RELEASED_BRANCH } from '../../../content/core/released.js';
import type { Release } from '../../../releases/core/release.js';
import { RELEASE_READER } from '../../../releases/core/release-changes.js';
import {
  outputFileName,
  type ReleaseOutput,
} from '../../../releases/core/release-output.js';
import { ReleaseOutputStore } from '../../../releases/core/release-output-store.js';
import { ReleaseStore } from '../../../releases/core/release-store.js';
import {
  deliveryAccess,
  latestOf,
  publicReader,
  type StableAddress,
  StableAddressSettings,
} from '../stable-address.js';

/** Not found, whatever the reason: nothing tells a reader what they may not see. */
const notFound = () => new NotFoundError('No manual at this address.');

/**
 * Who reads a stable address (#450), by the project's `delivery.access` (`openfolia.yaml` on
 * `main`, read as a service that reads all released content, so the setting applies at
 * once), at most the operator's `CCMS_DELIVERY_MAX_ACCESS` (`deliveryAccess`, #553): `off`
 * is not found for everyone; `public` reads as the public reader (`publicReader`), always,
 * whoever asks (#608: a signed-in person who wants more opens a `signed-in` address); with
 * `signed-in`, a request with an actor (a session or a token) reads as that actor, and one
 * without is told to sign in (`reader` undefined).
 */
@Injectable()
export class StableAddressAccessAction implements UnguardedAction {
  readonly policy = 'public';

  constructor(
    private readonly snapshots: OpenSnapshotAction,
    private readonly settings: StableAddressSettings,
  ) {}

  async handle({ actor }: { readonly actor: Actor | undefined }): Promise<{
    /** Who may open the addresses: the project's setting, at most the operator's cap. */
    readonly access: DeliveryAccess;
    /** The configuration on `main`: the addresses' slugs and settings. */
    readonly config: ProjectConfig;
    /** Who reads; undefined: a reader must sign in. */
    readonly reader: Actor | undefined;
  }> {
    const config = await this.mainConfig();
    const access = deliveryAccess(config, this.settings);
    if (access === 'off') throw notFound();
    const reader = access === 'public' ? publicReader(config) : actor;
    return { access, config, reader };
  }

  /**
   * Whether the addresses answer everyone alike now: `delivery.access` is `public` (at most
   * the operator's cap). `ActorGuard` then looks at no credentials (#608).
   */
  async answersEveryone(): Promise<boolean> {
    return deliveryAccess(await this.mainConfig(), this.settings) === 'public';
  }

  /** The configuration on `main`, as `delivery.access` and the slugs are read from it. */
  async mainConfig(): Promise<ProjectConfig> {
    const main = await this.snapshots.handle({
      actor: RELEASE_READER,
      ref: RELEASED_BRANCH,
    });
    return main.config();
  }
}

/** A manual found at a stable address: what the page and the PDF are made from. */
export interface FoundAddress {
  readonly kind: 'found';
  readonly release: Release;
  /** The release's tag, as the reader reads it. */
  readonly content: ReadableContent;
  /** The manual's ID at the release (a renamed manual's former one in an older release). */
  readonly manualId: string;
  readonly manifest: Manifest;
  /** The address as asked, in its canonical form. */
  readonly address: StableAddress;
  /** The same address pinned to the release found (its revision). */
  readonly pinned: StableAddress;
}

/** What a stable address opens (`OpenStableAddressAction`). */
export type OpenedAddress =
  | FoundAddress
  /** The manual's address moved (a slug, a former address, a language's case): go there for good. */
  | { readonly kind: 'moved'; readonly to: StableAddress }
  /** A language the release does not have, with `delivery.missingLanguage: source`. */
  | { readonly kind: 'language'; readonly to: StableAddress }
  /** A language the release does not have, with `delivery.missingLanguage: picker`. */
  | {
      readonly kind: 'picker';
      readonly title: string;
      readonly lang: string;
      readonly languages: readonly StableAddress[];
    }
  /** A pinned release that was withdrawn: a notice, and where the current version is. */
  | {
      readonly kind: 'withdrawn';
      readonly release: Release;
      readonly title: string;
      readonly lang: string;
      readonly latest: StableAddress | undefined;
    };

/**
 * Opens a stable address (#450) as `actor` reads released content: the product's latest
 * release (`ReleaseStore.latest`: the newest of `main` that is not withdrawn), or the release
 * of its revision; the manual its slug names there (`manualOfSlug`, by the configuration on
 * `main`; in an older release under a former ID too, `manualIdsOf`), in one of its manifest's
 * variants, read at the release's tag as the actor reads it (scope and audience apply). Only
 * a release's tag is ever read, never a branch: an address shows released content only.
 * Anything the actor may not see is not found, exactly like a missing one, and an address
 * that moved is answered as moved only once the manual is found for the actor, so neither
 * tells of a manual they may not read.
 */
@Injectable()
export class OpenStableAddressAction extends ActorAction<
  {
    actor: Actor;
    address: StableAddress;
    /** The configuration on `main` (`StableAddressAccessAction`). */
    config: ProjectConfig;
  },
  OpenedAddress
> {
  readonly policy = 'content.read';

  constructor(
    private readonly releases: ReleaseStore,
    private readonly snapshots: OpenSnapshotAction,
  ) {
    super();
  }

  protected async run({
    actor,
    address,
    config,
  }: {
    actor: Actor;
    address: StableAddress;
    config: ProjectConfig;
  }): Promise<OpenedAddress> {
    const { manualId, moved } = manualOfSlug(config, address.slug);
    const release =
      address.revision === undefined
        ? await this.releases.latest(address.product)
        : await this.releases.findByRevision(address.product, address.revision);
    if (!release) throw notFound();
    let content: ReadableContent;
    try {
      content = await this.snapshots.handle({ actor, ref: release.tag });
    } catch (error) {
      if (error instanceof NotFoundError) throw notFound();
      throw error;
    }
    if (content.commit !== release.commit) throw notFound();

    let found: { id: string; manifest: Manifest } | undefined;
    for (const id of manualIdsOf(config, manualId)) {
      const manual = await content.manual(id);
      if (manual) {
        found = { id, manifest: manual.manifest };
        break;
      }
    }
    if (!found) throw notFound();
    const { manifest } = found;
    if (!manifest.variants.some((v) => variantSlug(v) === address.variant)) {
      throw notFound();
    }
    const canonical: StableAddress = {
      ...address,
      slug: deliverySlug(config, manualId),
    };
    const audience = manifest.audience;
    const { languages } = await content.config();
    const configured = [languages.source, ...languages.targets];
    const lang = configured.find(
      (l) => l.toLowerCase() === address.lang.toLowerCase(),
    );
    if (lang === undefined) {
      if (config.delivery.missingLanguage === 'source') {
        if (!(await content.seesManualIn(audience, languages.source))) {
          throw notFound();
        }
        return {
          kind: 'language',
          to: { ...canonical, lang: languages.source },
        };
      }
      const readable: StableAddress[] = [];
      for (const l of configured) {
        if (await content.seesManualIn(audience, l)) {
          readable.push({ ...canonical, lang: l });
        }
      }
      if (readable.length === 0) throw notFound();
      return {
        kind: 'picker',
        title: textIn(manifest.title, languages.source, languages.source),
        lang: languages.source,
        languages: readable,
      };
    }
    if (!(await content.seesManualIn(audience, lang))) throw notFound();
    if (moved || lang !== address.lang) {
      return { kind: 'moved', to: { ...canonical, lang } };
    }
    if (address.revision !== undefined && release.withdrawal) {
      const latest = await this.releases.latest(address.product);
      return {
        kind: 'withdrawn',
        release,
        title: textIn(manifest.title, lang, languages.source),
        lang,
        latest: latest && latestOf(canonical),
      };
    }
    return {
      kind: 'found',
      release,
      content,
      manualId: found.id,
      manifest,
      address: canonical,
      pinned: { ...canonical, revision: release.revision },
    };
  }
}

/** A stable address's PDF: the release's output, as `GET …/outputs/:id/file` serves it. */
export interface AddressPdf {
  readonly output: ReleaseOutput;
  readonly blob: StoredBlob;
  readonly fileName: string;
}

/**
 * The PDF of a found stable address (#450): the release's output of the manual, variant and
 * language (#249), never rendered on request, for a reader one of whose roles covers all of
 * the manual (`seesWholeManualIn`, as the outputs routes judge it; else not found). 409
 * `output-not-ready` while it is being rendered.
 */
@Injectable()
export class StableAddressPdfAction extends ActorAction<
  { actor: Actor; found: FoundAddress },
  AddressPdf
> {
  readonly policy = 'content.read';

  constructor(
    private readonly outputs: ReleaseOutputStore,
    private readonly blobs: BlobStore,
  ) {
    super();
  }

  protected async run({
    found,
  }: {
    actor: Actor;
    found: FoundAddress;
  }): Promise<AddressPdf> {
    const { release, content, address } = found;
    const output = await this.outputs.findOf(release.id, {
      manualId: found.manualId,
      variant: address.variant,
      lang: address.lang,
      kind: 'pdf',
    });
    if (
      !output ||
      !(await content.seesWholeManualIn(
        output.audience ?? undefined,
        output.lang,
      ))
    ) {
      throw notFound();
    }
    if (output.state !== 'done' || output.sha256 === null) {
      throw new ConflictError(
        'output-not-ready',
        `The PDF is ${output.state}, not ready yet; try again in a moment.`,
        { state: output.state },
      );
    }
    const blob = await this.blobs.get(output.sha256);
    if (!blob) throw notFound();
    return {
      output,
      blob,
      fileName: outputFileName(output, release.revision),
    };
  }
}
