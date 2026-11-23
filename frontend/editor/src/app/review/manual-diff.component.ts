import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  forwardRef,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';

import { sameText } from '@openfolia/content-model/core';
import { injectTranslate } from '@openfolia/ui/i18n';
import { FadeInDirective } from '@openfolia/ui/smooth';
import {
  ErrorStateComponent,
  SkeletonRowsComponent,
} from '@openfolia/ui/states';

import { ApiClient, toApiError, type ApiError, type Schema } from '../api';
import { apiErrorText, UiTexts } from '../i18n';
import type { Block } from './block-diff';
import {
  DiffItemHeaderComponent,
  type ItemState,
} from './diff-item-header.component';
import type { ModuleLink } from './diff-outline.component';
import {
  compareManual,
  ManualDiffBodyComponent,
} from './manual-diff-body.component';
import { subjectKey } from './module-diff.component';
import {
  DIFF_ITEM,
  ReviewContext,
  type DiffItemContext,
} from './review-context';
import type { DiffView } from './module-diff-body.component';
import type { ChangeSetChange } from './review-model';
import { countChanges } from './tree-diff';

type Manual = Schema<'ManualResource'>;

const NO_BLOCKS: readonly Block[] = [];

/**
 * One manual of a change set, compared: its details (title, audience, variants, text
 * attributes) as a table of before and after, and its outline as a tree with the entries added,
 * removed, moved and renamed marked, each module linked to its own diff when it is on this page.
 */
@Component({
  selector: 'of-manual-diff',
  imports: [
    TranslocoPipe,
    ErrorStateComponent,
    SkeletonRowsComponent,
    DiffItemHeaderComponent,
    ManualDiffBodyComponent,
  ],
  providers: [
    { provide: DIFF_ITEM, useExisting: forwardRef(() => ManualDiffComponent) },
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  hostDirectives: [FadeInDirective],
  host: {
    class:
      'flex min-w-0 flex-col gap-4 px-4 py-6 transition-opacity duration-300 ease-out motion-reduce:transition-none sm:px-8',
    '[attr.id]': "'item-' + key()",
    '[class.shadow-[inset_3px_0_0_var(--color-ring)]]': 'focused()',
    '[class.opacity-60]': 'loading() && sides() !== null',
    '[attr.aria-busy]': 'loading() || null',
  },
  template: `
    <of-diff-item-header
      [title]="title()"
      [id]="manualId()"
      [kind]="'editor.review.diff.manual' | transloco"
      [state]="state()"
      [summary]="summary()"
      [focusParams]="focusParams()"
      [focused]="focused()"
    >
      <ng-content select="[ofItemActions]" />
    </of-diff-item-header>
    @if (view() !== 'inline') {
      <p
        class="text-muted-foreground m-0 text-xs break-words"
        data-slot="same-every-view"
      >
        {{ 'editor.review.diff.sameInEveryView' | transloco }}
      </p>
    }
    @if (loading() && !sides()) {
      <of-skeleton-rows
        [count]="3"
        [label]="'editor.review.diff.loading' | transloco"
      />
    } @else if (failure(); as f) {
      <of-error-state
        [kind]="f.kind"
        [message]="failureText()"
        (retry)="load()"
      />
    } @else if (change().meta.unreadable) {
      <p class="text-muted-foreground m-0 text-sm">
        {{ 'editor.review.diff.unreadable' | transloco }}
      </p>
    } @else {
      <of-manual-diff-body
        [key]="key()"
        [lang]="lang()"
        [comparison]="comparison()"
        [base]="base()"
        [head]="head()"
        [open]="open()"
        [link]="link()"
        (toggled)="toggle($event)"
      />
    }
  `,
})
export class ManualDiffComponent implements DiffItemContext {
  private readonly api = inject(ApiClient);
  private readonly review = inject(ReviewContext);
  private readonly texts = inject(UiTexts);
  private readonly t = injectTranslate();

  readonly change = input.required<ChangeSetChange>();
  /** The page's view: an outline is drawn alike in each, and says so outside inline (#452). */
  readonly view = input<DiffView>('inline');
  readonly base = input.required<string>();
  readonly head = input.required<string>();
  readonly focusParams = input<Record<string, string | null>>({});
  readonly focused = input(false);
  readonly open = input<ReadonlySet<string>>(new Set());
  /** Where a module's own diff is on this page. */
  readonly link = input<ModuleLink>(() => null);
  readonly toggled = output<string>();

  protected readonly sides = signal<{
    before: Manual | null;
    after: Manual | null;
  } | null>(null);
  protected readonly loading = signal(true);
  protected readonly failure = signal<ApiError | null>(null);
  private runs = 0;

  readonly key = computed(() => subjectKey(this.change()));
  /** Module titles are read in the source language. */
  readonly lang = computed(
    () => this.review.config()?.languages.source ?? 'en',
  );
  readonly before = signal(NO_BLOCKS).asReadonly();
  readonly after = signal(NO_BLOCKS).asReadonly();
  /** A manual's outline takes no review threads (they are on a module's blocks). */
  readonly commentModule = signal<string | null>(null).asReadonly();
  toggle(run: string): void {
    this.toggled.emit(run);
  }

  protected readonly manualId = computed(() => {
    const s = this.change().attributes.subject;
    return s.type === 'manual' ? s.manualId : '';
  });
  protected readonly title = computed(() => {
    const s = this.sides();
    // One per language, perhaps (#731): in the interface language.
    return this.texts.text(
      s?.after?.attributes.title ?? s?.before?.attributes.title,
      this.review.storedConfig()?.languages,
    );
  });
  protected readonly comparison = computed(() => {
    const s = this.sides();
    return compareManual(
      {
        before: s?.before?.attributes ?? null,
        after: s?.after?.attributes ?? null,
      },
      this.review.config(),
    );
  });
  protected readonly fields = computed(() => this.comparison().fields);
  protected readonly entries = computed(() => this.comparison().entries);
  protected readonly state = computed((): ItemState => {
    const change = this.change().meta.change;
    if (change !== 'changed') return change;
    const s = this.sides();
    return s?.before &&
      s.after &&
      !sameText(s.before.attributes.title, s.after.attributes.title)
      ? 'renamed'
      : 'changed';
  });
  protected readonly summary = computed(() =>
    this.review.summaryOf(this.key()),
  );
  protected readonly failureText = computed(() => {
    const f = this.failure();
    if (!f) return '';
    const text = apiErrorText(f);
    return this.t(text.key, text.params);
  });

  constructor() {
    const host = inject<ElementRef<HTMLElement>>(ElementRef);
    let scrolled = false;
    afterRenderEffect(() => {
      if (!this.focused()) {
        scrolled = false;
        return;
      }
      if (scrolled || this.loading()) return;
      scrolled = true;
      const reduce = window.matchMedia?.(
        '(prefers-reduced-motion: reduce)',
      ).matches;
      host.nativeElement.scrollIntoView?.({
        block: 'start',
        behavior: reduce ? 'auto' : 'smooth',
      });
    });
    effect(() => {
      this.change();
      this.base();
      this.head();
      untracked(() => void this.load());
    });
    effect(() => {
      if (!this.sides() || this.loading()) return;
      const summary = {
        counts: countChanges(this.entries()),
        fields: this.fields().length,
        title: this.title(),
        renamed: this.state() === 'renamed',
      };
      const key = this.key();
      untracked(() => this.review.report(key, summary));
    });
  }

  /** The subject the sides held are of. */
  private sidesOf = '';

  protected async load(): Promise<void> {
    const run = ++this.runs;
    const s = this.change().attributes.subject;
    // Another manual in this row: what it showed goes at once.
    const key = this.key();
    if (key !== this.sidesOf) this.sides.set(null);
    this.sidesOf = key;
    this.loading.set(true);
    this.failure.set(null);
    if (s.type !== 'manual' || this.change().meta.unreadable) {
      this.sides.set({ before: null, after: null });
      this.loading.set(false);
      return;
    }
    const change = this.change().meta.change;
    const read = (ref: string) =>
      firstValueFrom(
        this.api.get('/manuals/{id}', {
          path: { id: s.manualId },
          query: { ref },
        }),
      ).then((doc) => doc.data);
    try {
      const [before, after] = await Promise.all([
        change === 'added' ? null : read(this.base()),
        change === 'removed' ? null : read(this.head()),
      ]);
      if (run !== this.runs) return;
      this.sides.set({ before, after });
    } catch (error) {
      if (run !== this.runs) return;
      this.sides.set(null);
      this.failure.set(toApiError(error));
    }
    this.loading.set(false);
  }
}
