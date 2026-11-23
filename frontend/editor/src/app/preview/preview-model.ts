import type { Item, Response, Schema } from '../api';
import { includesModule } from '../module-editor/module-model';
import { idParam, intParam, oneOfParam } from '../view-state';

export type ManualItem = Extract<Item<'/manuals'>, { attributes: unknown }>;
export type VariantSummary = Schema<'VariantSummary'>;
export type HiddenDoc = Response<'/modules/{lang}/{id}/hidden-content'>;
export type HiddenItem = HiddenDoc['data'][number];

export const PREVIEW_SCOPES = ['module', 'manual'] as const;
export type PreviewScope = (typeof PREVIEW_SCOPES)[number];
export const PREVIEW_OUTPUTS = ['html', 'pdf'] as const;
export type PreviewOutput = (typeof PREVIEW_OUTPUTS)[number];

const ID = /^[a-z0-9][a-z0-9-]{0,199}$/;

/**
 * A release's tag (`release/<product>/<revision>` by default, `CCMS_RELEASE_TAG`): ref components
 * of `A-Za-z0-9._-`, without `..`, never starting with `refs/`.
 */
export const RELEASE_TAG =
  /^(?!refs\/)(?!.*\.\.)[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+){0,7}$/;

/**
 * What the preview shows, in the address (`injectQueryState`): `?module=<id>` and/or
 * `?manual=<id>`, `?scope=manual` (the whole manual; this module is the default when a module is
 * named), `?lang=`, `?variant=<slug>`, `?output=pdf` (HTML is the default), `?hidden=shown` (the
 * list of what is hidden, open) and its `?hiddenPage=`, `?unsaved=off` (the person's own draft
 * without its unsaved changes: its branch as committed), `?tag=` (a release's tag: the content as
 * released, in place of the chosen revision). `?cs=` is the shell's (`ChangeSetUrl`).
 */
export const PREVIEW_VIEW = {
  module: idParam(ID),
  manual: idParam(ID),
  scope: oneOfParam(PREVIEW_SCOPES, 'module'),
  lang: idParam(/^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8}){0,3}$/),
  variant: idParam(/^[A-Za-z0-9._~=,:+-]{1,400}$/),
  output: oneOfParam(PREVIEW_OUTPUTS, 'html'),
  hidden: oneOfParam(['shown'] as const),
  unsaved: oneOfParam(['off'] as const),
  hiddenPage: intParam(1),
  tag: idParam(RELEASE_TAG),
};

/** Hidden content per page of the list. */
export const HIDDEN_PAGE_SIZE = 25;

/** The manuals a module is in, else (none named) every manual. */
export function manualsFor(
  manuals: readonly ManualItem[],
  moduleId: string | undefined,
): ManualItem[] {
  return moduleId
    ? manuals.filter((m) => includesModule(m.attributes.entries, moduleId))
    : [...manuals];
}

/**
 * The manual in use: the one the address names when it is among `candidates`, else (a module is
 * named) the first manual the module is in; none when nothing fits.
 */
export function chooseManual(
  candidates: readonly ManualItem[],
  asked: string | undefined,
  moduleId: string | undefined,
): ManualItem | null {
  const named = candidates.find((m) => m.id === asked);
  if (named) return named;
  return moduleId ? (candidates[0] ?? null) : null;
}

/** The variant in use: the one asked for when the manual has it, else its first; none without. */
export function chooseVariant(
  variants: readonly VariantSummary[],
  asked: string | undefined,
): VariantSummary | null {
  return variants.find((v) => v.slug === asked) ?? variants[0] ?? null;
}

/** The language in use: the one asked for when offered, else the source language, else the first. */
export function chooseLanguage(
  languages: readonly string[],
  asked: string | undefined,
  source: string | undefined,
): string | null {
  if (asked && languages.includes(asked)) return asked;
  if (source && languages.includes(source)) return source;
  return languages[0] ?? null;
}

/** The API's path for the preview page of a module or manual (without `?`). */
export function previewPath(
  scope: PreviewScope,
  ids: {
    module: string | null;
    manual: string | null;
    lang: string;
    variant: string | null;
  },
): string | null {
  const e = encodeURIComponent;
  if (scope === 'module') {
    return ids.module
      ? `/modules/${e(ids.lang)}/${e(ids.module)}/preview`
      : null;
  }
  if (!ids.manual || !ids.variant) return null;
  return `/manuals/${e(ids.manual)}/variants/${e(ids.variant)}/${e(ids.lang)}/html`;
}
