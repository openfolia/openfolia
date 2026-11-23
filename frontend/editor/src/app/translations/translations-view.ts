import { Injectable, signal } from '@angular/core';

import {
  idParam,
  intParam,
  listParam,
  oneOfParam,
  textParam,
} from '../view-state';
import {
  CELL_PATTERN,
  FOLDER_PATTERN,
  ID_PATTERN,
  LANG_PATTERN,
  ROW_PATTERN,
  STATES,
  STATUS_PAGE_SIZES,
} from './translations-model';

/** The most rows that may be chosen for an export at once. */
export const MAX_CHOSEN = 200;

/**
 * The Status tab's view in the address: the filters (manual, folder, language, state, search),
 * the page and its size, the chosen cell (its side panel) and the rows chosen for an export.
 * The page reads the filters and the chosen rows too: they are what "Create delta export" starts
 * from.
 */
export const STATUS_PARAMS = {
  manual: idParam(ID_PATTERN),
  folder: idParam(FOLDER_PATTERN),
  lang: idParam(LANG_PATTERN),
  state: oneOfParam(STATES),
  q: textParam({ max: 200 }),
  page: intParam(1),
  size: intParam(STATUS_PAGE_SIZES[1], { only: STATUS_PAGE_SIZES }),
  cell: idParam(CELL_PATTERN),
  rows: listParam(ROW_PATTERN, { max: MAX_CHOSEN }),
};

/** What the export dialog starts from: the filters and the chosen rows (`STATUS_PARAMS`). */
export const EXPORT_CONTEXT_PARAMS = {
  manual: STATUS_PARAMS.manual,
  folder: STATUS_PARAMS.folder,
  lang: STATUS_PARAMS.lang,
  rows: STATUS_PARAMS.rows,
  export: oneOfParam(['open'] as const),
};

/**
 * Tells the tabs of the Translations screen that what they show changed: an export was made, a
 * job cancelled (also after the page was left: a cancel waits for its Undo). Each reads again,
 * keeping its rows while it does.
 */
@Injectable({ providedIn: 'root' })
export class TranslationsChanges {
  private readonly count = signal(0);
  readonly changed = this.count.asReadonly();

  notify(): void {
    this.count.update((n) => n + 1);
  }
}
