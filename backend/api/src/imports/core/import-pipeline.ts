import {
  type ImportBundle,
  type ImportValidation,
  ProjectConfig,
  validateImport,
  walk,
} from '@openfolia/content-model';
import { Injectable } from '@nestjs/common';
import type { Actor } from '../../access/core/actor.js';
import { UnprocessableError } from '../../base/core/errors.js';
import { ReadableAssets } from '../../assets/core/readable-assets.js';
import { BlobStore } from '../../blobs/core/blob-store.js';
import { BRANCH_PREFIX } from '../../change-sets/core/change-set.js';
import { ChangeSetBranches } from '../../change-sets/core/change-set-branches.js';
import { workingCopyBytes } from '../../change-sets/core/working-copy.js';
import { workingCopySubject } from '../../change-sets/core/working-copy-rules.js';
import { OpenSnapshotAction } from '../../content/core/actions/open-snapshot.action.js';
import { ReadableRefs } from '../../content/core/readable-refs.js';
import {
  type ImportReport,
  ImportSettings,
  MAX_IMPORT_ITEMS,
  MAX_IMPORT_VALUES,
} from './import.js';
import type { ImportPlan, PlannedUpload, PlannedWrite } from './import-plan.js';
import { planWithRest } from './import-rest.js';
import type { Importer, ImportFile } from './importer.js';

export interface CheckInput {
  readonly importer: Importer;
  /** The importer's options, as its schema parsed them. */
  readonly options: unknown;
  readonly file: ImportFile;
  /** The target branch; the server's default branch when left out. */
  readonly baseRef?: string;
  readonly updateExisting: boolean;
}

export interface Checked {
  readonly plan: ImportPlan;
  /** The branch checked against, and its commit then. */
  readonly baseRef: string;
  readonly baseCommit: string;
}

/**
 * The steps every import goes through before anything is written: the
 * importer makes the bundle (`toBundle`, within the settings' limits),
 * the content model's validator checks it against the configuration at
 * the target branch, the module and manual IDs there and the stored files
 * the importer may read (`ReadableAssets.storedFor`),
 * and `planImport` decides item by item; with refused items, the bundle
 * without them is checked again, to tell whether the rest can be applied
 * alone (`planWithRest`, #758). A dry run stops here; applying
 * runs it again in its job, so what is written is what the target holds
 * then.
 */
@Injectable()
export class ImportPipeline {
  constructor(
    private readonly refs: ReadableRefs,
    private readonly branches: ChangeSetBranches,
    private readonly openSnapshot: OpenSnapshotAction,
    private readonly blobs: BlobStore,
    private readonly readable: ReadableAssets,
    private readonly settings: ImportSettings,
  ) {}

  /** The bundle of `file`, by the importer, within the limits, for the target's configuration. */
  bundle(
    input: Pick<CheckInput, 'importer' | 'options' | 'file'>,
    config: ProjectConfig,
  ) {
    return input.importer.toBundle(
      input.file,
      input.options,
      {
        maxFiles: this.settings.maxFiles,
        maxUnpackedBytes: this.settings.maxUnpackedBytes,
        maxPathDepth: this.settings.maxPathDepth,
      },
      { config },
    );
  }

  async check(actor: Actor, input: CheckInput): Promise<Checked> {
    const branch = await this.base(actor, input.baseRef);
    const snapshot = await this.openSnapshot.handle({ actor, ref: branch });
    const config = await snapshot.config();
    const bundle = await this.bundle(input, config);
    const modules = new Set((await snapshot.modules()).map((m) => m.id));
    const manuals = new Set((await snapshot.manuals()).map((m) => m.id));
    const existing = {
      modules,
      manuals,
      // Files already stored that the importer may read may be referred
      // to without being carried; any other is reported missing (#332).
      assets: this.readable.storedFor(actor, snapshot, this.blobs),
    };
    const plan = await planWithRest(
      bundle,
      (checked) =>
        validateImport(checked, config, {
          existing,
          maxDepth: this.settings.maxJsonDepth,
          maxDocumentBytes: this.settings.maxDocumentBytes,
          maxItems: MAX_IMPORT_ITEMS,
          maxValues: MAX_IMPORT_VALUES,
        }),
      {
        actor,
        snapshot,
        config,
        updateExisting: input.updateExisting,
        settings: this.settings,
      },
    );
    return { plan, baseRef: branch, baseCommit: snapshot.commit };
  }

  /**
   * The writes and uploads a checked report decided, from the same bundle
   * again (a retried job, after its change set holds some of them): the
   * report's decisions, not a new check, since the change set's own
   * commits would now read as clashes.
   */
  async replay(
    input: Pick<CheckInput, 'importer' | 'options' | 'file'>,
    report: ImportReport,
    config: ProjectConfig,
  ): Promise<Pick<ImportPlan, 'writes' | 'uploads'>> {
    const sourceLanguage = config.languages.source;
    const bundle = await this.bundle(input, config);
    const validation = await validateImport(bundle, EMPTY_CHECK_CONFIG, {
      maxDepth: this.settings.maxJsonDepth,
      maxDocumentBytes: this.settings.maxDocumentBytes,
      maxItems: MAX_IMPORT_ITEMS,
      maxValues: MAX_IMPORT_VALUES,
    });
    return replayPlan(bundle, validation, report, sourceLanguage);
  }

  /** The target branch, as the actor may know of it; 422 `invalid-base` otherwise. */
  private async base(actor: Actor, requested: string | undefined) {
    const name = requested ?? (await this.branches.defaultBase());
    if (name === undefined) {
      throw new UnprocessableError(
        'invalid-base',
        'Give baseRef: the server’s default ref (CCMS_DEFAULT_REF) names no branch.',
      );
    }
    if (name.startsWith(BRANCH_PREFIX)) {
      throw new UnprocessableError(
        'invalid-base',
        'An import goes into a new change set, which cannot start from another change set’s branch.',
      );
    }
    // A draft branch the actor may not read is refused exactly like a
    // missing one, as for a change set.
    const branch = await this.refs.branch(actor, name);
    if (!branch) {
      throw new UnprocessableError(
        'invalid-base',
        requested === undefined
          ? 'The server’s default ref (CCMS_DEFAULT_REF) names no branch to import into; give baseRef.'
          : `There is no branch "${name}" to import into.`,
      );
    }
    return branch.name;
  }
}

/**
 * The configuration a replay parses with: only the parsed modules and
 * manifests are used (their checks were made when the report was), so
 * any valid configuration does.
 */
const EMPTY_CHECK_CONFIG = ProjectConfig.parse({
  languages: { source: 'en', targets: [] },
  moduleTypes: [{ id: 'replay', label: 'Replay' }],
  audiences: [{ id: 'replay', label: 'Replay' }],
});

/** `replay`, on a bundle already read and parsed. */
export function replayPlan(
  bundle: ImportBundle,
  validation: ImportValidation,
  report: ImportReport,
  sourceLanguage: string,
): Pick<ImportPlan, 'writes' | 'uploads'> {
  const decided = new Map(report.items.map((item) => [item.pointer, item]));
  const writes: PlannedWrite[] = [];
  for (const item of validation.items) {
    const was = decided.get(item.pointer);
    if (!was || was.kind !== item.kind || was.id !== item.id) continue;
    if (was.action !== 'create' && was.action !== 'update') continue;
    if (item.kind === 'module' && item.module) {
      const subject = workingCopySubject({
        type: 'module',
        lang: item.module.meta.lang,
        moduleId: item.module.id,
      });
      writes.push({
        subject,
        content: item.module,
        bytes: workingCopyBytes(item.module),
      });
    } else if (item.kind === 'manual' && item.manifest) {
      writes.push({
        subject: workingCopySubject({
          type: 'manual',
          manualId: item.manifest.id,
        }),
        content: item.manifest,
        bytes: workingCopyBytes(item.manifest),
      });
    }
  }
  const order = (w: PlannedWrite) =>
    w.subject.type === 'module'
      ? w.subject.lang === sourceLanguage
        ? 0
        : 1
      : 2;
  const name = (w: PlannedWrite) =>
    w.subject.type === 'module'
      ? `${w.subject.lang}/${w.subject.moduleId}`
      : w.subject.type === 'manual'
        ? w.subject.manualId
        : '';
  writes.sort(
    (a, b) =>
      order(a) - order(b) ||
      (name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0),
  );
  const fileNames = new Map<string, string>();
  for (const { content } of writes) {
    if (!('blocks' in content)) continue;
    for (const { kind, node } of walk(content.blocks)) {
      if (kind === 'block' && node.type === 'attachment') {
        const hash = node.asset.slice('sha256:'.length);
        if (!fileNames.has(hash)) fileNames.set(hash, node.fileName);
      }
    }
  }
  const uploads: PlannedUpload[] = [];
  for (const item of report.items) {
    if (item.kind !== 'asset' || item.action !== 'create') continue;
    const bytes = bundle.files.get(item.pointer);
    const hash = item.id.slice('sha256:'.length);
    if (!bytes) continue;
    const kind = item.usedAs ?? 'attachment';
    const fileName = fileNames.get(hash);
    uploads.push({
      sha256: hash,
      kind,
      ...(kind === 'attachment' && fileName !== undefined && { fileName }),
      bytes,
    });
  }
  uploads.sort((a, b) =>
    a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0,
  );
  return { writes, uploads };
}
