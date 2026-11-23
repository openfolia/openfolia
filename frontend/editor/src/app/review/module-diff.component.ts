import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';

import { injectTranslate, LanguageService } from '@openfolia/ui/i18n';
import { FadeInDirective } from '@openfolia/ui/smooth';
import {
  ErrorStateComponent,
  SkeletonRowsComponent,
} from '@openfolia/ui/states';

import { ApiClient, toApiError, type ApiError, type Schema } from '../api';
import { languageName } from '../content/browser-model';
import { apiErrorText } from '../i18n';
import {
  DiffItemHeaderComponent,
  type ItemState,
} from './diff-item-header.component';
import {
  compareModule,
  ModuleDiffBodyComponent,
  type DiffView,
  type ModuleSides,
} from './module-diff-body.component';
import { ReviewContext } from './review-context';
import type { ChangeSetChange } from './review-model';
import { ReviewComments } from './review-comments';
import { countChanges } from './tree-diff';

export type { DiffView } from './module-diff-body.component';

type Module = Schema<'ModuleResource'>;

/** A side as read: the module, or nothing there (added, removed, not visible). */
interface Sides {
  readonly before: Module | null;
  readonly after: Module | null;
}

/** A change's subject as one string: which module, manual or project file a row shows. */
export const subjectKey = (change: ChangeSetChange): string => {
  const s = change.attributes.subject;
  switch (s.type) {
    case 'module':
      return `module/${s.lang}/${s.moduleId}`;
    case 'manual':
      return `manual/${s.manualId}`;
    case 'config':
      return 'config';
    case 'term':
      return `term/${s.termId}`;
    case 'design':
      return `design/${s.designId}`;
    case 'template':
      return `template/${s.templateId}/${s.path}`;
  }
};

/**
 * One module of a change set, compared: its details (title, type, audience, facets, keywords)
 * as a table of before and after, and its blocks on the base commit and on the head, matched by
 * ID and drawn with the real block components (`of-diff-nodes`). Inline shows one version with
 * both sides' marks; side by side the two, row by row; rendered the new version as a reader
 * sees it, each change marked at its edge. What it found changed is reported to the page's
 * overview.
 */
@Component({
  selector: 'of-module-diff',
  imports: [
    TranslocoPipe,
    ErrorStateComponent,
    SkeletonRowsComponent,
    DiffItemHeaderComponent,
    ModuleDiffBodyComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  hostDirectives: [FadeInDirective],
  host: {
    class:
      'flex min-w-0 flex-col gap-4 px-4 py-6 transition-opacity duration-300 ease-out motion-reduce:transition-none sm:px-8',
    '[attr.id]': 'itemAnchor()',
    // The module the address points at: marked at its edge.
    '[class.shadow-[inset_3px_0_0_var(--color-ring)]]': 'focused()',
    // Read again (another commit): the sides shown stay, dimmed, until the new ones are there.
    '[class.opacity-60]': 'loading() && sides() !== null',
    '[attr.aria-busy]': 'loading() || null',
  },
  template: `
    <of-diff-item-header
      [title]="title()"
      [id]="moduleId()"
      [kind]="kindLine()"
      [state]="state()"
      [summary]="summary()"
      [focusParams]="focusParams()"
      [focused]="focused()"
    >
      <ng-content select="[ofItemActions]" />
    </of-diff-item-header>

    @if (loading() && !sides()) {
      <of-skeleton-rows
        [count]="4"
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
      <of-module-diff-body
        [key]="key()"
        [lang]="lang()"
        [moduleId]="moduleId()"
        [sides]="bodySides()"
        [comparison]="comparison()"
        [base]="base()"
        [head]="head()"
        [view]="view()"
        [open]="open()"
        [commentModule]="commentModule()"
        (toggled)="toggled.emit($event)"
      />
    }
  `,
})
export class ModuleDiffComponent {
  private readonly api = inject(ApiClient);
  private readonly language = inject(LanguageService);
  private readonly review = inject(ReviewContext);
  private readonly comments = inject(ReviewComments);
  private readonly t = injectTranslate();

  readonly change = input.required<ChangeSetChange>();
  /** The commit compared from (the change set's base) and to (its review head, or branch head). */
  readonly base = input.required<string>();
  readonly head = input.required<string>();
  readonly view = input<DiffView>('inline');
  /** The query parameters that point the address at this module (its title links there). */
  readonly focusParams = input<Record<string, string | null>>({});
  /** The address points at this module: marked, and scrolled to once it is there. */
  readonly focused = input(false);
  /** The runs of unchanged blocks opened, by their first block's ID. */
  readonly open = input<ReadonlySet<string>>(new Set());
  /** A run of unchanged blocks was opened or closed. */
  readonly toggled = output<string>();

  protected readonly sides = signal<Sides | null>(null);
  protected readonly loading = signal(true);
  protected readonly failure = signal<ApiError | null>(null);
  private runs = 0;
  /** The subject the sides held are of. */
  private sidesOf = '';

  // What the blocks drawn below read (through `of-module-diff-body`).
  readonly key = computed(() => subjectKey(this.change()));
  readonly lang = computed(() => {
    const s = this.change().attributes.subject;
    return s.type === 'module' ? s.lang : '';
  });
  protected readonly bodySides = computed((): ModuleSides => ({
    before: this.sides()?.before?.attributes ?? null,
    after: this.sides()?.after?.attributes ?? null,
  }));
  /** Its review threads' module (`<lang>/<moduleId>`). */
  readonly commentModule = computed(() => {
    const s = this.change().attributes.subject;
    return s.type === 'module' ? `${s.lang}/${s.moduleId}` : null;
  });
  protected readonly itemAnchor = computed(() => `item-${this.key()}`);

  protected readonly moduleId = computed(() => {
    const s = this.change().attributes.subject;
    return s.type === 'module' ? s.moduleId : '';
  });

  protected readonly title = computed(() => {
    const sides = this.sides();
    return (
      sides?.after?.attributes.title ?? sides?.before?.attributes.title ?? ''
    );
  });

  protected readonly kindLine = computed(() => {
    const sides = this.sides();
    const type =
      sides?.after?.attributes.moduleType ??
      sides?.before?.attributes.moduleType;
    const label = type
      ? (this.review.config()?.moduleTypes.find((m) => m.id === type)?.label ??
        type)
      : '';
    return [languageName(this.language.locale(), this.lang()), label]
      .filter(Boolean)
      .join(' · ');
  });

  protected readonly comparison = computed(() =>
    compareModule(this.bodySides(), this.review.config()),
  );
  protected readonly counts = computed(() =>
    countChanges(this.comparison().nodes),
  );

  protected readonly state = computed((): ItemState => {
    const change = this.change().meta.change;
    if (change !== 'changed') return change;
    const sides = this.sides();
    return sides?.before &&
      sides.after &&
      sides.before.attributes.title !== sides.after.attributes.title
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
    // Its review threads, for the change set shown and the person acting.
    effect(() => {
      const module = this.commentModule();
      this.comments.changeSetId();
      this.comments.resets();
      if (module) untracked(() => void this.comments.load(module));
    });
    // What it found, for the overview.
    effect(() => {
      const sides = this.sides();
      if (!sides || this.loading()) return;
      const counts = this.counts();
      const fields = this.comparison().fields.length;
      const title = this.title();
      const renamed = this.state() === 'renamed';
      const key = this.key();
      untracked(() =>
        this.review.report(key, { counts, fields, title, renamed }),
      );
    });
  }

  /** Reads the sides there are: an added module has no base, a removed one no head. */
  protected async load(): Promise<void> {
    const run = ++this.runs;
    const s = this.change().attributes.subject;
    const subject = s.type === 'module' ? s : null;
    // Another module (a row reused for the next one): its sides are not these. The same module
    // read at another commit keeps them, dimmed, until the new ones are there.
    const key = subjectKey(this.change());
    if (key !== this.sidesOf) this.sides.set(null);
    this.sidesOf = key;
    this.loading.set(true);
    this.failure.set(null);
    if (!subject || this.change().meta.unreadable) {
      this.sides.set({ before: null, after: null });
      this.loading.set(false);
      return;
    }
    const change = this.change().meta.change;
    const read = (ref: string) =>
      firstValueFrom(
        this.api.get('/modules/{lang}/{id}', {
          path: { lang: subject.lang, id: subject.moduleId },
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
