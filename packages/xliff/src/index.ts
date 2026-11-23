export { OWN_NAMESPACE } from './lib/inline.js';
export {
  MAX_READ_FILES,
  MAX_READ_UNITS,
  readXliff,
  XliffReadError,
  type ReadFile,
  type ReadSegment,
  type ReadUnit,
  type ReadXliff,
  type XliffRefusal,
} from './lib/read.js';
export {
  targetParts,
  type TargetRefusal,
  type TargetResult,
} from './lib/target.js';
export {
  wordCount,
  xliffUnitsOf,
  xliffUnitsOfDesign,
  xliffUnitsOfConfig,
  xliffUnitsOfManifest,
  type XliffUnit,
} from './lib/units.js';
export {
  writeXliff,
  XLIFF_MEDIA_TYPE,
  XLIFF_NAMESPACE,
  XliffWriteError,
  type XliffDocument,
  type XliffModule,
} from './lib/write.js';
export {
  DEFAULT_XML_LIMITS,
  type XmlLimits,
  type XmlRefusal,
} from '@openfolia/xml';
export {
  COTI_FILE,
  COTI_LEVELS,
  COTI_NAMESPACE,
  COTI_STATUSES,
  COTI_TRANSLATION_FOLDER,
  COTI_VERSION,
  COTI_XML_LIMITS,
  CotiReadError,
  CotiWriteError,
  cotiLanguage,
  cotiName,
  cotiProjectFolder,
  cotiTimestamp,
  isRelativeFileRef,
  MAX_COTI_FILE_REF,
  readCoti,
  writeCoti,
  type CotiProject,
  type CotiRefusal,
  type CotiStatus,
  type CotiTranslationFile,
  type ReadCoti,
} from './lib/coti.js';
export { cotiSchemaErrors } from './lib/coti-schema.js';
