import { Injectable } from '@nestjs/common';
import {
  directionOf,
  type ProjectConfig,
  type VariantValues,
} from '@openfolia/content-model';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import {
  NotFoundError,
  UnprocessableError,
} from '../../../base/core/errors.js';
import type { ManualResolution } from '../../../content/core/content.repository.js';
import type { ReadableContent } from '../../../content/core/readable-content.js';
import { refuseTooLarge } from '../../../manuals/core/too-large.js';
import { HtmlRenderer, type HtmlRenderOptions } from '../html-renderer.js';
import type { Preview } from './preview-manual.action.js';

interface Input {
  actor: Actor;
  snapshot: ReadableContent;
  id: string;
  lang: string;
  /** The variant to resolve conditions for; none: no attribute is set. */
  variant?: VariantValues;
  assetUrl: HtmlRenderOptions['assetUrl'];
  /** Where a safety symbol's artwork is read; used for the symbols that have one. */
  symbolUrl: (id: string) => string;
}

/**
 * One module as HTML in one language, with the conditions inside it applied
 * for a variant. A module outside the actor's reading scope is not found,
 * exactly as if it did not exist. The variant must name configured
 * attributes and values (a version attribute: a dotted number), so a typo is
 * an error, not an empty preview.
 */
@Injectable()
export class PreviewModuleAction extends ActorAction<Input, Preview> {
  readonly policy = 'content.read';

  constructor(private readonly renderer: HtmlRenderer) {
    super();
  }

  protected async run({
    snapshot,
    id,
    lang,
    variant = {},
    assetUrl,
    symbolUrl,
  }: Input): Promise<Preview> {
    const resolution = await resolveModuleFor(snapshot, id, lang, variant);
    const symbols = await symbolUrlsFor(snapshot, symbolUrl);
    const missing = () => new NotFoundError(`No module "${id}" in "${lang}".`);
    // The editor's preview: page breaks show, and so do the text attributes
    // a module on its own has no values for (a manual gives them).
    const fragment = this.renderer.module(resolution, id, {
      assetUrl,
      symbolUrl: symbols,
      editorView: true,
    });
    // The module is the only entry, so it is there unless resolving left it out.
    if (!fragment) throw missing();
    return {
      html: fragment.html,
      title: resolution.manual.title,
      lang: resolution.manual.lang,
      dir: directionOf(resolution.manual, resolution.manual.lang),
      issueCount: resolution.issues.length,
    };
  }
}

/**
 * `symbolUrl` for the symbols that have artwork at the snapshot's commit
 * (`ReadableContent.symbolArtwork`); undefined for any other, so the HTML
 * leaves it out rather than showing a broken image.
 */
export async function symbolUrlsFor(
  snapshot: ReadableContent,
  symbolUrl: (id: string) => string,
): Promise<(id: string) => string | undefined> {
  const artwork = await snapshot.symbolArtwork();
  return (id) => (artwork.has(id) ? symbolUrl(id) : undefined);
}

/**
 * One module on its own, resolved for a variant (configured attributes and
 * values only: a typo is a 422, not an empty preview). Not found, alike,
 * when the actor may not see it or it does not exist in `lang`. 422
 * `expansion-too-large` when its module references expand past the limit (#679).
 */
export async function resolveModuleFor(
  snapshot: ReadableContent,
  id: string,
  lang: string,
  variant: VariantValues,
): Promise<ManualResolution> {
  checkVariant(variant, await snapshot.config());
  const resolution = await snapshot.resolveModule(id, variant, lang);
  if (!resolution) throw new NotFoundError(`No module "${id}" in "${lang}".`);
  refuseTooLarge(resolution);
  return resolution;
}

/**
 * 422 `unknown-variant` for a variant naming an attribute the configuration
 * does not hold, a value an enum attribute does not have, or a version
 * that is not dotted numbers.
 */
export function checkVariant(
  variant: VariantValues,
  config: ProjectConfig,
): void {
  for (const [key, value] of Object.entries(variant)) {
    const attribute = config.variantAttributes.find((a) => a.id === key);
    const problem = !attribute
      ? `"${key}" is not a variant attribute.`
      : attribute.kind === 'enum' &&
          !attribute.values.some((v) => v.id === value)
        ? `"${value}" is not a value of "${key}".`
        : attribute.kind === 'version' && !/^\d+(\.\d+)*$/.test(value)
          ? `"${value}" is not a version (dotted numbers) for "${key}".`
          : undefined;
    if (problem) throw new UnprocessableError('unknown-variant', problem);
  }
}
