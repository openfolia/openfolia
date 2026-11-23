import {
  computed,
  DestroyRef,
  inject,
  Injectable,
  InjectionToken,
  signal,
  untracked,
  type Signal,
} from '@angular/core';
import type { ProjectConfig } from '@openfolia/content-model/core';
import { firstValueFrom } from 'rxjs';

import { ApiClient, toApiError } from '../api';
import { labelsInUi } from '../i18n';
import { MeService } from '../permissions/me';
import type { Block } from './block-diff';
import { addCounts, NO_CHANGES, totalOf, type ChangeCounts } from './tree-diff';

/** A changed item's key: `module/<lang>/<id>` or `manual/<id>`. */
export type ItemKey = string;

/** What an item of the page knows about its changes, once read. */
export interface ItemSummary {
  /** Block or outline changes, by kind. */
  readonly counts: ChangeCounts;
  /** Changed details (title, audience…): each a change of its own for the navigation. */
  readonly fields: number;
  /** Its title on the newer side that has one. */
  readonly title: string;
  /** Its title changed. */
  readonly renamed: boolean;
}

/** A title read asked for the person before the one acting now. */
class StaleTitle extends Error {
  constructor() {
    super('Read for another person');
  }
}

/** At most this many module titles are read at once. */
const TITLE_READS = 4;

/**
 * What the items of the review page share: the project's configuration, module titles (read a
 * few at a time, once per commit), and what each item found changed, for the overview.
 * Provided by the review page.
 */
@Injectable()
export class ReviewContext {
  private readonly api = inject(ApiClient);
  private readonly me = inject(MeService).me;
  /** The page is gone: nothing more is read, a re-read for the next person included (#716). */
  private gone = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.gone = true;
      this.titles.clear();
      // Reads still waiting for their turn give up without asking.
      for (const next of this.waiting.splice(0)) next();
    });
  }

  /** The project's configuration (`GET /config`) as stored; null until read or when it failed. */
  readonly storedConfig = signal<ProjectConfig | null>(null);
  /** The configuration with its labels in the interface language (#731), for showing them. */
  readonly config = labelsInUi(this.storedConfig);

  private readonly summaries = signal<ReadonlyMap<ItemKey, ItemSummary>>(
    new Map(),
  );

  /** What an item found changed; undefined while it is read (a signal read: tracked). */
  summaryOf(key: ItemKey): ItemSummary | undefined {
    return this.summaries().get(key);
  }

  report(key: ItemKey, summary: ItemSummary): void {
    this.summaries.update((m) => new Map(m).set(key, summary));
  }

  /** Every item of the page reported: the changes in all of them. */
  readonly total = computed(() => {
    let counts = NO_CHANGES;
    let fields = 0;
    for (const s of this.summaries().values()) {
      counts = addCounts(counts, s.counts);
      fields += s.fields;
    }
    return totalOf(counts) + fields;
  });

  /** Forgets the summaries (another page of items, another change set). */
  reset(): void {
    this.summaries.set(new Map());
  }

  private readonly titles = new Map<string, Promise<string | null>>();
  private reading = 0;
  private readonly waiting: (() => void)[] = [];

  /**
   * A module's title at `ref` in `lang`; null when it is not there or not for this person. Kept
   * per person (#706): a read still waiting for its turn when another person acts is never sent,
   * and one answered after it is never handed on: either is asked again for the person acting now.
   */
  moduleTitle(lang: string, id: string, ref: string): Promise<string | null> {
    if (this.gone) return Promise.resolve(null);
    const who = this.person();
    const key = `${who}\n${ref}\n${lang}\n${id}`;
    let found = this.titles.get(key);
    if (!found) {
      const stale = () => new StaleTitle();
      const read: Promise<string | null> = this.turn()
        .then(() => {
          if (this.gone) return null;
          // Checked as it is sent: sent now, it would carry the next person's identity.
          if (who !== this.person()) throw stale();
          return firstValueFrom(
            this.api.get('/modules/{lang}/{id}', {
              path: { lang, id },
              query: { ref },
            }),
          );
        })
        .then(
          (doc) => {
            if (doc === null) return null;
            // Answered after another person acts: theirs to read again, not this one's to show.
            if (who !== this.person()) throw stale();
            return doc.data.attributes.title;
          },
          (error: unknown) => {
            if ([403, 404].includes(toApiError(error).status)) return null;
            throw error;
          },
        )
        .finally(() => this.done())
        .catch((error: unknown) => {
          if (!(error instanceof StaleTitle)) throw error;
          // Asked for the person before: whoever waits for it gets the one acting now's answer,
          // while the page is there.
          if (this.titles.get(key) === read) this.titles.delete(key);
          return this.gone ? null : this.moduleTitle(lang, id, ref);
        });
      // A failed read is tried again next time.
      read.catch(() => {
        if (this.titles.get(key) === read) this.titles.delete(key);
      });
      this.titles.set(key, read);
      found = read;
    }
    return found;
  }

  /** Who acts now (not tracked: a read is no reactive context). */
  private person(): string {
    return untracked(() => this.me().id);
  }

  private turn(): Promise<void> {
    return new Promise((resolve) => {
      if (this.reading < TITLE_READS) {
        this.reading += 1;
        resolve();
      } else this.waiting.push(resolve);
    });
  }

  private done(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.reading -= 1;
  }
}

/** How a list of compared blocks is shown. */
export type NodesMode =
  /** One column: deletions and insertions together. */
  | 'inline'
  /** One side of side by side. */
  | 'before'
  | 'after'
  /** The new version as a reader sees it, each change marked at its edge. */
  | 'rendered';

/**
 * What the blocks of one item share while they are drawn: which item, its two sides, the runs of
 * unchanged blocks opened, and the commits the images are read at. Provided by the item.
 */
export interface DiffItemContext {
  readonly key: Signal<ItemKey>;
  readonly lang: Signal<string>;
  readonly before: Signal<readonly Block[]>;
  readonly after: Signal<readonly Block[]>;
  /** The commits compared (images are read there). */
  readonly base: Signal<string>;
  readonly head: Signal<string>;
  /** The runs of unchanged blocks that are open, by their first block's ID. */
  readonly open: Signal<ReadonlySet<string>>;
  /** The module its review threads are on (`<lang>/<moduleId>`); null: no threads (a manual). */
  readonly commentModule: Signal<string | null>;
  toggle(run: string): void;
}

export const DIFF_ITEM = new InjectionToken<DiffItemContext>('DIFF_ITEM');

/** The element ID of a node of an item (`ghost`: the place it moved away from). */
export function anchorId(key: ItemKey, id: string, ghost = false): string {
  return `diff-${key.replace(/[^A-Za-z0-9_-]/g, '-')}-${ghost ? 'was-' : ''}${id}`;
}
