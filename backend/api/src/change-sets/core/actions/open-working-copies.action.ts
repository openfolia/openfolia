import { createHash } from 'node:crypto';
import {
  MAX_TEMPLATE_BYTES,
  utf8Length,
  type Manifest,
  type Module,
  type PageDesign,
  type ProjectConfig,
} from '@openfolia/content-model';
import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import {
  allows,
  allowsManual,
  moduleTarget,
} from '../../../access/core/allows.js';
import { ActorAction } from '../../../access/core/policy.js';
import { AssetUploads } from '../../../assets/core/asset-uploads.js';
import { ConflictError } from '../../../base/core/errors.js';
import { UnitOfWork } from '../../../base/core/unit-of-work.js';
import { OpenSnapshotAction } from '../../../content/core/actions/open-snapshot.action.js';
import type { ContentOverlay } from '../../../content/core/content-overlay.js';
import type { ReadableContent } from '../../../content/core/readable-content.js';
import { refusePastTemplateCaps } from '../../../content/core/template-caps.js';
import { ChangeSetStore } from '../change-set-store.js';
import { LockSubject } from '../lock.js';
import { draftReadPermission } from '../own-work.js';
import type { DraftManifest, TemplateFileContent } from '../working-copy.js';
import { authorsChangeSet } from '../working-copy-rules.js';
import {
  WorkingCopyStore,
  type WorkingCopySize,
} from '../working-copy-store.js';

/** The 403's detail for another author's change set (to a reader of drafts). */
export const LIVE_PREVIEW_AUTHOR_ONLY =
  'Only its author previews a change set’s working copies.';

export interface OpenWorkingCopiesInput {
  readonly actor: Actor;
  readonly changeSetId: string;
}

export interface OpenedWorkingCopies {
  /** The change set's branch with its working copies in place of their files. */
  readonly content: ReadableContent;
  /** The images uploaded into the change set (SHA-256, hex): its author's to see. */
  readonly uploaded: ReadonlySet<string>;
}

/**
 * A working copy that was there when the branch was opened is gone (a save point committed it, it
 * was discarded): what is read now would be neither it nor the commit. Opening the working copies
 * again reads the one that holds. Reaches a client (409) only when that happened again and again.
 */
export class WorkingCopyGoneError extends ConflictError {
  constructor() {
    super(
      'working-copy-changed',
      'A working copy was committed or discarded while it was read; read it again.',
    );
  }
}

/**
 * A change set's branch as its author's live preview reads it (#237): every
 * working copy of the change set in place of its file, a module's and a
 * manual's alike, so module references resolve to their own working copies
 * where there are any, else to the branch. Only for the change set's
 * author, answered as reading a working copy is (`authorsChangeSet`: 403
 * for anyone else who may read drafts, 404 for anyone who may not).
 *
 * A working copy stands in only where its author may read it as `GET
 * …/working-copy` would (`draftReadPermission`); `ReadableContent` filters
 * what is read through it again, as it filters files. Images: those a
 * module the author may see on the branch shows, and those uploaded into
 * the change set; any other hash a draft names is not read.
 *
 * The order is what makes it one state (#935): the working copies are listed first, then the
 * branch is opened. A save point moves the branch before it drops the copies it committed, so a
 * copy not listed is on the branch opened; one listed and then gone is a `WorkingCopyGoneError`
 * of the read, which opens again (`WorkingCopyInterceptor`).
 */
@Injectable()
export class OpenWorkingCopiesAction extends ActorAction<
  OpenWorkingCopiesInput,
  OpenedWorkingCopies
> {
  readonly policy = 'content.read';

  constructor(
    private readonly changeSets: ChangeSetStore,
    private readonly workingCopies: WorkingCopyStore,
    private readonly unit: UnitOfWork,
    private readonly uploads: AssetUploads,
    private readonly openSnapshot: OpenSnapshotAction,
  ) {
    super();
  }

  protected async run({
    actor,
    changeSetId,
  }: OpenWorkingCopiesInput): Promise<OpenedWorkingCopies> {
    const changeSet = await authorsChangeSet(
      this.changeSets,
      actor,
      changeSetId,
      LIVE_PREVIEW_AUTHOR_ONLY,
    );
    const sizes = await this.unit.run((tx) =>
      this.workingCopies.sizesOf(tx, changeSet.id),
    );
    const snapshot = await this.openSnapshot.handle({
      actor,
      ref: changeSet.branch,
      fresh: true,
    });
    const config = await snapshot.config();
    const uploaded = new Set(
      (await this.uploads.list(changeSet.id)).map((u) => u.sha256),
    );
    const overlay = this.overlayFor(
      actor,
      changeSet.id,
      sizes,
      config,
      uploaded,
    );
    return { content: snapshot.withOverlay(overlay), uploaded };
  }

  private overlayFor(
    actor: Actor,
    changeSetId: string,
    sizes: readonly WorkingCopySize[],
    config: ProjectConfig,
    uploaded: ReadonlySet<string>,
  ): ContentOverlay {
    const permission = draftReadPermission(actor);
    const find = async (subject: unknown) => {
      // Names come from requests and from authored text: only a subject a lock could be on.
      const parsed = LockSubject.safeParse(subject);
      if (!parsed.success) return undefined;
      const copy = await this.workingCopies.find(changeSetId, parsed.data);
      // Asked only for what was listed.
      if (!copy) throw new WorkingCopyGoneError();
      return copy;
    };
    const templateText = async (templateId: string, path: string) => {
      const copy = await find({ type: 'template', templateId, path });
      const text = (copy?.content as TemplateFileContent | undefined)?.text;
      return typeof text === 'string' ? text : undefined;
    };
    const subjects: Awaited<ReturnType<ContentOverlay['subjects']>> = {
      modules: sizes.flatMap(({ subject }) =>
        subject.type === 'module'
          ? [{ id: subject.moduleId, lang: subject.lang }]
          : [],
      ),
      manuals: sizes.flatMap(({ subject }) =>
        subject.type === 'manual' ? [subject.manualId] : [],
      ),
      designs: sizes.flatMap(({ subject }) =>
        subject.type === 'design' ? [subject.designId] : [],
      ),
      templates: sizes.flatMap(({ subject, textBytes }) =>
        subject.type === 'template'
          ? [
              {
                templateId: subject.templateId,
                path: subject.path,
                size: textBytes ?? 0,
              },
            ]
          : [],
      ),
    };
    return {
      // The uploads are part of what the overlay shows (an image a draft names may arrive later):
      // a cache keyed by it never serves a render made before one of them was there.
      key: `working-copies:${changeSetId}:${createHash('sha256')
        .update([...uploaded].sort().join(','))
        .digest('hex')}`,
      module: async (id, lang) => {
        // Only what there is a draft of is read: a manual names many modules.
        const { modules } = subjects;
        if (!modules.some((m) => m.id === id && m.lang === lang))
          return undefined;
        const copy = await find({ type: 'module', lang, moduleId: id });
        if (!copy) return undefined;
        const module = copy.content as Module;
        // The subject's own text (a save checks it names its path), seen as GET would.
        if (module.id !== id || module.meta.lang !== lang) return undefined;
        return allows(actor, permission, moduleTarget(module.meta, config))
          ? module
          : undefined;
      },
      manifest: async (id) => {
        const { manuals } = subjects;
        if (!manuals.includes(id)) return undefined;
        const copy = await find({ type: 'manual', manualId: id });
        if (!copy) return undefined;
        const manifest = copy.content as DraftManifest;
        if (manifest.id !== id) return undefined;
        return allowsManual(actor, permission, {
          audiences: config.audiences.map((a) => a.id),
          audience: manifest.audience,
          lang: undefined,
        })
          ? (manifest as Manifest)
          : undefined;
      },
      // Designs carry no audience (#390): every reader of the branch reads them, and the
      // author reads their own draft of one as `GET …/working-copy` does.
      pageDesign: async (id) => {
        const { designs } = subjects;
        if (!designs.includes(id)) return undefined;
        const copy = await find({ type: 'design', designId: id });
        if (!copy) return undefined;
        const design = copy.content as PageDesign;
        return design.id === id ? design : undefined;
      },
      // Templates carry no audience (#396), as designs: the author reads their own drafts.
      // The snapshot reads them all only once their lengths (`subjects`) keep the folder within
      // the caps (#803). A draft saved longer since its length was listed counts at the length
      // read: past the caps the folder is refused (the repository's `InvalidContentError`), never
      // given in part, and no draft that would take the drafts past them is read.
      templateFiles: async (id) => {
        const { templates } = subjects;
        const files = new Map<string, string>();
        let bytes = 0;
        for (const { path, size } of templates.filter(
          (t) => t.templateId === id,
        )) {
          if (bytes + size > MAX_TEMPLATE_BYTES) {
            refusePastTemplateCaps(id, {
              files: files.size + 1,
              bytes: bytes + size,
            });
          }
          const text = await templateText(id, path);
          if (text === undefined) continue;
          files.set(path, text);
          bytes += utf8Length(text);
          refusePastTemplateCaps(id, { files: files.size, bytes });
        }
        return files;
      },
      templateFile: async (id, path) => {
        const { templates } = subjects;
        return templates.some((t) => t.templateId === id && t.path === path)
          ? templateText(id, path)
          : undefined;
      },
      subjects: () => Promise.resolve(subjects),
      showsAsset: (hash) => Promise.resolve(uploaded.has(hash)),
    };
  }
}
