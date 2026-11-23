import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import {
  InvalidContentError,
  NotFoundError,
} from '../../../base/core/errors.js';
import type { ReadableContent } from '../../../content/core/readable-content.js';
import { sniffImageType } from '../sniff-image-type.js';

/** A safety symbol's artwork, as served. */
export interface SymbolArtwork {
  readonly bytes: Uint8Array;
  /** `image/svg+xml` or `image/png`, from the bytes. */
  readonly type: string;
}

/** What a symbol's file must hold, by its extension. */
const TYPE_OF: Record<string, string> = {
  svg: 'image/svg+xml',
  png: 'image/png',
};

/**
 * A configured safety symbol's artwork (`symbols/<id>.svg` or `.png` in the
 * repository, as the PDF renders it) at the snapshot's commit (#208).
 * Symbols are configuration: every reader of the commit may read them, as
 * they read `GET /config`. Not found when the ID is not configured or has no
 * artwork. The type comes from the bytes, never the name: a file whose bytes
 * are not what its extension says (an `.svg` that is no SVG, a `.png` that
 * is no PNG) is invalid content, never served under either type.
 */
@Injectable()
export class GetSymbolAction extends ActorAction<
  { actor: Actor; snapshot: ReadableContent; id: string },
  SymbolArtwork
> {
  readonly policy = 'content.read';

  protected async run({
    snapshot,
    id,
  }: {
    snapshot: ReadableContent;
    id: string;
  }): Promise<SymbolArtwork> {
    const file = await snapshot.symbolFile(id);
    if (!file) {
      throw new NotFoundError(`No artwork for the safety symbol "${id}".`);
    }
    const type = sniffImageType(file.bytes);
    const extension = file.path.slice(file.path.lastIndexOf('.') + 1);
    if (TYPE_OF[extension] !== type) {
      throw new InvalidContentError(
        file.path,
        `${file.path} is not ${extension === 'svg' ? 'an SVG' : 'a PNG'} image.`,
      );
    }
    return { bytes: file.bytes, type };
  }
}
