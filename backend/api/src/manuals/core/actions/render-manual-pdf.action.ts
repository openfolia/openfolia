import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  DEFAULT_CALLOUT_LABEL_MIN_SIZE,
  hasLegendBeside,
} from '@openfolia/content-model';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import type {
  ManualResolution,
  RenderSource,
} from '../../../content/core/content.repository.js';
import {
  designFiles,
  type ReadableContent,
  type ReleaseFacts,
} from '../../../content/core/readable-content.js';
import {
  PdfRenderer,
  type PdfExtras,
  type RenderOptions,
} from '../pdf-renderer.js';
import { ResolveManualAction } from './resolve-manual.action.js';

/**
 * What identifies a rendering. The commit fixes the template, symbols and
 * images; what the reader may see (`readingKey`) fixes the rest, and the
 * manual's own hash makes sure: a PDF is shared only between readers of
 * the same scope whose manual is the same. The PDF standard is named too,
 * since a working copy of the configuration can change it at the same commit, and the QR
 * code a release's PDF prints (#450), where and of what. A page design's files (logo,
 * cover image, fonts, region images) are named by hash already, but one may be stored only
 * after a PDF was made without it (#552): which of them are stored now is part of the key, so
 * an upload renders a new PDF.
 */
export async function renderKey(
  input: {
    snapshot: ReadableContent;
    id: string;
    variant: string;
    lang: string;
    qrCode?: PdfExtras['qrCode'];
  },
  resolution: ManualResolution,
  source: Pick<RenderSource, 'hasAsset'>,
): Promise<string> {
  const hash = createHash('sha256').update(JSON.stringify(resolution.manual));
  // The page design (#391) is the PDF's too: a working copy can change it at the same commit.
  if (resolution.design) hash.update(JSON.stringify(resolution.design));
  // Its own template's drafts (#396): a working copy can change the template at the same commit.
  const template = resolution.design?.template;
  if (template !== undefined) {
    hash.update(
      `|template:${template}:${await input.snapshot.designTemplateRevision(template)}`,
    );
  }
  // The smallest size of a callout legend beside its image (#548), when the manual has one.
  if (hasLegendBeside(resolution.manual)) {
    const minSize =
      resolution.config.pdf.calloutLabelMinSize ??
      DEFAULT_CALLOUT_LABEL_MIN_SIZE;
    hash.update(`|callout-label-min-size:${minSize}`);
  }
  const files = designFiles(resolution);
  if (files.length > 0) {
    const stored = await Promise.all(
      files.map((file) => source.hasAsset(file.replace(/^sha256:/, ''))),
    );
    hash.update(
      `|design-files-stored:${files.filter((_, i) => stored[i]).join(',')}`,
    );
  }
  const content = hash.digest('hex');
  return [
    input.snapshot.commit,
    input.id,
    input.variant,
    input.lang,
    input.snapshot.readingKey,
    resolution.config.pdf.standard,
    content,
    ...(input.qrCode
      ? [`qr:${input.qrCode.placement}:${input.qrCode.url}`]
      : []),
  ].join('|');
}

/**
 * A resolved manual as PDF (only the modules the actor may see), with the
 * number of issues resolving found that the actor may see.
 */
@Injectable()
export class RenderManualPdfAction extends ActorAction<
  {
    actor: Actor;
    snapshot: ReadableContent;
    id: string;
    variant: string;
    lang: string;
    /** Another page design than the manual's own (#392). */
    design?: string;
    /** A QR code to print (a release's PDF, #450). */
    qrCode?: PdfExtras['qrCode'];
    /** The release the PDF is made for (#395): what the page design prints of it. */
    release?: ReleaseFacts;
    /** `RenderOptions.background`: bulk work, after what readers wait for. */
    background?: RenderOptions['background'];
  },
  { pdf: Uint8Array; issueCount: number; filename: string }
> {
  readonly policy = 'content.read';

  constructor(
    private readonly resolveManual: ResolveManualAction,
    private readonly renderer: PdfRenderer,
  ) {
    super();
  }

  protected async run(input: {
    actor: Actor;
    snapshot: ReadableContent;
    id: string;
    variant: string;
    lang: string;
    design?: string;
    qrCode?: PdfExtras['qrCode'];
    release?: ReleaseFacts;
    background?: RenderOptions['background'];
  }): Promise<{ pdf: Uint8Array; issueCount: number; filename: string }> {
    const { snapshot, id, variant, lang, background } = input;
    const resolution = await this.resolveManual.handle(input);
    const source = snapshot.renderSource(resolution);
    const key = await renderKey(input, resolution, source);
    const pdf = await this.renderer.render(source, resolution, key, {
      background: background === true,
      ...(input.qrCode ? { qrCode: input.qrCode } : {}),
    });
    return {
      pdf,
      issueCount: resolution.issues.length,
      filename: `${id}-${variant}-${lang}.pdf`,
    };
  }
}
