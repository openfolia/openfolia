import type { LocalizedText } from '@openfolia/content-model/core';
import type { ZardBadgeTypeVariants } from '@openfolia/ui/badge';

import type { Item, Response, Schema } from '../api';
import type { ProjectConfig } from '../content/browser-model';
import type { ManualItem } from '../preview/preview-model';

/** A release as the API sends it (its cut and its withdrawal answer with it so). */
export type ReleaseItem = Schema<'ReleaseResource'>;
/**
 * A release as its own read and the list give it: with where its files stand (`meta.outputs`),
 * so the list counts every release's files in its one answer (#481).
 */
export type ReleaseDetail = Response<'/releases/{releaseId}'>['data'];
export type ReleaseListItem = Item<'/releases'>;
export type ReleaseOutput = Item<'/releases/{releaseId}/outputs'>;
export type ReleaseChange = Item<'/releases/{releaseId}/changes'>;
export type ReleaseChangesDoc = Response<'/releases/{releaseId}/changes'>;
export type OutputState = ReleaseOutput['attributes']['state'];
export type { ProjectConfig, StoredConfig } from '../content/browser-model';

/** The states the list filters by (`filter[state]`). */
export const RELEASE_STATES = ['published', 'withdrawn'] as const;
export type ReleaseState = (typeof RELEASE_STATES)[number];

export const RELEASE_PAGE_SIZES = [25, 50, 100] as const;
/** Files and changes per page on the release's page. */
export const FILE_PAGE_SIZE = 50;
export const CHANGE_PAGE_SIZE = 25;
/** How often files that are still rendering are read again, in ms. */
export const POLL_MS = 5_000;

/** A release's ID: a UUID. */
export const RELEASE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function releaseStateOf(release: ReleaseItem): ReleaseState {
  return release.attributes.withdrawal ? 'withdrawn' : 'published';
}

export const STATE_TEXT: Readonly<Record<ReleaseState, string>> = {
  published: 'editor.releases.state.published',
  withdrawn: 'editor.releases.state.withdrawn',
};

export const STATE_BADGE: Readonly<
  Record<ReleaseState, ZardBadgeTypeVariants>
> = {
  published: 'success',
  withdrawn: 'secondary',
};

/**
 * Where a release's files stand, as the API counts them for the person (`meta.outputs`):
 * still being planned, rendering, done or failed, with how many are in each state.
 */
export type OutputProgress = Schema<'ReleaseOutputsProgress'>;

/**
 * What the files of a release say in short: being prepared (planned), rendering, failed (some
 * files, or the planning with none planned), ready, or none (the release has no files the person
 * may read).
 */
export type ProgressKind =
  'preparing' | 'rendering' | 'failed' | 'ready' | 'none';

export function progressKind(progress: OutputProgress): ProgressKind {
  switch (progress.state) {
    case 'planning':
      return 'preparing';
    case 'rendering':
      return 'rendering';
    case 'failed':
      return 'failed';
    case 'done':
      return progress.total === 0 ? 'none' : 'ready';
  }
}

/**
 * Planning the files again is worth offering: none on their way, and none at all, or their
 * planning failed (or was refused) with none of the files failed, as a planning cut off after
 * some batches leaves it (#477).
 */
export function canPlanAgain(
  progress: OutputProgress | null | undefined,
): boolean {
  return (
    !!progress &&
    !inProgress(progress) &&
    (progress.total === 0 ||
      (progress.state === 'failed' && progress.failed === 0))
  );
}

/** Files are still on their way (or not counted yet): worth reading again soon. */
export function inProgress(
  progress: OutputProgress | null | undefined,
): boolean {
  return (
    !progress || progress.state === 'planning' || progress.state === 'rendering'
  );
}

/**
 * Why "Download all (ZIP)" is blocked (a translation key), or null when some file is ready: none
 * ready yet (being prepared, rendering, or not counted yet), all failed, their planning failed, or
 * none at all to download.
 */
export function archiveBlocked(
  progress: OutputProgress | null | undefined,
): string | null {
  if (progress && progress.done > 0) return null;
  if (progress?.refused) return 'editor.releases.files.archive.tooMany';
  if (progress?.state === 'failed') {
    return progress.total === 0
      ? 'editor.releases.files.archive.planFailed'
      : 'editor.releases.files.archive.allFailed';
  }
  if (progress && !inProgress(progress) && progress.total === 0) {
    return 'editor.releases.files.archive.none';
  }
  return 'editor.releases.files.archive.notReady';
}

/** The share of files done, in percent (0 for none). */
export function donePercent(progress: OutputProgress): number {
  return progress.total === 0 ? 0 : (progress.done / progress.total) * 100;
}

/**
 * Whether two answers differ in what the files show: another state or other counts. The page of
 * files is read again only then.
 */
export function sameProgress(
  a: OutputProgress | null | undefined,
  b: OutputProgress | null | undefined,
): boolean {
  if (!a || !b) return a === b;
  return (
    a.state === b.state &&
    a.total === b.total &&
    a.queued === b.queued &&
    a.rendering === b.rendering &&
    a.done === b.done &&
    a.failed === b.failed &&
    a.refused?.reason === b.refused?.reason &&
    a.refused?.wanted === b.refused?.wanted &&
    a.refused?.max === b.refused?.max
  );
}

/**
 * The parameters of a progress text (`progressKey`, `progressBadgeKey`): the counts, and for a
 * refused planning how many files it would have had (`wanted`; 0 when the person may not know,
 * whose text then names only the limit) and the limit (`max`).
 */
export function progressParams(
  progress: OutputProgress,
): Record<string, number> {
  const { total, queued, rendering, done, failed, refused } = progress;
  return {
    total,
    queued,
    rendering,
    done,
    failed,
    wanted: refused?.wanted ?? 0,
    max: refused?.max ?? 0,
  };
}

/**
 * The files in short: "4 of 9 files ready", "Preparing the files…", "Too many files: …", or none.
 * Its parameters: `progressParams`.
 */
export function progressKey(progress: OutputProgress): string {
  switch (progressKind(progress)) {
    case 'preparing':
      return 'editor.releases.progress.preparing';
    case 'none':
      return 'editor.releases.progress.none';
    case 'rendering':
      return progress.failed > 0
        ? 'editor.releases.progress.renderingFailed'
        : 'editor.releases.progress.rendering';
    case 'failed':
      if (progress.refused) {
        return progress.refused.wanted === null
          ? 'editor.releases.progress.tooManyLimit'
          : 'editor.releases.progress.tooMany';
      }
      // None of its files failed: planning did (it may have planned some batches).
      return progress.failed === 0
        ? 'editor.releases.progress.planFailed'
        : 'editor.releases.progress.failed';
    case 'ready':
      return 'editor.releases.progress.ready';
  }
}

/**
 * What the release waits for while the product's other releases go first (#497): while it renders,
 * "Waiting for 1,240 files of newer releases" (rendered newest first); while its planning waits
 * behind its earlier releases' (planned in the order cut, #527), "Waiting for 2 earlier releases to
 * be prepared first". Only a publisher
 * of its product is given the counts (the API gives anyone else no `queue`); null while nothing is
 * ahead of it.
 */
export function waitingText(
  progress: OutputProgress | null | undefined,
): { key: string; params: Record<string, number> } | null {
  const queue = progress?.queue;
  if (!queue) return null;
  if (progress.state === 'planning' && queue.releases > 0) {
    return {
      key: 'editor.releases.progress.waitingPlans',
      params: { releases: queue.releases },
    };
  }
  if (progress.state !== 'rendering' || queue.ahead === 0) return null;
  return {
    key: 'editor.releases.progress.waiting',
    params: { ahead: queue.ahead },
  };
}

/** The files in a word or two, for a badge: "Preparing", "4 of 9", "Ready", "2 failed". */
export function progressBadgeKey(progress: OutputProgress): string {
  switch (progressKind(progress)) {
    case 'preparing':
      return 'editor.releases.progress.badge.preparing';
    case 'none':
      return 'editor.releases.progress.badge.none';
    case 'rendering':
      return 'editor.releases.progress.badge.rendering';
    case 'failed':
      if (progress.refused) return 'editor.releases.progress.badge.tooMany';
      return progress.failed === 0
        ? 'editor.releases.progress.badge.planFailed'
        : 'editor.releases.progress.badge.failed';
    case 'ready':
      return 'editor.releases.progress.badge.ready';
  }
}

export const PROGRESS_BADGE: Readonly<
  Record<ProgressKind, ZardBadgeTypeVariants>
> = {
  preparing: 'secondary',
  rendering: 'info',
  failed: 'destructive',
  ready: 'success',
  none: 'outline',
};

export const OUTPUT_STATE_TEXT: Readonly<Record<OutputState, string>> = {
  queued: 'editor.releases.files.state.queued',
  rendering: 'editor.releases.files.state.rendering',
  done: 'editor.releases.files.state.done',
  failed: 'editor.releases.files.state.failed',
};

export const OUTPUT_STATE_BADGE: Readonly<
  Record<OutputState, ZardBadgeTypeVariants>
> = {
  queued: 'secondary',
  rendering: 'info',
  done: 'success',
  failed: 'destructive',
};

export const CHANGE_TEXT: Readonly<
  Record<ReleaseChange['meta']['change'], string>
> = {
  added: 'editor.releases.changes.kind.added',
  changed: 'editor.releases.changes.kind.changed',
  removed: 'editor.releases.changes.kind.removed',
};

export const CHANGE_BADGE: Readonly<
  Record<ReleaseChange['meta']['change'], ZardBadgeTypeVariants>
> = {
  added: 'success',
  changed: 'info',
  removed: 'destructive',
};

/** A page of files that still render: polled until none does. */
export function anyPending(outputs: readonly ReleaseOutput[]): boolean {
  return outputs.some(
    (o) =>
      o.attributes.state === 'queued' || o.attributes.state === 'rendering',
  );
}

/** One manual's files on a page, in the API's order (manual, variant, language). */
export interface OutputGroup {
  /** The manual's ID; `OFFLINE_PACKAGES` for the release's offline packages (#59). */
  readonly manual: string;
  readonly outputs: readonly ReleaseOutput[];
}

/** The group of a release's offline packages (#59): of no one manual (`manual` null). */
export const OFFLINE_PACKAGES = '*';

export function groupOutputs(outputs: readonly ReleaseOutput[]): OutputGroup[] {
  const groups: { manual: string; outputs: ReleaseOutput[] }[] = [];
  for (const output of outputs) {
    const manual = output.attributes.manual ?? OFFLINE_PACKAGES;
    const last = groups.at(-1);
    if (last?.manual === manual) last.outputs.push(output);
    else groups.push({ manual, outputs: [output] });
  }
  return groups;
}

/**
 * How a file names its manual and variant (in the interface language, `shown`): the manual's title and the variant's label (from the
 * configuration's attribute labels, `meta.variants`) at the release's tag; each its ID while the
 * manuals are not read, or when the manual (or that variant) is not among them.
 */
/** How a manual's title and a variant show in the interface language (#731, `UiTexts`). */
export interface OutputTexts {
  title(text: LocalizedText): string;
  /** `fallback`: the API's label, in the source language. */
  variant(values: Readonly<Record<string, string>>, fallback: string): string;
  /** "Offline package": what an offline package (#59) is called in place of a manual's title. */
  offlinePackage(): string;
  /** An audience level's label (#59); undefined while the configuration is not at hand. */
  audience(id: string): string | undefined;
}

/**
 * An offline package (#59) is named "Offline package" with its audience level's label (its ID
 * while the configuration is not at hand; nothing when no levels are configured) in place of the
 * variant.
 */
export function outputNames(
  manuals: ReadonlyMap<string, ManualItem>,
  output: ReleaseOutput,
  shown: OutputTexts,
): { readonly manual: string; readonly variant: string } {
  const { manual: id, variant: slug, audience } = output.attributes;
  if (id === null || slug === null) {
    return {
      manual: shown.offlinePackage(),
      variant: audience === null ? '' : (shown.audience(audience) ?? audience),
    };
  }
  const manual = manuals.get(id);
  const variant = manual?.meta.variants.find((v) => v.slug === slug);
  return {
    manual: (manual && shown.title(manual.attributes.title)) || id,
    variant: (variant && shown.variant(variant.values, variant.label)) || slug,
  };
}

/** The output as retrying it answers: in full, or (a publisher who may not read it) its state only. */
export type RetriedOutput = Pick<ReleaseOutput, 'id'> & {
  readonly attributes: Partial<ReleaseOutput['attributes']> &
    Pick<ReleaseOutput['attributes'], 'state'>;
};

/** The page's output after a retry: what the answer tells, the rest as it was. */
export function afterRetry(
  output: ReleaseOutput,
  answer: RetriedOutput | null,
): ReleaseOutput {
  return {
    ...output,
    attributes: {
      ...output.attributes,
      state: answer?.attributes.state ?? 'queued',
      error: null,
    },
  };
}

/**
 * The product facet: `release.productFacet`, else the first facet (as the API names products);
 * null when nothing is configured.
 */
export function productFacetOf(
  config: ProjectConfig,
): ProjectConfig['facets'][number] | null {
  const id = config.release?.productFacet;
  return (
    (id ? config.facets.find((f) => f.id === id) : config.facets[0]) ?? null
  );
}

/** A product as people read it: its facet value's label, else its ID. */
export function productLabel(
  config: ProjectConfig | null,
  product: string,
): string {
  if (!config) return product;
  const facet = productFacetOf(config);
  return facet?.values.find((v) => v.id === product)?.label ?? product;
}

/**
 * A product version (the API's revision) the tag can be named by: 1 to 100 characters of
 * `A-Za-z0-9._-`, starting with a letter, digit or `_`, without `..`, not ending in `.` or
 * `.lock`. The API checks it again.
 */
export function revisionProblem(revision: string): string | null {
  const value = revision.trim();
  if (value === '') return 'editor.releases.create.revision.required';
  if (
    value.length > 100 ||
    !/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(value) ||
    value.includes('..') ||
    value.endsWith('.') ||
    value.endsWith('.lock')
  ) {
    return 'editor.releases.create.revision.invalid';
  }
  return null;
}

/** Most characters one summary may have, once trimmed (the API's). */
export const NOTES_MAX = 10_000;
/** Most characters all summaries may have together (the API's). */
export const ALL_NOTES_MAX = 60_000;
/** Most characters a withdrawal's reason may have, once trimmed (the API's). */
export const REASON_MAX = 2_000;

/**
 * Why a summary would be refused, as the API judges it (it checks again): too long, a line
 * starting with `---` or of the form `[notes:<lang>]`, or a last paragraph of `Key: value` lines
 * (Git would read them as trailers). Null when it is fine or empty.
 */
export function notesProblem(notes: string): string | null {
  const value = notes.replace(/\r\n/g, '\n').trim();
  if (value === '') return null;
  if (value.length > NOTES_MAX) return 'editor.releases.create.notes.tooLong';
  // eslint-disable-next-line no-control-regex -- the API refuses control characters but tabs and line breaks
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))
    return 'editor.releases.create.notes.invalid';
  const lines = value.split('\n');
  if (lines.some((l) => l.startsWith('---') || /^\[notes:[^\]]*\]$/.test(l)))
    return 'editor.releases.create.notes.invalid';
  const last = value.split(/\n\s*\n/).at(-1) ?? '';
  if (last.split('\n').every((l) => /^[A-Za-z0-9-]+: \S/.test(l)))
    return 'editor.releases.create.notes.trailer';
  return null;
}

/** The summaries as the API takes them: trimmed, empty ones left out. */
export function notesByLanguageOf(
  notes: Readonly<Record<string, string>>,
): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [lang, text] of Object.entries(notes)) {
    if (text.trim() !== '') kept[lang] = text.trim();
  }
  return kept;
}

/** The `?notes=` value that chooses a release's summary, so that choice survives a reload (#794). */
export const NOTES_SUMMARY = 'summary';

/**
 * Which notes a release's page shows (#794): `NOTES_SUMMARY` or a language of `notesByLanguage`.
 * A choice in the address wins when the release has it ("summary" always does). Without one, the
 * summary in the interface language when the release has it (the exact tag, else the first with
 * the same primary language, `de-AT` for `de`), else the summary.
 */
export function notesShown(
  notesByLanguage: Readonly<Record<string, string>>,
  requested: string | undefined,
  uiLanguage: string,
): string {
  // Own keys only: `?notes=valueOf` names no summary.
  const has = (lang: string) =>
    Object.hasOwn(notesByLanguage, lang) &&
    (notesByLanguage[lang] ?? '').trim() !== '';
  if (requested === NOTES_SUMMARY) return NOTES_SUMMARY;
  if (requested !== undefined && Object.hasOwn(notesByLanguage, requested))
    return requested;
  const ui = uiLanguage.toLowerCase();
  const primary = (lang: string) => lang.toLowerCase().split('-')[0];
  const langs = Object.keys(notesByLanguage).filter(has);
  return (
    langs.find((lang) => lang.toLowerCase() === ui) ??
    langs.find((lang) => primary(lang) === primary(ui)) ??
    NOTES_SUMMARY
  );
}

/** The reason a withdrawal needs: required, at most `REASON_MAX` characters once trimmed. */
export function reasonProblem(reason: string): string | null {
  const value = reason.trim();
  if (value === '') return 'editor.releases.withdraw.reasonRequired';
  if (value.length > REASON_MAX)
    return 'editor.releases.withdraw.reasonTooLong';
  return null;
}

/** The short form of a commit, as Git shows it. */
export function shortCommit(commit: string): string {
  return commit.slice(0, 7);
}
