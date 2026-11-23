import {
  blockUnits,
  coverAltOwn,
  coverAltSource,
  configTexts,
  coverEntries,
  type LabelledConfig,
  manifestTexts,
  normalizeBlock,
  ownTextIn,
  plainTextOf,
  sourceTextOf,
  translatableUnits,
  type Block,
  type Manifest,
  type Module,
  type TranslatableUnit,
} from '@openfolia/content-model/core';

import type { Item, PostBody, Response, Schema } from '../api';
import { regionIn, type Regions } from '../admin/page-designs/region-text';
import { groupTree, type ProjectConfig } from '../content/browser-model';
import type { ModuleContent } from '../module-editor/module-model';
import type { ApiTranslationState } from './badge-state';

export { BADGE_STATE, type ApiTranslationState } from './badge-state';

/** One source module in one target language (`GET /translations/status`). */
export type StatusItem = Item<'/translations/status'>;
/** One translation job (`GET /translations/exports`). */
export type JobItem = Item<'/translations/exports'>;
/** One module in one language, with every block's state. */
export type StatusDetail =
  Response<'/translations/status/{lang}/{moduleId}'>['data'];
export type ExportSubject = Schema<'TranslationExportSubject'>;
export type ExportBody = PostBody<'/translations/exports'>;
export type JobMeta = Schema<'TranslationJobMeta'>;

/** The states, in the order the filter offers them. */
export const STATES: readonly ApiTranslationState[] = [
  'outdated',
  'missing',
  'at-provider',
  'up-to-date',
];

/** A state's word, as the state filter and the side panel say it. */
export const STATE_TEXT: Readonly<Record<ApiTranslationState, string>> = {
  'up-to-date': 'editor.translations.state.upToDate',
  outdated: 'editor.translations.state.outdated',
  missing: 'editor.translations.state.missing',
  'at-provider': 'editor.translations.state.atProvider',
};

/** The rows per page the matrix offers. */
export const STATUS_PAGE_SIZES = [10, 25] as const;
/** The jobs per page the Jobs tab offers. */
export const JOB_PAGE_SIZES = [25, 50, 100] as const;

/** A module ID, a manual ID. */
export const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** A language tag. */
export const LANG_PATTERN = /^[a-zA-Z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
/** A folder of the content browser: `<type>` or `<type>/<facet value>`. */
export const FOLDER_PATTERN = /^[a-z][a-z0-9-]*(?:\/[a-z0-9][a-z0-9_-]*)?$/;
/**
 * A row of the matrix: a module's ID, `designs/<designId>` for a page design's region text
 * (#568), `manuals/<manualId>` for a manual's own text (#656), or `config/project` for the
 * project labels (#731).
 */
export const ROW_PATTERN =
  /^(?:(?:designs\/|manuals\/)?[a-z0-9]+(?:-[a-z0-9]+)*|config\/project)$/;
/** A cell of the matrix: `<lang>/<row>`, the status's ID. */
export const CELL_PATTERN =
  /^[a-zA-Z]{2,3}(?:-[A-Za-z0-9]{2,8})*\/(?:(?:designs\/|manuals\/)?[a-z0-9]+(?:-[a-z0-9]+)*|config\/project)$/;
/** A job's ID. */
export const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** A cell's key: the status's ID (`<lang>/<row>`). */
export const cellKey = (lang: string, row: string): string => `${lang}/${row}`;

/** The row a design's status is on (#568). */
export const designRow = (designId: string): string => `designs/${designId}`;

/** The row a manual's own text is on (#656: its cover images' alternative text). */
export const manualRow = (manualId: string): string => `manuals/${manualId}`;

/** The row of the project labels (#731): one, in every target language. */
export const CONFIG_ROW = 'config/project';

/** What a matrix row is of. */
export type RowKind = 'module' | 'design' | 'manual' | 'config';

/** The kind of a row by its ID (`designRow`, `manualRow`, `CONFIG_ROW`, else a module's). */
export function kindOfRow(row: string): RowKind {
  return row.startsWith('designs/')
    ? 'design'
    : row.startsWith('manuals/')
      ? 'manual'
      : row === CONFIG_ROW
        ? 'config'
        : 'module';
}

/** A row's design or manual ID, or a module's ID. */
const refOfRow = (row: string): string => row.slice(row.indexOf('/') + 1);

/** What a cell is of: a module, or a page design's region text (#568). */
export type CellOf =
  | {
      readonly lang: string;
      readonly kind: 'module';
      readonly moduleId: string;
    }
  | {
      readonly lang: string;
      readonly kind: 'design';
      readonly designId: string;
    }
  | {
      readonly lang: string;
      readonly kind: 'manual';
      readonly manualId: string;
    }
  | {
      readonly lang: string;
      readonly kind: 'config';
    };

/** A cell's language and module (or design), from its key. */
export function parseCell(key: string): CellOf | null {
  if (!CELL_PATTERN.test(key)) return null;
  const at = key.indexOf('/');
  const lang = key.slice(0, at);
  const rest = key.slice(at + 1);
  switch (kindOfRow(rest)) {
    case 'design':
      return { lang, kind: 'design', designId: refOfRow(rest) };
    case 'manual':
      return { lang, kind: 'manual', manualId: refOfRow(rest) };
    case 'config':
      return { lang, kind: 'config' };
    default:
      return { lang, kind: 'module', moduleId: rest };
  }
}

/** One row of the matrix: a source module (or a page design's region text), with its status per target language. */
export interface MatrixRow {
  /** The module's ID, `designs/<designId>` (`designRow`) or `manuals/<manualId>` (`manualRow`). */
  readonly id: string;
  readonly kind: RowKind;
  /** The module's, the design's or the manual's ID. */
  readonly ref: string;
  readonly title: string;
  /** By language; a language missing here was filtered out (or is outside the reader's scope). */
  readonly cells: ReadonlyMap<string, StatusItem>;
}

/** The row a status is on: its module's ID, `designs/<designId>` or `manuals/<manualId>`. */
export function rowOf(item: StatusItem): string {
  const { designId, manualId, moduleId, kind } = item.attributes;
  if (kind === 'config') return CONFIG_ROW;
  return designId !== undefined
    ? designRow(designId)
    : manualId !== undefined
      ? manualRow(manualId)
      : (moduleId ?? '');
}

/**
 * The rows of the page that "Choose every row on this page" chooses: one kind, as an export takes
 * page designs (#568), manuals' own text (#656) and modules apart. The kind already chosen (when
 * only one is), else modules where the page has any, else designs, else manuals.
 */
export function pageRows(
  rows: readonly MatrixRow[],
  chosen: readonly string[],
): readonly MatrixRow[] {
  const kinds = new Set(chosen.map(kindOfRow));
  const [only] = kinds;
  const kind: RowKind =
    kinds.size === 1 && only !== undefined
      ? only
      : ((['module', 'design', 'manual', 'config'] as const).find((k) =>
          rows.some((r) => r.kind === k),
        ) ?? 'module');
  return rows.filter((r) => r.kind === kind);
}

/**
 * What the chosen rows are, in words: modules, page designs or manuals' cover image texts by
 * their number, or rows of several kinds (which no one export takes).
 */
export function chosenText(chosen: readonly string[]): {
  readonly key: string;
  readonly params: Record<string, number>;
} {
  const kinds = new Set(chosen.map(kindOfRow));
  const count = chosen.length;
  if (kinds.size > 1) {
    return {
      key: 'editor.translations.selection.countMixed',
      params: { count },
    };
  }
  const [kind] = kinds;
  return {
    key:
      kind === 'design'
        ? 'editor.translations.selection.countDesigns'
        : kind === 'manual'
          ? 'editor.translations.selection.countManuals'
          : kind === 'config'
            ? 'editor.translations.selection.countConfig'
            : 'editor.translations.selection.count',
    params: { count },
  };
}

/** The export dialog's words for the chosen rows ("The 2 chosen page designs"). */
export function chosenExportText(chosen: readonly string[]): {
  readonly key: string;
  readonly params: Record<string, number>;
} {
  const { key, params } = chosenText(chosen);
  const keys: Record<string, string> = {
    'editor.translations.selection.count':
      'editor.translations.export.selection',
    'editor.translations.selection.countDesigns':
      'editor.translations.export.selectionDesigns',
    'editor.translations.selection.countManuals':
      'editor.translations.export.selectionManuals',
    'editor.translations.selection.countConfig':
      'editor.translations.export.selectionConfig',
    'editor.translations.selection.countMixed':
      'editor.translations.export.selectionMixed',
  };
  return { key: keys[key] ?? key, params };
}

/** Whether the chosen rows are of more than one kind: no one export takes them. */
export const mixedRows = (chosen: readonly string[]): boolean =>
  new Set(chosen.map(kindOfRow)).size > 1;

/**
 * The page's statuses as rows, one per module (or page design, #568, listed first), in the
 * order the API lists them (by source title, then module ID). A row's statuses come one after
 * another; one that comes back later (it should not) joins its row.
 */
export function matrixRows(items: readonly StatusItem[]): MatrixRow[] {
  const rows = new Map<
    string,
    {
      kind: RowKind;
      ref: string;
      title: string;
      cells: Map<string, StatusItem>;
    }
  >();
  for (const item of items) {
    const id = rowOf(item);
    const row = rows.get(id) ?? {
      kind: kindOfRow(id),
      ref: refOfRow(id),
      title: item.meta.title,
      cells: new Map(),
    };
    row.cells.set(item.attributes.lang, item);
    rows.set(id, row);
  }
  return [...rows].map(([id, row]) => ({ id, ...row }));
}

/**
 * The matrix's columns: the filtered language alone; else the target languages, in the
 * configured order, that the page shows (the reader may read only some of them), or all of
 * them while it shows none.
 */
export function matrixLanguages(
  targets: readonly string[],
  items: readonly StatusItem[],
  lang: string | undefined,
): readonly string[] {
  if (lang) return [lang];
  const seen = new Set(items.map((i) => i.attributes.lang));
  const shown = targets.filter((t) => seen.has(t));
  // A language the configuration does not list (changed meanwhile) still gets its column.
  const extra = [...seen].filter((l) => !targets.includes(l));
  return shown.length > 0 || extra.length > 0 ? [...shown, ...extra] : targets;
}

/** A cell's short text: its state, with the number of blocks to translate when outdated. */
export function cellText(item: StatusItem): {
  readonly key: string;
  readonly params: Record<string, number>;
} {
  switch (item.attributes.state) {
    case 'outdated':
      return {
        key: 'editor.translations.cell.outdated',
        params: { count: item.meta.outdatedBlocks },
      };
    case 'at-provider':
      return { key: 'editor.translations.cell.atProvider', params: {} };
    case 'missing':
      return { key: 'editor.translations.cell.missing', params: {} };
    case 'up-to-date':
      return { key: 'editor.translations.cell.upToDate', params: {} };
  }
}

/** A folder of the content browser, as the folder filter offers it. */
export interface FolderOption {
  readonly value: string;
  readonly label: string;
  /** Under a module type (a facet value): indented. */
  readonly nested: boolean;
}

/**
 * The content browser's folders (module types, and the first facet's values under each), by their
 * labels in the interface language.
 */
export function folderOptions(config: ProjectConfig): FolderOption[] {
  return groupTree(config).flatMap((node) => [
    { value: node.key, label: node.label, nested: false },
    ...node.children.map((child) => ({
      value: child.key,
      label: `${node.label} / ${child.label}`,
      nested: true,
    })),
  ]);
}

/** What an export sends, as the person chose it in the dialog. */
export type SubjectChoice = 'selection' | 'manual' | 'folder';

/** The subject the API takes for a choice; null while it is not complete. */
export function subjectOf(
  choice: SubjectChoice,
  values: {
    readonly selection: readonly string[];
    readonly manual: string;
    readonly folder: string;
  },
): ExportSubject | null {
  switch (choice) {
    case 'selection': {
      // Page designs' rows (#568), manuals' (#656) and modules' go in exports of their own.
      const rows = values.selection;
      if (rows.length === 0 || mixedRows(rows)) return null;
      switch (kindOfRow(rows[0] as string)) {
        case 'design':
          return { type: 'designs', designIds: rows.map(refOfRow) };
        case 'manual':
          return { type: 'manuals', manualIds: rows.map(refOfRow) };
        case 'config':
          return { type: 'config' };
        default:
          return { type: 'modules', moduleIds: [...rows] };
      }
    }
    case 'manual':
      return values.manual ? { type: 'manual', manualId: values.manual } : null;
    case 'folder':
      return values.folder ? { type: 'folder', folder: values.folder } : null;
  }
}

/** The subject the dialog starts with: the chosen rows, else the filtered manual or folder. */
export function initialChoice(context: {
  readonly selection: readonly string[];
  readonly manual: string | undefined;
  readonly folder: string | undefined;
}): SubjectChoice {
  if (context.selection.length > 0) return 'selection';
  if (context.folder && !context.manual) return 'folder';
  return 'manual';
}

/** The export's request: a dry run asks what would be sent, recording nothing. */
export function exportBody(
  request: {
    readonly languages: readonly string[];
    readonly subject: ExportSubject;
    readonly ref: string | undefined;
    readonly dueDate: string;
  },
  dryRun: boolean,
): ExportBody {
  return {
    data: {
      type: 'TranslationJob',
      attributes: {
        languages: [...request.languages],
        subject: request.subject,
        ...(request.ref ? { ref: request.ref } : {}),
        ...(request.dueDate ? { dueDate: request.dueDate } : {}),
      },
    },
    ...(dryRun ? { meta: { dryRun: true } } : {}),
  };
}

/** A due date the API takes: a real day, `YYYY-MM-DD`, or none. */
export function validDueDate(value: string): boolean {
  if (value === '') return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const day = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().startsWith(value);
}

/**
 * The text of each translatable block of a module, by block ID: its parts as plain text (an
 * image's alt text and title, a section's title, a paragraph), in the module's language. What
 * the side panel shows as the source and the translation; read-only.
 */
export function blockTexts(
  content: ModuleContent,
): ReadonlyMap<string, string> {
  return unitTexts(translatableUnits(content as unknown as Module));
}

/** Each unit's plain text, its parts joined. */
function unitTexts(
  units: readonly TranslatableUnit[],
): ReadonlyMap<string, string> {
  return new Map(
    units.map((unit) => [
      unit.blockId,
      unit.parts
        .map((part) => plainTextOf(part.content).text.trim())
        .filter((text) => text !== '')
        .join(' · '),
    ]),
  );
}

/** The blocks of a status that need work (not up to date), in document order. */
export function openBlocks(
  detail: StatusDetail,
): readonly Schema<'TranslationBlockStatus'>[] {
  return detail.meta.blocks.filter((b) => b.state !== 'up-to-date');
}

/** A job may still be cancelled: it is at the provider. */
export const cancellable = (job: JobItem): boolean =>
  job.attributes.state === 'sent';

export const JOB_STATE_TEXT: Readonly<
  Record<JobItem['attributes']['state'], string>
> = {
  sent: 'editor.translations.jobs.state.sent',
  returned: 'editor.translations.jobs.state.returned',
  cancelled: 'editor.translations.jobs.state.cancelled',
};

export const JOB_STATE_BADGE: Readonly<
  Record<JobItem['attributes']['state'], 'info' | 'success' | 'outline'>
> = {
  sent: 'info',
  returned: 'success',
  cancelled: 'outline',
};

/**
 * What a job sent, in words ("Delta export · <manual>"): a manual or a folder by its name
 * (by its ID while the names are not read), chosen modules by their number.
 */
export function jobSubjectText(
  subject: JobItem['attributes']['subject'],
  t: (key: string, params?: Record<string, unknown>) => string,
  names: {
    readonly manuals: ReadonlyMap<string, string>;
    readonly folders: ReadonlyMap<string, string>;
  },
): string {
  switch (subject.type) {
    case 'manual':
      return t('editor.translations.jobs.subject.manual', {
        name: names.manuals.get(subject.manualId) ?? subject.manualId,
      });
    case 'folder':
      return t('editor.translations.jobs.subject.folder', {
        name: names.folders.get(subject.folder) ?? subject.folder,
      });
    case 'modules':
      return t('editor.translations.jobs.subject.modules', {
        count: subject.moduleIds.length,
      });
    case 'designs':
      return t('editor.translations.jobs.subject.designs', {
        count: subject.designIds.length,
      });
    case 'manuals':
      return t('editor.translations.jobs.subject.manuals', {
        count: subject.manualIds.length,
      });
    case 'config':
      return t('editor.translations.jobs.subject.config');
  }
}

/**
 * A page design's region text (#568) per unit key (`<slot>.<block>`), as the panel shows it:
 * each region's text in `lang` (only where it has its own, `own`: a translation; else what it
 * shows there, the source language's for a missing one), each unit's plain text.
 */
export function designBlockTexts(
  regions: Regions,
  lang: string,
  source: string,
  own: boolean,
): ReadonlyMap<string, string> {
  const texts = new Map<string, string>();
  for (const slot of Object.keys(regions)) {
    const shown = regionIn(regions, slot, lang, source);
    if (shown.state === 'empty' || (own && shown.state !== 'own')) continue;
    const blocks = unitTexts(
      blockUnits((shown.blocks as Block[]).map(normalizeBlock)),
    );
    for (const [id, text] of blocks) texts.set(`${slot}.${id}`, text);
  }
  return texts;
}

/**
 * A manual's own text (#656) per unit key (`coverImage.…`), as the panel shows it: each cover
 * image's alternative text in `lang` (only where it has its own, `own`: a translation; else
 * what it shows there, the source language's).
 */
export function coverTexts(
  manifest: Pick<Manifest, 'coverImage'>,
  lang: string,
  source: string,
  own: boolean,
): ReadonlyMap<string, string> {
  const texts = new Map<string, string>();
  for (const { key, alt } of coverEntries(manifest)) {
    const text = own
      ? coverAltOwn(alt, lang, source)
      : (coverAltOwn(alt, lang, source) ?? coverAltSource(alt, source));
    if (text !== undefined) texts.set(key, text);
  }
  return texts;
}

/**
 * A manual's own text (#656, #731) per unit key (`title`, `group.…`, `coverImage.…`), as the
 * panel shows it: its title, its groups' titles and each cover image's alternative text in
 * `lang` (only where it has its own, `own`: a translation; else what it shows there, the source
 * language's).
 */
export function manualTexts(
  manifest: Pick<Manifest, 'title' | 'entries' | 'coverImage'>,
  lang: string,
  source: string,
  own: boolean,
): ReadonlyMap<string, string> {
  const texts = new Map<string, string>();
  for (const { key, text } of manifestTexts(manifest, source)) {
    const mine = ownTextIn(text, lang, source);
    const shown = own ? mine : (mine ?? sourceTextOf(text, source));
    if (shown !== undefined) texts.set(key, shown);
  }
  return texts;
}

/**
 * The project labels (#731) per unit key (`moduleTypes.<id>`, `facets.<id>.<value>`, …), as the
 * panel shows them: each in `lang` (only where it has its own, `own`; else the source
 * language's).
 */
export function configLabelTexts(
  config: LabelledConfig,
  lang: string,
  source: string,
  own: boolean,
): ReadonlyMap<string, string> {
  const texts = new Map<string, string>();
  for (const { key, text } of configTexts(config)) {
    const mine = ownTextIn(text, lang, source);
    const shown = own ? mine : (mine ?? sourceTextOf(text, source));
    if (shown !== undefined) texts.set(key, shown);
  }
  return texts;
}
