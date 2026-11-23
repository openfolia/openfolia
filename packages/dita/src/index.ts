export {
  bundleFiles,
  convertDita,
  DITA_SOURCE_SYSTEM,
  DocumentTooLargeError,
  type DitaConversion,
  MAX_REPORT_ENTRIES,
} from './lib/convert.js';
export {
  MAX_CONREF_DEPTH,
  MAX_IMPORT_EXPANSION,
  MAX_IMPORT_EXPANSION_CHARS,
  MAX_MODULE_EXPANSION_CHARS,
  MAX_MODULE_EXPANSION,
} from './lib/conref.js';
export {
  ConversionLimitError,
  convertDitaIsolated,
  type IsolationLimits,
} from './lib/isolated.js';
export { DITA_XML_LIMITS } from './lib/load.js';
export { MAX_KEYED_TEXT_CHARS } from './lib/keys.js';
export {
  MAX_MAP_DEPTH,
  MAX_MANUAL_ENTRIES,
  MAX_MANUAL_TITLE_CHARS,
  MAX_MAP_VISITS,
} from './lib/map.js';
export { MAX_ELEMENT_CONDITIONS } from './lib/profiling.js';
export type { DitaReportCode } from './lib/report.js';
export { MAX_TABLE_CELLS, MAX_TABLE_COLUMNS } from './lib/topic.js';
export {
  DEFAULT_EXPORT_MAX_CHARS,
  DEFAULT_EXPORT_MAX_NODES,
  type DitaExport,
  type DitaExportFile,
  type DitaExportInput,
  DitaExportTooLargeError,
  exportDita,
  MAX_REFERENCE_DEPTH,
  topicTypeFor,
} from './lib/export/export.js';
export {
  DITA_EXPORT_WARNINGS,
  type DitaExportWarning,
  type DitaExportWarningCode,
  MAX_EXPORT_WARNINGS,
} from './lib/export/report.js';
