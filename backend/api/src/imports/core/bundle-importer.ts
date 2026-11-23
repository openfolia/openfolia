import type { ImportBundle } from '@openfolia/content-model';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { UnprocessableError } from '../../base/core/errors.js';
import {
  type ImportContext,
  Importer,
  type ImportFile,
  type ImportLimits,
} from './importer.js';
import { looksLikeZip, readZip } from './zip-archive.js';

/** The built-in importer's ID. */
export const BUNDLE_IMPORTER = 'bundle';

const BundleOptions = z.strictObject({});
type BundleOptions = z.infer<typeof BundleOptions>;

/**
 * The built-in importer: the documented import format itself (a ZIP with
 * `import.json` and `assets/<sha256>`), unpacked safely (`readZip`) and
 * passed on as it is. A converter for another system writes this format;
 * it takes no options.
 */
@Injectable()
export class BundleImporter extends Importer<BundleOptions> {
  readonly id = BUNDLE_IMPORTER;
  readonly label = 'Import bundle';
  readonly description =
    'A ZIP archive in the documented import format: import.json with the modules and manuals, and assets/<sha256> with their files.';
  readonly options = BundleOptions;

  async toBundle(
    file: ImportFile,
    _options: BundleOptions,
    limits: ImportLimits,
    // The bundle is converted already: the target's configuration changes nothing.
    _context: ImportContext,
  ): Promise<ImportBundle> {
    // Decided from the bytes, never from a name or a Content-Type.
    if (!looksLikeZip(file.bytes)) {
      throw new UnprocessableError(
        'invalid-archive',
        'The file is no ZIP archive.',
        { reason: 'not-a-zip' },
      );
    }
    return { files: await readZip(file.bytes, limits) };
  }
}
