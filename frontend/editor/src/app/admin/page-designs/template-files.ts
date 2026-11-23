import {
  isTemplateFilePath,
  isTemplateTextFile,
  MAX_TEMPLATE_FILE_DEPTH,
  MAX_TEMPLATE_FILE_PATH,
} from '@openfolia/content-model/core';

import type { CodeLanguage } from '@openfolia/ui/code-editor';

import { DESIGN_ID } from './design-model';

/** The name of each language the code editor colours, for the file's status bar. */
export const LANGUAGE_NAMES: Readonly<Record<CodeLanguage, string>> = {
  typst: 'editor.admin.pageDesigns.templates.languages.typst',
  yaml: 'editor.admin.pageDesigns.templates.languages.yaml',
  json: 'editor.admin.pageDesigns.templates.languages.json',
  xml: 'editor.admin.pageDesigns.templates.languages.xml',
  plain: 'editor.admin.pageDesigns.templates.languages.plain',
};

/** The longest template ID the screen offers (a slug, as a design's). */
export const TEMPLATE_ID_MAX = 64;

/**
 * Why `path` cannot be a new file of a template (a translation key), or null: the content model's
 * rules for a template's text file (`isTemplateFilePath`, `isTemplateTextFile`), said one by one,
 * and not a file the template has.
 */
export function templateFileProblem(
  path: string,
  taken: readonly string[],
  templateId = '',
): string | null {
  if (!path) return 'editor.admin.pageDesigns.templates.newFile.problems.empty';
  // The API keeps a file as `<templateId>/<path>`, at most 200 characters.
  if (
    path.length > MAX_TEMPLATE_FILE_PATH ||
    templateId.length + 1 + path.length > 200
  ) {
    return 'editor.admin.pageDesigns.templates.newFile.problems.tooLong';
  }
  if (path.split('/').length > MAX_TEMPLATE_FILE_DEPTH) {
    return 'editor.admin.pageDesigns.templates.newFile.problems.tooDeep';
  }
  if (!isTemplateFilePath(path)) {
    return 'editor.admin.pageDesigns.templates.newFile.problems.invalid';
  }
  if (!isTemplateTextFile(path)) {
    return 'editor.admin.pageDesigns.templates.newFile.problems.notText';
  }
  if (taken.includes(path)) {
    return 'editor.admin.pageDesigns.templates.newFile.problems.taken';
  }
  // Git holds no file and folder of one name: the save point would refuse it.
  if (taken.some((t) => t.startsWith(`${path}/`) || path.startsWith(`${t}/`))) {
    return 'editor.admin.pageDesigns.templates.newFile.problems.clash';
  }
  return null;
}

/** Why `id` cannot be a new template's ID (a translation key), or null. */
export function templateIdProblem(
  id: string,
  taken: readonly string[],
): string | null {
  if (!id) return 'editor.admin.pageDesigns.templates.create.idRequired';
  if (id.length > TEMPLATE_ID_MAX || !DESIGN_ID.test(id)) {
    return 'editor.admin.pageDesigns.templates.create.idInvalid';
  }
  if (taken.includes(id)) {
    return 'editor.admin.pageDesigns.templates.create.idTaken';
  }
  return null;
}
