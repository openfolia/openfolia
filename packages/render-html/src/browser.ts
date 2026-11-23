// The host page's behaviour for the rendered HTML, without the renderer (`@openfolia/render-html/browser`):
// what a page that runs script loads in the browser, so its bundle holds neither the renderer
// nor the content model.
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
