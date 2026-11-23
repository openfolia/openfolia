import { Injectable } from '@nestjs/common';
import {
  DEFAULT_PAGE_DESIGN,
  designTemplateDir,
  DesignTemplateId,
  isTemplateFilePath,
  isTemplateTextFile,
  type PageDesign,
} from '@openfolia/content-model';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import {
  InvalidContentError,
  NotFoundError,
} from '../../../base/core/errors.js';
import {
  paginate,
  type PageRequest,
  type Paginated,
} from '../../../base/core/paging.js';
import type { TemplateFileEntry } from '../../../content/core/content.repository.js';
import {
  pastTemplateCaps,
  TEMPLATE_CAPS,
  templateFolderSize,
} from '../../../content/core/template-caps.js';
import type { ReadableContent } from '../../../content/core/readable-content.js';
import {
  PdfRenderer,
  PdfTemplateError,
} from '../../../manuals/core/pdf-renderer.js';

/** A file of a page design template's folder as the template screen lists it (#396). */
export interface TemplateFileListed extends TemplateFileEntry {
  /** Whether the screen edits it as text (`isTemplateTextFile`); an image it only lists. */
  readonly text: boolean;
}

/**
 * The folder as listed against its caps (#803): how many files and bytes it holds (drafts at
 * their length), the caps, and whether it is past them (then it is not compiled).
 */
export interface TemplateFolderListed {
  readonly files: number;
  readonly bytes: number;
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly pastCaps: boolean;
}

/** 404 for a template no file of which is there (also an ID that is no slug). */
function noTemplate(id: string): NotFoundError {
  return new NotFoundError(`No page design template "${id}".`);
}

/**
 * One page of a page design template's files (#396), `templates/<id>/`, by path: each with its
 * size, whether it is text the template screen edits, and (read with `?workingCopy=true`)
 * whether the change set's working copy stands in for it. Only the listing is read: every draft
 * is listed, also past the caps, and `folder` tells the folder's size against them (#803).
 * Templates carry no audience, as page designs: every reader of the commit reads them. 404 when
 * the folder holds no file (nor a working copy of one).
 */
@Injectable()
export class ListDesignTemplateFilesAction extends ActorAction<
  {
    actor: Actor;
    snapshot: ReadableContent;
    templateId: string;
    page: PageRequest;
  },
  Paginated<TemplateFileListed> & { readonly folder: TemplateFolderListed }
> {
  readonly policy = 'content.read';

  protected async run({
    snapshot,
    templateId,
    page,
  }: {
    snapshot: ReadableContent;
    templateId: string;
    page: PageRequest;
  }): Promise<
    Paginated<TemplateFileListed> & { readonly folder: TemplateFolderListed }
  > {
    if (!DesignTemplateId.safeParse(templateId).success) {
      throw noTemplate(templateId);
    }
    const listed = await snapshot.designTemplateListing(templateId);
    if (listed.length === 0) throw noTemplate(templateId);
    // The listing holds each draft in place of its file already.
    const size = templateFolderSize(listed, new Map());
    return {
      ...paginate(
        listed.map((file) => ({
          ...file,
          text: isTemplateFilePath(file.path) && isTemplateTextFile(file.path),
        })),
        page,
      ),
      folder: { ...size, ...TEMPLATE_CAPS, pastCaps: pastTemplateCaps(size) },
    };
  }
}

/** A page design template's text file as read (#396). */
export interface TemplateFileRead {
  readonly path: string;
  readonly text: string;
}

/**
 * One text file of a page design template (#396) by its path in the folder, as committed (or,
 * read with `?workingCopy=true`, the change set's working copy of it): for reading a template
 * outside a change set of one's own. 404 for a path that is no template text file's
 * (`isTemplateFilePath`, `isTemplateTextFile`: never one outside the folder), a file that is not
 * there, or one that is no UTF-8 text.
 */
@Injectable()
export class GetDesignTemplateFileAction extends ActorAction<
  { actor: Actor; snapshot: ReadableContent; templateId: string; path: string },
  TemplateFileRead
> {
  readonly policy = 'content.read';

  protected async run({
    snapshot,
    templateId,
    path,
  }: {
    snapshot: ReadableContent;
    templateId: string;
    path: string;
  }): Promise<TemplateFileRead> {
    const missing = () =>
      new NotFoundError(
        `No text file "${path}" in the template "${templateId}".`,
      );
    if (
      !DesignTemplateId.safeParse(templateId).success ||
      !isTemplateFilePath(path) ||
      !isTemplateTextFile(path)
    ) {
      throw missing();
    }
    const data = await snapshot.designTemplateFile(templateId, path);
    if (data === undefined) throw missing();
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    } catch {
      throw missing();
    }
    // As the working copy reads it (`textOf`): text holding NUL is no text the screen edits.
    if (text.includes('\0')) throw missing();
    return { path, text };
  }
}

export interface PreviewDesignTemplateInput {
  readonly actor: Actor;
  readonly snapshot: ReadableContent;
  readonly templateId: string;
  /** The page design to lay the probe out with; the built-in design when left out. */
  readonly designId?: string;
  readonly page: number;
  readonly width: number;
}

/**
 * The template screen's live preview (#396): one page of the renderer's small manual that uses
 * every function of the template contract (`templateProbe`), laid out with a page design (the
 * one named, else the built-in design) and the template `templateId` in place of the design's
 * own, as PNG. Read with `?workingCopy=true`, the change set's working copies of the template's
 * files stand in for theirs, so its author sees what they edit before a save point.
 *
 * The template compiles in the renderer's sandbox as every own template does: it reads its own
 * folder's files and the design's stored files, nothing of the host or the network, within the
 * time and memory limits. A template that does not compile is 422 `template-error` with its
 * problems (file, line, column, message), as the PDF route answers it; a folder past the caps
 * (`MAX_TEMPLATE_FILES`, `MAX_TEMPLATE_BYTES`) too. 404 when the template has no `manual.typ`,
 * the design is not there, or past the last page (`meta.pages`).
 */
@Injectable()
export class PreviewDesignTemplateAction extends ActorAction<
  PreviewDesignTemplateInput,
  Uint8Array
> {
  readonly policy = 'content.read';

  constructor(private readonly renderer: PdfRenderer) {
    super();
  }

  protected async run({
    snapshot,
    templateId,
    designId,
    page,
    width,
  }: PreviewDesignTemplateInput): Promise<Uint8Array> {
    if (!DesignTemplateId.safeParse(templateId).success) {
      throw noTemplate(templateId);
    }
    let named: PageDesign | undefined;
    if (designId !== undefined) {
      named = await snapshot.pageDesign(designId);
      if (!named) throw new NotFoundError(`No page design "${designId}".`);
    }
    const design: PageDesign = {
      ...(named ?? DEFAULT_PAGE_DESIGN),
      template: templateId,
    };
    let files: Record<string, Uint8Array> | undefined;
    try {
      files = await snapshot.designTemplate(templateId);
    } catch (error) {
      if (!(error instanceof InvalidContentError)) throw error;
      // Past the caps: told from the listing, nothing is compiled.
      throw new PdfTemplateError(design.id, templateId, [
        {
          file: designTemplateDir(templateId),
          line: 0,
          column: 0,
          message: error.message,
          trace: [],
        },
      ]);
    }
    if (!files) throw noTemplate(templateId);
    return this.renderer.previewDesignTemplate({
      design,
      config: await snapshot.config(),
      files,
      asset: (hash) =>
        designId === undefined
          ? Promise.resolve(undefined)
          : snapshot.pageDesignAsset(designId, hash),
      page: { number: page, width },
    });
  }
}

/**
 * The renderer's example template (#396), file by file with its text, by path: what the template
 * screen's "New template" starts from (its working copies). Laid out as the built-in layout, so a
 * copy prints what the layout prints. Read by whoever reads content; nothing of the repository.
 */
@Injectable()
export class GetExampleDesignTemplateAction extends ActorAction<
  { actor: Actor; page: PageRequest },
  Paginated<TemplateFileRead>
> {
  readonly policy = 'content.read';

  constructor(private readonly renderer: PdfRenderer) {
    super();
  }

  protected run({
    page,
  }: {
    page: PageRequest;
  }): Promise<Paginated<TemplateFileRead>> {
    const files = Object.entries(this.renderer.exampleDesignTemplate())
      .map(([path, text]) => ({ path, text }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return Promise.resolve(paginate(files, page));
  }
}
