import { createHash } from 'node:crypto';
import {
  type Attachment,
  type Module,
  ProjectConfig,
} from '@openfolia/content-model';
import { OpenReleasedSnapshotsAction } from '../../src/content/core/actions/open-released-snapshots.action.js';
import { DownloadObservations } from '../../src/downloads/core/download-reads.js';
import { DownloadFileAction } from '../../src/downloads/core/actions/download-file.action.js';
import { DownloadVersionsAction } from '../../src/downloads/core/actions/download-versions.action.js';
import { ListDownloadsAction } from '../../src/downloads/core/actions/list-downloads.action.js';
import { ReleaseOutputFileAction } from '../../src/releases/core/actions/release-outputs.action.js';
import { ScheduleReleaseOutputsAction } from '../../src/releases/core/actions/schedule-release-outputs.action.js';
import { ReaderPromotions } from '../../src/releases/core/reader-promotions.js';
import { newReleaseId, type Release } from '../../src/releases/core/release.js';
import type { ReleaseOutput } from '../../src/releases/core/release-output.js';
import {
  config as baseConfig,
  manifest,
  type FakeContent,
} from './fake-content.js';
import { FakeBlobStore } from './fake-blob-store.js';
import { FakeHistory } from './fake-history.js';
import { FakeJobQueue } from './fake-job-queue.js';
import { FakeReleaseOutputStore } from './fake-release-output-store.js';
import { FakeReleaseStore } from './fake-release-store.js';
import { FakeUnitOfWork } from './fake-unit-of-work.js';
import {
  PACKAGE_MANUAL,
  packageVariant,
} from '../../src/releases/core/release-output.js';

/** Two audiences and a product facet with two products, for the download centre's specs (#139). */
export const downloadsConfig = ProjectConfig.parse({
  ...baseConfig,
  audiences: [
    { id: 'public', label: 'Public' },
    { id: 'internal', label: 'Internal' },
  ],
  facets: [
    {
      id: 'product-line',
      label: 'Product line',
      values: [
        { id: 'tuggers', label: 'Tuggers' },
        { id: 'lifts', label: 'Lifts' },
      ],
    },
  ],
});

export const sha256 = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

/** An attachment block of a file whose bytes are `bytes`. */
export function attachment(
  id: string,
  bytes: string,
  extra: Partial<Attachment> = {},
): Attachment {
  return {
    type: 'attachment',
    id,
    asset: `sha256:${sha256(bytes)}`,
    name: `Name of ${id}`,
    fileName: `${id}.zip`,
    mediaType: 'application/zip',
    size: bytes.length,
    ...extra,
  };
}

/** A module holding `blocks`, of `audience`, for `products` (none: every product). */
export function withAttachments(
  id: string,
  blocks: Attachment[],
  {
    lang = 'en',
    audience = 'public',
    products,
  }: { lang?: string; audience?: string; products?: string[] } = {},
): Module {
  return {
    schemaVersion: 1,
    id,
    meta: {
      title: `Title of ${id}`,
      type: 'concept',
      lang,
      audience,
      facets: products ? { 'product-line': products } : {},
    },
    blocks: [
      { type: 'paragraph', id: 'p', content: [{ type: 'text', text: 'Hi.' }] },
      // Nested: a section holding the attachments.
      {
        type: 'section',
        id: 'files',
        title: [{ type: 'text', text: 'Files' }],
        blocks,
      },
    ],
  } as Module;
}

/** A history, its release store, outputs and blobs, and the download centre's actions over them. */
export function downloadsSetup(content: FakeContent) {
  const history = new FakeHistory({ config: downloadsConfig, ...content });
  const store = new FakeReleaseStore();
  const outputs = new FakeReleaseOutputStore();
  const blobs = new FakeBlobStore();
  const jobs = new FakeJobQueue();
  const unit = new FakeUnitOfWork();
  const observations = new DownloadObservations();
  const outputFile = new ReleaseOutputFileAction(
    store,
    outputs,
    history.openSnapshot,
    blobs,
    new ScheduleReleaseOutputsAction(outputs, jobs, unit),
    // Each reader's promotions a minute (#497), as the release page's route counts them.
    new ReaderPromotions(),
  );
  const list = new ListDownloadsAction(store, outputs, history.openSnapshot);
  const released = new OpenReleasedSnapshotsAction(history);
  const versions = new DownloadVersionsAction(
    store,
    outputs,
    released,
    observations,
  );
  const file = new DownloadFileAction(
    store,
    outputs,
    history.openSnapshot,
    blobs,
    outputFile,
  );
  let at = Date.parse('2026-03-01T10:00:00Z');
  /** A release of `product` at a new commit on `main` holding `next` (else what `main` holds). */
  const release = (
    revision: string,
    next: FakeContent = content,
    extra: Partial<Release> = {},
    product = 'tuggers',
  ): Release => {
    const commit = history.onMain({ config: downloadsConfig, ...next }).commit;
    const tag = `release/${product}/${revision}`;
    history.tag(tag, commit);
    at += 1000;
    const r: Release = {
      id: newReleaseId(at),
      product,
      productFacet: 'product-line',
      revision,
      tag,
      tagObject: 'e'.repeat(40),
      commit,
      notes: `Notes of ${revision}`,
      notesByLanguage: {},
      major: false,
      publishedBy: { kind: 'user', id: 'sample-publisher' },
      publishedAt: new Date(at),
      withdrawal: null,
      ...extra,
    };
    store.rows.push(r);
    // The fake keeps withdrawals beside the rows, as the table does.
    if (r.withdrawal) store.withdrawals.set(r.id, r.withdrawal);
    return r;
  };
  let outputs_ = 0;
  /** A PDF of the release, `done` with a file of `bytes` (or in `state`). */
  const output = (
    release: Release,
    manualId: string,
    bytes: string,
    {
      lang = 'en',
      variant = 'model=small',
      audience = 'public',
      state = 'done',
    }: {
      lang?: string;
      variant?: string;
      audience?: string | null;
      state?: ReleaseOutput['state'];
    } = {},
  ): ReleaseOutput => {
    const now = new Date();
    const done = state === 'done';
    const row: ReleaseOutput = {
      id: newReleaseId(Date.parse('2026-04-01T00:00:00Z') + ++outputs_),
      releaseId: release.id,
      manualId,
      variant,
      lang,
      kind: 'pdf',
      audience,
      state,
      sha256: done ? sha256(bytes) : null,
      size: done ? bytes.length : null,
      error: null,
      reusedFrom: null,
      attempts: 1,
      retries: 0,
      createdAt: now,
      updatedAt: now,
      finishedAt: done ? now : null,
      scheduledAt: null,
      promotedAt: null,
      reuseGroup: null,
      qrCode: null,
    };
    outputs.rows.push(row);
    return row;
  };
  /**
   * A done offline package of the release (#59), as planning makes one: no
   * manual (`*`), its level as its variant, `kind` `offline-package`.
   */
  const offlinePackage = (
    release: Release,
    bytes: string,
    { lang = 'en', audience = 'public' } = {},
  ): ReleaseOutput => {
    const row = output(release, PACKAGE_MANUAL, bytes, {
      lang,
      audience,
      variant: packageVariant(audience),
    });
    const kept = { ...row, kind: 'offline-package' as const };
    outputs.rows[outputs.rows.indexOf(row)] = kept;
    return kept;
  };
  /** Stores `bytes` in the blob store, as an upload would. */
  const store_ = async (bytes: string, contentType = 'application/zip') => {
    await blobs.put(
      (async function* () {
        yield Buffer.from(bytes);
      })(),
      { contentType, maxBytes: 1_000_000 },
    );
  };
  return {
    history,
    store,
    outputs,
    blobs,
    jobs,
    observations,
    list,
    versions,
    file,
    release,
    output,
    offlinePackage,
    put: store_,
    manifest,
  };
}
