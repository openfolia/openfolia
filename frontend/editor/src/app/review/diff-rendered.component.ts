import { HttpParams } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideMessageSquarePlus } from '@ng-icons/lucide';
import { firstValueFrom } from 'rxjs';

import { injectTranslate } from '@openfolia/ui/i18n';
import { ZardSelectImports } from '@openfolia/ui/select';
import { ZardSkeletonComponent } from '@openfolia/ui/skeleton';
import { ErrorStateComponent } from '@openfolia/ui/states';
import { ThemeService } from '@openfolia/ui/theme';

import { ApiClient, pageQuery, toApiError, type ApiError } from '../api';
import { apiErrorText, UiTexts } from '../i18n';
import { ReviewContext } from './review-context';
import { includesModule } from '../module-editor/module-model';
import { PreviewFrameComponent } from '../preview/preview-frame.component';
import {
  chooseVariant,
  type ManualItem,
  type VariantSummary,
} from '../preview/preview-model';
import { PreviewPages } from '../preview/preview-pages';
import { sectionTitle, shownNode, type BlockDiff } from './block-diff';
import { DiffCommentsComponent } from './diff-comments.component';
import { KIND_KEYS } from './diff-nodes.component';
import {
  markChanges,
  paletteOf,
  type FrameMark,
  type FrameTone,
} from './frame-marks';
import { DIFF_ITEM } from './review-context';
import { ReviewComments } from './review-comments';

const MANUAL_PAGES = 10;
const MANUAL_PAGE_SIZE = 100;
const EXCERPT = 80;

/** A change (or a block with threads) listed beside the page, in reading order. */
interface Entry {
  readonly node: BlockDiff;
  readonly tone: FrameTone | 'removed' | null;
  readonly symbol: string;
  readonly text: string;
  readonly excerpt: string;
  readonly elementId: string;
  /** Elements that stand for it when its own is not on the page (a new frame's content). */
  readonly alternatives: readonly string[];
}

const SYMBOLS = { added: '+', removed: '−', changed: '~', moved: '↕' } as const;

/**
 * A module's new version as a reader sees it: the API's HTML preview at the head commit, in the
 * sandboxed preview frame (`of-preview-frame`, its policy unchanged), in a variant of the
 * manuals that hold the module. Each change is marked on the page at its block (`frame-marks`),
 * and listed beside it, in words: a click goes to it on the page, `j`/`k` visit the list. What the
 * new version no longer has (a removed block) and what the chosen variant leaves out are named in
 * the list too. Each entry holds its review threads; a click on a block of the page starts one.
 */
@Component({
  selector: 'of-diff-rendered',
  imports: [
    TranslocoPipe,
    NgIcon,
    ErrorStateComponent,
    ZardSelectImports,
    ZardSkeletonComponent,
    PreviewFrameComponent,
    DiffCommentsComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideMessageSquarePlus })],
  host: { class: 'flex min-w-0 flex-col gap-3' },
  template: `
    <div class="flex min-w-0 flex-wrap items-center gap-2">
      @if (variants().length > 0) {
        <z-select
          class="w-auto max-w-56 min-w-28"
          zPosition="popper"
          [zAriaLabel]="'editor.preview.variant' | transloco"
          [zValue]="chosenVariant()?.slug ?? ''"
          (zSelectionChange)="pickVariant($event)"
        >
          @for (v of variants(); track v.slug) {
            <z-select-item [zValue]="v.slug">{{ v.label }}</z-select-item>
          }
        </z-select>
      }
      @if (hiddenCount() > 0) {
        <span class="text-muted-foreground text-xs">{{
          'editor.review.rendered.hidden' | transloco: { count: hiddenCount() }
        }}</span>
      }
    </div>

    @if (entries().length > 0) {
      <ol
        class="m-0 flex list-none flex-col gap-1.5 p-0"
        [attr.aria-label]="'editor.review.rendered.changes' | transloco"
      >
        @for (entry of entries(); track entry.node.id) {
          <li
            class="group/row border-border flex min-w-0 flex-col gap-2 rounded-md border-s-[3px] py-1 ps-3 pe-1 outline-none focus-visible:ring-2 focus-visible:ring-ring data-[current]:ring-2 data-[current]:ring-ring"
            [class]="edgeOf(entry)"
            [attr.data-hunk]="entry.tone ? entry.node.hunk : null"
            [attr.tabindex]="entry.tone ? -1 : null"
          >
            <p
              class="m-0 flex min-w-0 items-baseline gap-x-1.5 text-xs leading-5"
            >
              @if (entry.tone) {
                <span
                  class="shrink-0 font-mono font-medium"
                  [class]="toneOf(entry)"
                  aria-hidden="true"
                  >{{ entry.symbol }}</span
                >
              }
              <span class="min-w-0 break-words">
                @if (entry.text) {
                  <span class="font-medium" [class]="toneOf(entry)">{{
                    entry.text
                  }}</span>
                }
                @if (entry.excerpt) {
                  <span class="text-muted-foreground">
                    · “{{ entry.excerpt }}”</span
                  >
                }
                @if (entry.node.after) {
                  <button
                    type="button"
                    class="text-foreground focus-visible:ring-ring ms-1 rounded-sm px-0.5 underline underline-offset-2 outline-none focus-visible:ring-2"
                    (click)="show(entry)"
                  >
                    {{ 'editor.review.rendered.show' | transloco }}
                  </button>
                }
              </span>
              @if (canComment(entry)) {
                <button
                  type="button"
                  class="text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:ring-ring ms-auto flex shrink-0 items-center gap-1 rounded-md px-1.5 text-xs outline-none focus-visible:ring-2"
                  data-slot="comment-button"
                  [attr.aria-label]="commentLabel(entry)"
                  (click)="compose(entry.node.id)"
                >
                  <ng-icon name="lucideMessageSquarePlus" aria-hidden="true" />
                  {{ 'editor.review.comments.comment' | transloco }}
                </button>
              }
            </p>
            @if (module(); as m) {
              @if (hasThreads(entry)) {
                <of-diff-comments
                  [module]="m"
                  [blockId]="entry.node.id"
                  [anchor]="anchorText(entry)"
                />
              }
            }
          </li>
        }
      </ol>
    }

    <div class="bg-muted relative min-w-0 overflow-hidden rounded-xl p-2">
      @if (failure(); as f) {
        <of-error-state
          [kind]="f.kind"
          [message]="errorText(f)"
          (retry)="reload()"
        />
      } @else {
        @if (!document()) {
          <z-skeleton class="h-64 w-full rounded-lg" />
        }
        @if (document(); as doc) {
          <of-preview-frame
            class="bg-background w-full overflow-hidden rounded-lg"
            [class.opacity-60]="loading()"
            [document]="doc"
            [dark]="dark()"
            [fit]="true"
            [label]="'editor.review.rendered.frame' | transloco"
            (loaded)="mark()"
            (blockClick)="clicked($event)"
          />
        }
      }
    </div>
  `,
})
export class DiffRenderedComponent {
  private readonly api = inject(ApiClient);
  private readonly pages = inject(PreviewPages);
  private readonly theme = inject(ThemeService);
  private readonly comments = inject(ReviewComments);
  protected readonly item = inject(DIFF_ITEM);
  private readonly texts = inject(UiTexts);
  /** The page's configuration, for the variants' labels (#731); none outside a review or history. */
  private readonly review = inject(ReviewContext, { optional: true });
  private readonly t = injectTranslate();

  /** The module compared, and its compared blocks. */
  readonly moduleId = input.required<string>();
  readonly nodes = input.required<readonly BlockDiff[]>();

  protected readonly dark = computed(() => this.theme.resolved() === 'dark');
  protected readonly document = signal<string | null>(null);
  protected readonly loading = signal(false);
  protected readonly failure = signal<ApiError | null>(null);
  protected readonly hiddenCount = signal(0);
  private readonly manuals = signal<readonly ManualItem[] | null>(null);
  private readonly variant = signal<string | undefined>(undefined);
  private readonly reloads = signal(0);
  private images: readonly string[] = [];
  private runs = 0;
  private markFrame = 0;
  private manualRuns = 0;

  private readonly frame = viewChild(PreviewFrameComponent);

  protected readonly module = this.item.commentModule;

  /**
   * The variants of the manuals that hold the module at the head, each once, by their labels in
   * the interface language (#731).
   */
  protected readonly variants = computed((): VariantSummary[] => {
    const seen = new Set<string>();
    const found: VariantSummary[] = [];
    const config = this.review?.storedConfig();
    for (const manual of this.manuals() ?? []) {
      if (!includesModule(manual.attributes.entries, this.moduleId())) continue;
      for (const v of manual.meta.variants) {
        if (seen.has(v.slug)) continue;
        seen.add(v.slug);
        found.push({
          ...v,
          label: this.texts.variant(v.values, config, v.label),
        });
      }
    }
    return found;
  });
  protected readonly chosenVariant = computed(() =>
    chooseVariant(this.variants(), this.variant()),
  );

  /** The blocks with threads. */
  private readonly commented = computed((): ReadonlySet<string> => {
    const m = this.module();
    return m ? new Set(this.comments.threadsOf(m).keys()) : new Set();
  });

  /** The changes, the blocks with threads and the one a thread is being started on, in order. */
  protected readonly entries = computed((): Entry[] => {
    const out: Entry[] = [];
    const commented = this.commented();
    const at = this.comments.composing();
    const writing = at && at.module === this.module() ? at.blockId : null;
    const walk = (list: readonly BlockDiff[]) => {
      for (const node of list) {
        if (node.ghost) continue;
        const entry = this.entryOf(node);
        if (entry.tone || commented.has(node.id) || writing === node.id)
          out.push(entry);
        // What an added or removed block holds is listed only with threads (its tone is null).
        walk(node.children);
      }
    };
    walk(this.nodes());
    return out;
  });

  /** What the page marks: the changes of the new version. */
  private readonly marks = computed(
    (): (FrameMark & { alternatives: readonly string[] })[] =>
      this.entries()
        .filter(
          (e): e is Entry & { tone: FrameTone } =>
            e.tone !== null && e.tone !== 'removed',
        )
        .map((e) => ({
          elementId: e.elementId,
          tone: e.tone,
          text: `${e.symbol} ${e.text}`,
          alternatives: e.alternatives,
        })),
  );

  private readonly request = computed(
    () => {
      if (this.manuals() === null || !this.item.head()) return null;
      const variant = this.chosenVariant()?.slug ?? null;
      return {
        key: [
          this.item.head(),
          this.item.lang(),
          this.moduleId(),
          variant ?? '',
          this.reloads(),
        ].join('\n'),
        path: `/modules/${encodeURIComponent(this.item.lang())}/${encodeURIComponent(this.moduleId())}/preview`,
        variant,
      };
    },
    { equal: (a, b) => a?.key === b?.key },
  );

  constructor() {
    const destroyRef = inject(DestroyRef);
    effect(() => {
      const head = this.item.head();
      untracked(() => void this.loadManuals(head));
    });
    effect(() => {
      const request = this.request();
      untracked(() => void this.load(request));
    });
    // The changes known anew (threads, a thread started): the page marked again.
    // Another theme: the marks drawn in its colours.
    effect(() => {
      this.marks();
      this.dark();
      // Once the theme's class is on the page (its tokens resolved anew).
      untracked(() => {
        cancelAnimationFrame(this.markFrame);
        this.markFrame = requestAnimationFrame(() => this.mark());
      });
    });
    destroyRef.onDestroy(() => {
      cancelAnimationFrame(this.markFrame);
      this.runs++;
      this.manualRuns++;
      this.release();
    });
  }

  private entryOf(node: BlockDiff): Entry {
    const kind = this.kindWord(node);
    const module = this.moduleId();
    const elementId = `of-${module}--${node.id}`;
    const excerpt = this.excerptOf(node);
    const base = { node, excerpt, elementId, alternatives: [] as string[] };
    if (node.inherited || !node.hunk)
      return { ...base, tone: null, symbol: '', text: '' };
    switch (node.hunk) {
      case 'added':
        return {
          ...base,
          tone: 'added',
          symbol: SYMBOLS.added,
          text: node.wraps
            ? this.t('editor.review.mark.wrappedInPlain', { kind })
            : this.t('editor.review.mark.added', { kind }),
          // A new frame the page draws no element for: marked at what it holds.
          alternatives: node.wraps
            ? node.children.map((c) => `of-${module}--${c.id}`)
            : [],
        };
      case 'removed':
        return {
          ...base,
          tone: 'removed',
          symbol: SYMBOLS.removed,
          text: node.unwraps
            ? this.t('editor.review.mark.unwrapped', { kind })
            : this.t('editor.review.mark.removed', { kind }),
        };
      case 'moved':
        return {
          ...base,
          tone: 'moved',
          symbol: SYMBOLS.moved,
          text: this.movedText(node, kind),
        };
      default:
        return {
          ...base,
          tone: 'changed',
          symbol: SYMBOLS.changed,
          text: this.changedText(node, kind),
        };
    }
  }

  private kindWord(node: BlockDiff): string {
    const n = shownNode(node);
    const kind = n.kind === 'item' ? (n.step ? 'step' : 'item') : n.block.type;
    const key = KIND_KEYS[kind];
    return key ? this.t(key) : kind;
  }

  private movedText(node: BlockDiff, kind: string): string {
    const from = node.movedFrom?.parentId ?? null;
    const to = node.after ? this.parentOf(node.id) : null;
    if (from === to) return this.t('editor.review.mark.reordered', { kind });
    const title = sectionTitle(this.item.before(), from);
    return title
      ? this.t('editor.review.mark.movedFrom', { kind, section: title })
      : this.t('editor.review.mark.movedFromTop', { kind });
  }

  private changedText(node: BlockDiff, kind: string): string {
    const b = node.before?.kind === 'block' ? node.before.block : null;
    const a = node.after?.kind === 'block' ? node.after.block : null;
    if (b?.type === 'image' && a?.type === 'image' && b.asset !== a.asset)
      return this.t('editor.review.mark.imageReplaced');
    // Another file under the block: named even when its facts read the same.
    if (
      b?.type === 'attachment' &&
      a?.type === 'attachment' &&
      b.asset !== a.asset
    )
      return this.t('editor.review.mark.fileReplaced');
    const words = Object.values(node.texts).some((list) =>
      list.some((s) => s.op !== 'same'),
    );
    const moved = node.movedFrom ? ` · ${this.movedText(node, kind)}` : '';
    return (
      (words
        ? this.t('editor.review.mark.textChanged', { kind })
        : this.t('editor.review.mark.formatting', { kind })) + moved
    );
  }

  /** The parent of a node in the compared tree (null: the top level). */
  private parentOf(id: string): string | null {
    let found: string | null = null;
    const walk = (list: readonly BlockDiff[], parent: string | null): boolean =>
      list.some((n) => {
        if (n.id === id && !n.ghost) {
          found = parent;
          return true;
        }
        return walk(n.children, n.id);
      });
    walk(this.nodes(), null);
    return found;
  }

  private excerptOf(node: BlockDiff): string {
    const text = (node.texts['text'] ?? [])
      .filter((s) => (node.after ? s.op !== 'del' : s.op !== 'ins'))
      .map((s) => s.text)
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    return text.length > EXCERPT ? `${text.slice(0, EXCERPT - 1)}…` : text;
  }

  protected toneOf(entry: Entry): string {
    switch (entry.tone) {
      case 'added':
        return 'text-success';
      case 'removed':
        return 'text-destructive';
      case null:
        return 'text-muted-foreground';
      default:
        return 'text-info';
    }
  }

  protected edgeOf(entry: Entry): string {
    switch (entry.tone) {
      case 'added':
        return 'border-success';
      case 'removed':
        return 'border-destructive';
      case null:
        return 'border-transparent';
      default:
        return 'border-info';
    }
  }

  protected hasThreads(entry: Entry): boolean {
    const at = this.comments.composing();
    return (
      this.commented().has(entry.node.id) ||
      (at?.module === this.module() && at.blockId === entry.node.id)
    );
  }

  protected canComment(entry: Entry): boolean {
    return this.comments.canWrite() && !!this.module() && !!entry.tone;
  }

  protected commentLabel(entry: Entry): string {
    return this.t('editor.review.comments.commentOn', {
      kind: this.kindWord(entry.node),
    });
  }

  /** What a thread on the entry's block is on, in words. */
  protected anchorText(entry: Entry): string {
    return this.t('editor.review.comments.on', {
      kind: this.kindWord(entry.node),
    });
  }

  protected compose(blockId: string): void {
    const module = this.module();
    if (module) this.comments.composing.set({ module, blockId });
  }

  /** A block of the page clicked (`<module>--<block>`): a thread is started on it. */
  protected clicked(id: string): void {
    const prefix = `${this.moduleId()}--`;
    if (!id.startsWith(prefix) || !this.comments.canWrite()) return;
    const blockId = id.slice(prefix.length);
    const known = (list: readonly BlockDiff[]): boolean =>
      list.some((n) => (n.id === blockId && !n.ghost) || known(n.children));
    if (known(this.nodes())) this.compose(blockId);
  }

  /** Scrolls the page to an entry's block. */
  protected show(entry: Entry): void {
    const doc = this.frame()?.content();
    if (!doc) return;
    const el = [entry.elementId, ...entry.alternatives]
      .map((id) => Document.prototype.getElementById.call(doc, id))
      .find((x): x is HTMLElement => !!x);
    const reduce = window.matchMedia?.(
      '(prefers-reduced-motion: reduce)',
    ).matches;
    if (el)
      Element.prototype.scrollIntoView.call(el, {
        block: 'center',
        behavior: reduce ? 'auto' : 'smooth',
      });
  }

  protected pickVariant(value: string | string[]): void {
    const slug = Array.isArray(value) ? value[0] : value;
    if (slug) this.variant.set(slug);
  }

  protected reload(): void {
    this.reloads.update((n) => n + 1);
  }

  protected errorText(error: ApiError): string {
    const text = apiErrorText(error);
    return this.t(text.key, text.params);
  }

  /** Marks the changes on the page in view; counts those the variant leaves out. */
  protected mark(): void {
    const doc = this.frame()?.content();
    if (!doc || !this.document()) return;
    const missing = markChanges(
      doc,
      this.marks().map((m) => {
        const present = [m.elementId, ...m.alternatives].find(
          (id) => !!Document.prototype.getElementById.call(doc, id),
        );
        return { ...m, elementId: present ?? m.elementId };
      }),
      paletteOf(getComputedStyle(document.documentElement)),
    );
    this.hiddenCount.set(missing.length);
  }

  private release(): void {
    for (const url of this.images) URL.revokeObjectURL(url);
    this.images = [];
  }

  private async load(
    request: DiffRenderedComponent['request'] extends () => infer R ? R : never,
  ): Promise<void> {
    const run = ++this.runs;
    if (!request) {
      this.loading.set(false);
      return;
    }
    this.loading.set(true);
    this.failure.set(null);
    try {
      let params = new HttpParams()
        .set('theme', 'light')
        .set('ref', this.item.head());
      if (request.variant) params = params.set('variant', request.variant);
      const read = await this.pages.read(
        request.path,
        params,
        () => run === this.runs,
      );
      if (!read) return;
      this.release();
      this.images = [...read.images.values()];
      this.document.set(this.pages.document(read, this.dark()));
    } catch (error) {
      if (run !== this.runs) return;
      this.failure.set(toApiError(error));
    }
    if (run === this.runs) this.loading.set(false);
  }

  /** The manuals at the head (for the variants); none: the module is shown without one. */
  private async loadManuals(head: string): Promise<void> {
    const run = ++this.manualRuns;
    // Another head: its variants are not known yet (no read with an old one).
    this.manuals.set(null);
    if (!head) return;
    const found: ManualItem[] = [];
    try {
      for (let page = 1; page <= MANUAL_PAGES; page++) {
        const doc = await firstValueFrom(
          this.api.get('/manuals', {
            query: {
              ref: head,
              ...pageQuery({ number: page, size: MANUAL_PAGE_SIZE }),
            },
          }),
        );
        for (const manual of doc.data) {
          if ('attributes' in manual) found.push(manual);
        }
        if (!doc.links.next) break;
      }
    } catch {
      // No variants to choose from.
    }
    if (run === this.manualRuns) this.manuals.set(found);
  }
}
