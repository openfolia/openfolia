import type { ImportBundle } from '@openfolia/content-model';
import {
  ConversionLimitError,
  convertDitaIsolated,
  type IsolationLimits,
} from '@openfolia/dita';
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

/** The DITA importer's ID. */
export const DITA_IMPORTER = 'dita';

/**
 * The bounds of a DITA conversion's own process (`CCMS_IMPORT_CONVERT_*`):
 * its heap and its time. Provided by the module from the environment.
 */
export abstract class DitaConversionSettings implements IsolationLimits {
  abstract readonly maxMemoryMb: number;
  abstract readonly timeoutMs: number;
  /** `CCMS_IMPORT_MAX_DOCUMENT_BYTES`: the child answers with no larger `import.json`. */
  abstract readonly maxDocumentBytes: number;
}

const DitaOptions = z.strictObject({});
type DitaOptions = z.infer<typeof DitaOptions>;

/**
 * A DITA 1.3 project (#432): a ZIP of its maps, topics, images and DITAVAL
 * files, unpacked safely (`readZip`, every importer's limits) and converted
 * by `@openfolia/dita` with the target's DITA mapping (`dita` in `openfolia.yaml`)
 * into the import format, in a child process of its own whose heap and time
 * are bounded (`DitaConversionSettings`): no archive stalls or exhausts the
 * server. No DTD is read and nothing is fetched; what it
 * could not map is in the bundle's report. It takes no options: the
 * mapping is configuration.
 */
@Injectable()
export class DitaImporter extends Importer<DitaOptions> {
  readonly id = DITA_IMPORTER;
  readonly label = 'DITA project';
  readonly description =
    'A ZIP archive of a DITA 1.3 project: its maps become manuals, its topics modules (translations in folders named after the languages), its DITAVAL files variants, mapped by "dita" in openfolia.yaml.';
  readonly options = DitaOptions;

  constructor(private readonly settings: DitaConversionSettings) {
    super();
  }

  async toBundle(
    file: ImportFile,
    _options: DitaOptions,
    limits: ImportLimits,
    context: ImportContext,
  ): Promise<ImportBundle> {
    if (!looksLikeZip(file.bytes)) {
      throw new UnprocessableError(
        'invalid-archive',
        'The file is no ZIP archive.',
        { reason: 'not-a-zip' },
      );
    }
    const files = await readZip(file.bytes, limits);
    try {
      return {
        files: await convertDitaIsolated(files, context.config, this.settings),
      };
    } catch (error) {
      // Past the conversion's memory, time or what a string may hold: the project is too large, not the server broken.
      if (error instanceof ConversionLimitError) {
        throw new UnprocessableError(
          'import-too-large',
          'The DITA project converts to more than an import may hold or take; split it into several imports.',
          { reason: error.reason },
        );
      }
      throw error;
    }
  }
}
