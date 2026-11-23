export * from './lib/spec.js';
export type { EditorDoc, EditorMark, EditorNode } from './lib/json.js';
export * from './lib/limits.js';
export * from './lib/errors.js';
export { createEditorExtensions, getEditorSchema } from './lib/extensions.js';
export { regionToEditor, toEditor } from './lib/to-editor.js';
export { fromEditor, regionFromEditor } from './lib/from-editor.js';
export { normalizeEditorDoc, type NormalizeOptions } from './lib/normalize.js';
