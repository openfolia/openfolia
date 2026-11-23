export {
  renderManualHtml,
  renderModuleHtml,
  HtmlRenderError,
  PREVIEW_LABELS,
  type PreviewOptions,
  type HtmlRenderOptions,
  type HtmlRenderResult,
  type XrefTarget,
  manualHeadings,
  headingIdOf,
  type ManualHeading,
} from './lib/render.js';
export {
  offlineIndexHtml,
  offlinePageHtml,
  offlineLabels,
  offlineContentSecurityPolicy,
  OFFLINE_LABELS,
  OFFLINE_SEARCH_PATH,
  OFFLINE_SEARCH_SCRIPT,
  OFFLINE_SITE_CSS,
  OFFLINE_STYLESHEETS,
  type OfflineIndex,
  type OfflineIndexManual,
  type OfflineIndexVariant,
  type OfflineLabels,
  type OfflinePage,
  type OfflineSearchEntry,
} from './lib/offline-site.js';
export { escapeHtml, safeUrl } from './lib/escape.js';
export {
  dismissTermOnEscape,
  TERM_DISMISSED,
  type TermDocument,
} from './lib/term-tooltips.js';
export {
  highlightCallouts,
  CALLOUT_HIGHLIGHTED,
  CALLOUT_KEY_ATTRIBUTE,
  type CalloutDocument,
} from './lib/callout-highlight.js';
