import { readdirSync } from 'node:fs';
import { basename } from 'node:path';

const uiLibDir = new URL('../../ui/src/lib/', import.meta.url);
// Folders of the UI library that are not components.
const NOT_COMPONENTS = new Set(['ui', 'showcase']);

/** Component names the UI library already provides: one folder each under `ui/src/lib`. */
export function uiComponentNames(dir = uiLibDir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !NOT_COMPONENTS.has(entry.name))
    .map((entry) => entry.name);
}

/** `button.component.ts` -> `button`; `date-picker.directive.ts` -> `date-picker`. */
function componentNameOf(filename) {
  return basename(filename)
    .replace(/\.ts$/, '')
    .replace(/\.(component|directive|pipe|variants)$/, '');
}

/**
 * The editor app imports components from `frontend/ui` and does not write its own copy of one.
 * A file in the app named like a component the UI library provides is refused; a component
 * that is genuinely app-specific gets another name (or goes into `frontend/ui` if it is shared).
 */
export default {
  meta: {
    type: 'problem',
    messages: {
      duplicate:
        "'{{name}}' already exists in frontend/ui. Import it from its folder in '@openfolia/ui' (`@openfolia/ui/<folder>`) instead of writing it again in the app (or give an app-specific component another name).",
    },
    schema: [],
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    const name = componentNameOf(filename);
    const provided = uiComponentNames();
    return {
      Program(node) {
        if (/\.(spec|test)\.ts$/.test(filename)) return;
        if (provided.includes(name)) {
          context.report({ node, messageId: 'duplicate', data: { name } });
        }
      },
    };
  },
};
