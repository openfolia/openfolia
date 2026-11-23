import { inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { injectTranslate, translated } from '@openfolia/ui/i18n';
import { ToastService } from '@openfolia/ui/toast';

import { ApiClient, toApiError } from '../api';
import type { TextChange, TextChangeRefusal } from '../doc-editor/text-fields';
import { injectFailureText } from '../session/failure-text';
import {
  afterApplied,
  afterUndone,
  changeOf,
  styleItems,
  type SuggestionItem,
  undoOf,
} from './suggestion-items';
import type { StyleReviewState } from './suggestions-panel.component';

/** The module a review is about. */
export interface StyleReviewSubject {
  readonly changeSetId: string;
  readonly lang: string;
  readonly moduleId: string;
}

/** What the review needs of the editor (the block editor). */
export interface SuggestionTarget {
  textOf(blockId: string, field: string): string | null;
  /** `textOf` on the document as it reads now, unaffected by later edits. */
  textsNow(): (blockId: string, field: string) => string | null;
  changeText(change: TextChange): 'applied' | TextChangeRefusal;
  showText(blockId: string, field: string): boolean;
}

/** The style review's own refusals, with a text of their own here. */
const FAILURES: Readonly<Record<string, string>> = {
  'rate-limited': 'editor.suggestions.failed.rateLimited',
  'style-review-busy': 'editor.suggestions.failed.busy',
  'style-review-timeout': 'editor.suggestions.failed.timeout',
  'style-review-unavailable': 'editor.suggestions.failed.unavailable',
  'too-large': 'editor.suggestions.failed.tooLarge',
};

const key = (s: StyleReviewSubject) =>
  JSON.stringify([s.changeSetId, s.lang, s.moduleId]);

/**
 * The module editor's style review (#247's model suggestions, #573): asks
 * `POST …/style-review` about the module as saved, keeps its suggestions as items against the
 * editor's text then, and applies, shows or dismisses them. Applying is one editor step (Undo in
 * the editor or in the toast takes it back) and is refused, never forced, when the field's text
 * is no longer what was reviewed. Nothing is stored: a reload or another module starts empty.
 */
@Injectable()
export class StyleReview {
  private readonly api = inject(ApiClient);
  private readonly toast = inject(ToastService);
  private readonly t = injectTranslate();
  private readonly failureText = injectFailureText();

  private readonly stateSignal = signal<StyleReviewState>('idle');
  private readonly itemsSignal = signal<readonly SuggestionItem[]>([]);
  private readonly errorSignal = signal<string | null>(null);
  private readonly announcementSignal = signal('');
  /** The module the items are about; a review answered for another one is dropped. */
  private about: string | null = null;
  /** Counts up with every review and reset: an answer for an older one is dropped. */
  private run = 0;
  /** The server has no style review: "Review style" is not offered again on this page. */
  private off = false;
  /** Whether the server was asked yet if it has a style review (`GET /style-review`). */
  private asked = false;

  readonly state = this.stateSignal.asReadonly();
  readonly items = this.itemsSignal.asReadonly();
  readonly error = this.errorSignal.asReadonly();
  readonly announcement = this.announcementSignal.asReadonly();

  /**
   * Asks the server once whether it has a style review (#247): without one, "Review style" is not
   * shown at all. Until it answers, and when it cannot (another error), the button is shown and
   * the first review's answer decides, as before.
   */
  async checkConfigured(): Promise<void> {
    if (this.asked) return;
    this.asked = true;
    try {
      const answer = await firstValueFrom(this.api.get('/style-review'));
      if (answer.data.attributes.configured) return;
      this.off = true;
      if (this.stateSignal() !== 'loading') {
        this.itemsSignal.set([]);
        this.stateSignal.set('off');
      }
    } catch {
      // Not known: the first review says.
      this.asked = false;
    }
  }

  /** Another module (or language, or change set): the list starts empty. */
  reset(subject: StyleReviewSubject | null): void {
    const next = subject ? key(subject) : null;
    if (next === this.about) return;
    this.about = next;
    this.run++;
    this.itemsSignal.set([]);
    this.errorSignal.set(null);
    this.announcementSignal.set('');
    this.stateSignal.set(this.off ? 'off' : 'idle');
  }

  /**
   * Reviews the module: `saved` first puts what is typed on the server (false: it could not, and
   * nothing is asked); the editor's text right after is what the suggestions are held against.
   */
  async review(
    subject: StyleReviewSubject,
    saved: () => Promise<boolean>,
    target: SuggestionTarget,
    unsaved: () => string,
  ): Promise<void> {
    if (this.stateSignal() === 'loading' || this.off) return;
    this.reset(subject);
    const run = ++this.run;
    const current = () => run === this.run && this.about === key(subject);
    this.stateSignal.set('loading');
    this.errorSignal.set(null);
    this.announcementSignal.set('');
    // The text as it is when the review is asked for, kept before it is saved: typing while the
    // save or the review runs makes a suggestion on that field stale, never applied to text the
    // model did not see.
    const snapshot = target.textsNow();
    if (!(await saved())) {
      if (!current()) return;
      this.stateSignal.set(this.itemsSignal().length > 0 ? 'done' : 'idle');
      this.errorSignal.set(this.t(unsaved()));
      return;
    }
    if (!current()) return;
    const texts = new Map<string, string | null>();
    const textOf = (blockId: string, field: string) => {
      const k = JSON.stringify([blockId, field]);
      if (!texts.has(k)) texts.set(k, snapshot(blockId, field));
      return texts.get(k) ?? null;
    };
    try {
      const answer = await firstValueFrom(
        this.api.act(
          '/change-sets/{changeSetId}/modules/{lang}/{moduleId}/style-review',
          { path: subject },
        ),
      );
      if (!current()) return;
      const items = styleItems(answer.data.attributes.suggestions, textOf);
      this.itemsSignal.set(items);
      this.stateSignal.set('done');
      this.announcementSignal.set(
        this.t('editor.suggestions.found', { count: items.length }),
      );
    } catch (failure) {
      if (!current()) return;
      const error = toApiError(failure);
      if (error.code === 'not-configured') {
        this.off = true;
        this.itemsSignal.set([]);
        this.stateSignal.set('off');
        // The section goes with "Review style": the toast says why.
        this.toast.error(translated('editor.suggestions.off'));
        return;
      }
      this.stateSignal.set(this.itemsSignal().length > 0 ? 'done' : 'idle');
      const known = FAILURES[error.code];
      this.errorSignal.set(
        known
          ? this.t(known, { retryAfter: error.retryAfter ?? 0 })
          : this.failureText(
              translated('editor.suggestions.failed.any'),
              error,
            ),
      );
    }
  }

  /** Applies `item` in the editor; the toast's Undo takes it back out. */
  apply(item: SuggestionItem, target: SuggestionTarget): void {
    const change = changeOf(item);
    // A second click on a row on its way out: it was applied already.
    if (!change || !this.listed(item)) return;
    const before = this.itemsSignal();
    const result = target.changeText(change);
    if (result !== 'applied') {
      this.itemsSignal.update((items) =>
        items.map((i) => (i.id === item.id ? { ...i, expected: null } : i)),
      );
      this.toast.error(translated('editor.suggestions.changed'));
      return;
    }
    this.itemsSignal.set(afterApplied(before, item));
    const about = this.about;
    this.toast.success(translated('editor.suggestions.applied'), {
      actionLabel: translated('ui.toast.undo'),
      onAction: () => {
        if (this.about !== about) return;
        if (target.changeText(undoOf(item)) !== 'applied') {
          this.toast.error(translated('editor.suggestions.undoChanged'));
          return;
        }
        this.itemsSignal.update((now) => afterUndone(now, before, item));
      },
    });
  }

  /** Brings the item's text into view (a legend: its image's callout panel opens on it). */
  show(item: SuggestionItem, target: SuggestionTarget): void {
    if (!this.listed(item)) return;
    if (!target.showText(item.blockId, item.field)) {
      this.itemsSignal.update((items) =>
        items.map((i) => (i.id === item.id ? { ...i, expected: null } : i)),
      );
    }
  }

  private listed(item: SuggestionItem): boolean {
    return this.itemsSignal().some((i) => i.id === item.id);
  }

  /** Takes the item off the list. */
  dismiss(item: SuggestionItem): void {
    this.itemsSignal.update((items) => items.filter((i) => i.id !== item.id));
  }
}
