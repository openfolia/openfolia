import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideChevronRight,
  lucideChevronsUpDown,
  lucideMessageSquarePlus,
  lucidePaperclip,
} from '@ng-icons/lucide';
import type { SafetySeverity } from '@openfolia/content-model/core';
import {
  PageBreakBlockComponent,
  SafetyNoticeComponent,
  FaqEntryComponent,
  VariantBlockComponent,
  type VariantCondition,
} from '@openfolia/ui/blocks';
import { CollapseComponent } from '@openfolia/ui/collapse';
import {
  DiffDeletedComponent,
  DiffInsertedComponent,
} from '@openfolia/ui/diff-marks';
import { injectTranslate } from '@openfolia/ui/i18n';

import {
  conditionChips,
  safetyLevel,
  signalWords,
} from '../doc-editor/blocks/doc-blocks-context';
import {
  sectionTitle,
  shownNode,
  type Block,
  type BlockDiff,
  type BlockNode,
  inlineDetailsOf,
} from './block-diff';
import { AlignSidesDirective } from './align-sides.directive';
import { DiffCommentsComponent } from './diff-comments.component';
import { DiffImageComponent } from './diff-image.component';
import { DiffReferenceComponent } from './diff-reference.component';
import {
  anchorId,
  DIFF_ITEM,
  ReviewContext,
  type NodesMode,
} from './review-context';
import { ReviewComments } from './review-comments';
import {
  inlineDetailChanges,
  type InlineDetail,
  type Segment,
} from './review-diff';
import { foldUnchanged, type Shown } from './tree-diff';

/** The name of each inline detail's kind (translation keys, written out in full). */
const INLINE_KINDS: Record<string, string> = {
  strong: 'editor.review.inline.kind.strong',
  emphasis: 'editor.review.inline.kind.emphasis',
  code: 'editor.review.inline.kind.code',
  ui: 'editor.review.inline.kind.ui',
  sub: 'editor.review.inline.kind.sub',
  sup: 'editor.review.inline.kind.sup',
  link: 'editor.review.inline.kind.link',
  xref: 'editor.review.inline.kind.xref',
  attribute: 'editor.review.inline.kind.attribute',
  kbd: 'editor.review.inline.kind.kbd',
};

/** How a list of nodes is shown: one of the node modes, or both sides in aligned rows. */
export type ListMode = NodesMode | 'side';

/** The words for a node's kind (a new paragraph, a removed safety notice…). */
export const KIND_KEYS: Readonly<Record<string, string>> = {
  paragraph: 'editor.review.kind.paragraph',
  section: 'editor.review.kind.section',
  list: 'editor.review.kind.list',
  item: 'editor.review.kind.item',
  step: 'editor.review.kind.step',
  procedure: 'editor.review.kind.procedure',
  table: 'editor.review.kind.table',
  image: 'editor.review.kind.image',
  attachment: 'editor.review.kind.attachment',
  safety: 'editor.review.kind.safety',
  admonition: 'editor.review.kind.admonition',
  faq: 'editor.review.kind.faq',
  variant: 'editor.review.kind.variant',
  moduleRef: 'editor.review.kind.moduleRef',
  literal: 'editor.review.kind.literal',
  passthrough: 'editor.review.kind.passthrough',
  pageBreak: 'editor.review.kind.pageBreak',
};

const ADMONITION_KEYS: Readonly<Record<string, string>> = {
  note: 'editor.review.admonition.note',
  tip: 'editor.review.admonition.tip',
  important: 'editor.review.admonition.important',
};

/** The mark beside a change: its symbol (never the colour alone) and its colours. */
interface Mark {
  readonly symbol: string;
  readonly text: string;
  readonly tone: string;
  /** Where the other place of a move is, and what the link says. */
  readonly jump?: { readonly target: string; readonly label: string };
}

const TONES = {
  added: 'text-success',
  removed: 'text-destructive',
  changed: 'text-info',
  moved: 'text-info',
  ghost: 'text-muted-foreground',
} as const;

/** The edge and tint of a row, by its change, in inline and side by side. */
const ROWS = {
  added: 'border-success bg-success-muted/70',
  removed: 'border-destructive bg-destructive-muted/70',
  changed: 'border-info',
  moved: 'border-info border-dashed',
  ghost: 'border-muted-foreground/50 border-dashed',
  wrap: 'border-success',
  same: 'border-transparent',
} as const;

const SYMBOLS = {
  added: '+',
  removed: '−',
  changed: '~',
  moved: '↕',
  ghost: '↳',
  bullet: '•',
} as const;

/**
 * A list of compared blocks (a module's, or what a block holds), drawn with the real block
 * components: a safety notice in its level's colours, a variant block's frame with its
 * condition, a module reference's card, an image with its picture. Each change is marked at the
 * block's edge with a symbol and named in words (added, removed, changed, moved from …, wrapped
 * in …), with a tint for a whole block added or removed; changed text marks its words. Runs of
 * unchanged blocks fold away, one block of context kept beside each change. Draws itself again
 * for what a block holds.
 */
@Component({
  selector: 'of-diff-nodes',
  imports: [
    NgTemplateOutlet,
    TranslocoPipe,
    NgIcon,
    CollapseComponent,
    DiffInsertedComponent,
    DiffDeletedComponent,
    SafetyNoticeComponent,
    FaqEntryComponent,
    VariantBlockComponent,
    DiffImageComponent,
    DiffReferenceComponent,
    DiffCommentsComponent,
    AlignSidesDirective,
    PageBreakBlockComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideChevronRight,
      lucideChevronsUpDown,
      lucideMessageSquarePlus,
      lucidePaperclip,
    }),
  ],
  host: { class: 'flex min-w-0 flex-col gap-2' },
  template: `
    @for (entry of shown(); track trackOf(entry)) {
      @if (entry.kind === 'run') {
        @let open = item.open().has(entry.key);
        <div class="flex min-w-0 flex-col" data-slot="unchanged-run">
          <button
            type="button"
            class="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex items-center gap-1.5 self-start rounded-md px-1 py-0.5 text-xs outline-none focus-visible:ring-2"
            [attr.aria-expanded]="open"
            (click)="item.toggle(entry.key)"
          >
            <ng-icon
              name="lucideChevronRight"
              class="transition-transform duration-200 motion-reduce:transition-none"
              [class.rotate-90]="open"
              aria-hidden="true"
            />
            {{
              (open ? 'editor.review.fold.hide' : 'editor.review.fold.show')
                | transloco: { count: entry.nodes.length }
            }}
          </button>
          <of-collapse [open]="open">
            <div class="flex flex-col gap-2 pt-2">
              @for (node of entry.nodes; track node.id) {
                <ng-container
                  *ngTemplateOutlet="row; context: { $implicit: node }"
                />
              }
            </div>
          </of-collapse>
        </div>
      } @else {
        <ng-container
          *ngTemplateOutlet="row; context: { $implicit: entry.node }"
        />
      }
    }

    <ng-template #row let-node>
      @if (mode() === 'side') {
        <!-- Both sides in one row: what one side lacks faces a gap of its height. -->
        <div
          class="grid min-w-0 grid-cols-2 gap-x-4"
          data-slot="side-row"
          ofAlignSides
        >
          @for (side of sides; track side) {
            @if (hasSide(node, side)) {
              <of-diff-nodes
                [nodes]="[node]"
                [mode]="side"
                [fold]="false"
                [parentId]="parentId()"
                [level]="level()"
              />
            } @else {
              <div
                class="bg-muted/40 min-h-6 rounded-md bg-[repeating-linear-gradient(-45deg,transparent_0_6px,var(--color-border)_6px_7px)]"
                aria-hidden="true"
              ></div>
            }
          }
        </div>
      } @else {
        @let mark = markOf(node);
        <div
          class="group/row relative min-w-0 rounded-e-md border-s-[3px] py-1 ps-3 pe-1 scroll-mt-24 outline-none focus-visible:ring-2 focus-visible:ring-ring data-[current]:ring-2 data-[current]:ring-ring"
          [class]="rowClass(node)"
          [attr.id]="anchorOf(node)"
          [attr.data-align]="alignKey(node)"
          [attr.data-hunk]="hunkHere(node) ? node.hunk : null"
          [attr.data-change]="node.ghost ? 'ghost' : node.change"
          [attr.tabindex]="hunkHere(node) || node.ghost ? -1 : null"
        >
          @if (mark) {
            <p
              class="m-0 mb-1 flex items-baseline gap-x-1.5 text-xs leading-5 font-medium"
              [class]="mark.tone"
            >
              <span class="shrink-0 font-mono" aria-hidden="true">{{
                mark.symbol
              }}</span>
              <span class="min-w-0 break-words"
                >{{ mark.text }}
                @if (mark.jump; as jump) {
                  <button
                    type="button"
                    class="text-foreground focus-visible:ring-ring ms-1 rounded-sm px-0.5 font-normal underline underline-offset-2 outline-none focus-visible:ring-2"
                    (click)="jumpTo(jump.target)"
                  >
                    {{ jump.label }}
                  </button>
                }
              </span>
              @if (canComment(node)) {
                <ng-container
                  *ngTemplateOutlet="
                    commentButton;
                    context: { $implicit: node }
                  "
                />
              }
            </p>
          } @else if (canComment(node)) {
            <p class="m-0 mb-1 flex justify-end">
              <ng-container
                *ngTemplateOutlet="commentButton; context: { $implicit: node }"
              />
            </p>
          }
          @if (!node.ghost || mode() === 'before') {
            <ng-container
              *ngTemplateOutlet="content; context: { $implicit: node }"
            />
          }
          @if (threadsShown(node); as module) {
            <of-diff-comments
              class="mt-2"
              [module]="module"
              [blockId]="node.id"
              [anchor]="anchorText(node)"
            />
          }
        </div>
      }
    </ng-template>

    <ng-template #content let-node>
      @switch (typeOf(node)) {
        @case ('item') {
          @let it = itemOf(node);
          <div class="flex min-w-0 gap-2.5">
            @if (it.step) {
              <span
                class="border-border bg-muted mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border text-[0.6875rem] font-semibold"
                aria-hidden="true"
                >{{ it.ordinal }}</span
              >
            } @else {
              <span
                class="text-muted-foreground w-4 shrink-0 text-end text-sm leading-6"
                aria-hidden="true"
                >{{ it.ordered ? it.ordinal + '.' : bullet }}</span
              >
            }
            <div class="flex min-w-0 flex-1 flex-col gap-2">
              <p class="m-0 text-sm leading-6 break-words">
                <ng-container
                  *ngTemplateOutlet="text; context: { $implicit: node }"
                />
              </p>
              <ng-container
                *ngTemplateOutlet="held; context: { $implicit: node }"
              />
            </div>
          </div>
        }
        @case ('paragraph') {
          <p class="m-0 text-sm leading-6 break-words whitespace-pre-line">
            <ng-container
              *ngTemplateOutlet="text; context: { $implicit: node }"
            />
          </p>
        }
        @case ('section') {
          <div
            role="heading"
            [attr.aria-level]="headingLevel()"
            class="m-0 pt-1 leading-6 font-semibold break-words"
            [class]="level() <= 1 ? 'text-base' : 'text-sm'"
          >
            <ng-container
              *ngTemplateOutlet="text; context: { $implicit: node }"
            />
          </div>
          <div class="mt-2">
            <of-diff-nodes
              [nodes]="node.children"
              [mode]="mode()"
              [parentId]="node.id"
              [level]="level() + 1"
            />
          </div>
        }
        @case ('procedure') {
          @if (hasText(node)) {
            <p class="m-0 mb-2 text-sm leading-6 font-semibold break-words">
              <ng-container
                *ngTemplateOutlet="text; context: { $implicit: node }"
              />
            </p>
          }
          <ng-container
            *ngTemplateOutlet="held; context: { $implicit: node }"
          />
        }
        @case ('list') {
          <ng-container
            *ngTemplateOutlet="held; context: { $implicit: node }"
          />
        }
        @case ('image') {
          <of-diff-image [node]="node" [mode]="imageMode()" />
        }
        @case ('attachment') {
          <!-- In the attachment block's frame: its facts (name, file, type, size,
               description) marked word by word; the file is never shown. -->
          <div
            class="border-border bg-card flex min-w-0 items-center gap-3 rounded-xl border p-2"
            data-slot="diff-attachment"
          >
            <span
              class="bg-muted text-muted-foreground grid size-9 shrink-0 place-items-center rounded-md"
              aria-hidden="true"
            >
              <ng-icon name="lucidePaperclip" size="18" />
            </span>
            <p class="m-0 min-w-0 text-sm leading-6 [overflow-wrap:anywhere]">
              <ng-container
                *ngTemplateOutlet="text; context: { $implicit: node }"
              />
            </p>
          </div>
        }
        @case ('safety') {
          @let safety = safetyOf(node);
          <of-safety-notice
            [level]="safety.level"
            [signalWord]="safety.word"
            [body]="true"
          >
            <p class="m-0 mb-2 font-semibold">
              <ng-container
                *ngTemplateOutlet="text; context: { $implicit: node }"
              />
            </p>
            <ng-container
              *ngTemplateOutlet="held; context: { $implicit: node }"
            />
          </of-safety-notice>
        }
        @case ('admonition') {
          <div
            class="border-info/40 bg-info-muted/40 rounded-lg border px-4 py-3"
            role="note"
          >
            <p class="text-info m-0 mb-2 text-xs font-semibold">
              {{ admonitionWord(node) }}
            </p>
            <ng-container
              *ngTemplateOutlet="held; context: { $implicit: node }"
            />
          </div>
        }
        @case ('faq') {
          <of-faq-entry [label]="'editor.review.kind.faq' | transloco">
            <p class="m-0 mb-2 text-base font-semibold">
              <ng-container
                *ngTemplateOutlet="text; context: { $implicit: node }"
              />
            </p>
            <ng-container
              *ngTemplateOutlet="held; context: { $implicit: node }"
            />
          </of-faq-entry>
        }
        @case ('variant') {
          <of-variant-block [conditions]="chipsOf(node)" [editable]="false">
            <ng-container
              *ngTemplateOutlet="held; context: { $implicit: node }"
            />
          </of-variant-block>
        }
        @case ('moduleRef') {
          <of-diff-reference
            [moduleId]="refOf(node)"
            [old]="mode() === 'before' || !node.after"
          />
        }
        @case ('table') {
          @if (hasText(node)) {
            <p class="m-0 mb-1 text-sm font-semibold break-words">
              <ng-container
                *ngTemplateOutlet="text; context: { $implicit: node }"
              />
            </p>
          }
          <div class="max-w-full overflow-x-auto" data-hscroll>
            <table class="border-border w-full border-collapse border text-sm">
              <tbody>
                @for (row of tableRows(node); track $index) {
                  <tr>
                    @for (cell of row; track $index) {
                      <td
                        class="border-border border p-2 align-top"
                        [attr.colspan]="cell.colspan"
                        [attr.rowspan]="cell.rowspan"
                      >
                        <of-diff-nodes
                          [nodes]="cell.nodes"
                          [mode]="mode()"
                          [parentId]="node.id"
                          [level]="level()"
                          [fold]="false"
                        />
                      </td>
                    }
                  </tr>
                }
              </tbody>
            </table>
          </div>
          @if (tableLeftovers(node).length) {
            <of-diff-nodes
              class="mt-2"
              [nodes]="tableLeftovers(node)"
              [mode]="mode()"
              [parentId]="node.id"
              [level]="level()"
            />
          }
        }
        @case ('literal') {
          @if (languageOf(node); as language) {
            <p
              class="text-muted-foreground m-0 mb-1 font-mono text-xs break-all"
            >
              {{ language }}
            </p>
          }
          <pre
            data-hscroll
            class="bg-muted m-0 overflow-x-auto rounded-md p-3 font-mono text-xs leading-5 whitespace-pre-wrap"
          ><ng-container *ngTemplateOutlet="text; context: { $implicit: node }" /></pre>
        }
        @case ('pageBreak') {
          <of-page-break-block
            [label]="'editor.docEditor.pageBreak.label' | transloco"
          />
        }
        @default {
          <p class="m-0 text-sm leading-6 break-words">
            <span class="text-muted-foreground me-1.5 text-xs font-medium">{{
              kindWord(node)
            }}</span>
            <ng-container
              *ngTemplateOutlet="text; context: { $implicit: node }"
            />
          </p>
          <ng-container
            *ngTemplateOutlet="held; context: { $implicit: node }"
          />
        }
      }
    </ng-template>

    <!-- Starts a review thread on a changed block: in its gutter line, in sight without a hover. -->
    <ng-template #commentButton let-node>
      <button
        type="button"
        class="text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:ring-ring ms-auto flex shrink-0 items-center gap-1 self-start rounded-md px-1.5 text-xs font-normal outline-none focus-visible:ring-2"
        data-slot="comment-button"
        [attr.aria-label]="commentLabel(node)"
        (click)="compose(node)"
      >
        <ng-icon name="lucideMessageSquarePlus" aria-hidden="true" />
        {{ 'editor.review.comments.comment' | transloco }}
      </button>
    </ng-template>

    <!-- What a block holds, one level in. -->
    <ng-template #held let-node>
      @if (node.children.length) {
        <of-diff-nodes
          [nodes]="node.children"
          [mode]="mode()"
          [parentId]="node.id"
          [level]="level()"
        />
      }
    </ng-template>

    <!-- A node's text with its marks: both (inline), one side's, or the new text alone. -->
    <ng-template #text let-node>
      @for (s of segmentsOf(node); track $index) {
        @if (s.op === 'ins') {
          <ins of-diff-inserted>{{ s.text }}</ins>
        } @else if (s.op === 'del') {
          <del of-diff-deleted>{{ s.text }}</del>
        } @else {
          <span>{{ s.text }}</span>
        }
      }
    </ng-template>
  `,
})
export class DiffNodesComponent {
  protected readonly item = inject(DIFF_ITEM);
  private readonly review = inject(ReviewContext);
  private readonly comments = inject(ReviewComments);
  private readonly t = injectTranslate();

  readonly nodes = input.required<readonly BlockDiff[]>();
  readonly mode = input<ListMode>('inline');
  /** The block these nodes are held by (null: the module's top level). */
  readonly parentId = input<string | null>(null);
  /** The level of a section here: 1 at the module's top level. */
  readonly level = input(1);
  /** Fold runs of unchanged blocks. */
  readonly fold = input(true);

  protected readonly sides = ['before', 'after'] as const;
  protected readonly bullet = SYMBOLS.bullet;

  /** The nodes this mode shows: one side's, or both. */
  /**
   * The nodes this mode shows: one side's, or both. Folding is decided on all of them first,
   * so both sides of side by side fold the same runs.
   */
  protected readonly shown = computed((): Shown<BlockNode>[] => {
    const mode = this.mode();
    const keep = (list: readonly BlockDiff[]): BlockDiff[] =>
      list.flatMap((n) => {
        if (mode === 'before') {
          // A wrap was not there before: what it holds stood in its place.
          if (n.change === 'added') return n.wraps ? keep(n.children) : [];
          // A node moved here stood elsewhere (its ghost shows it there).
          if (n.movedFrom) return [];
          return [n];
        }
        if (mode === 'after' || mode === 'rendered') {
          return n.change === 'removed' || n.ghost ? [] : [n];
        }
        return [n];
      });
    const pinned = this.pinned();
    const entries: Shown<BlockNode>[] = this.fold()
      ? foldUnchanged(this.nodes(), 1, pinned)
      : this.nodes().map((node) => ({ kind: 'node', node }));
    return entries.flatMap((entry): Shown<BlockNode>[] =>
      entry.kind === 'run'
        ? [{ ...entry, nodes: keep(entry.nodes) }]
        : keep([entry.node]).map((node) => ({ kind: 'node', node })),
    );
  });

  /** The blocks of this module with review threads. */
  private readonly commented = computed((): ReadonlySet<string> => {
    const module = this.item.commentModule();
    return module
      ? new Set(this.comments.threadsOf(module).keys())
      : new Set<string>();
  });

  /** A node with threads on it or in it: kept when unchanged runs fold. */
  private readonly pinned = computed(() => {
    const commented = this.commented();
    const holds = (n: BlockDiff): boolean =>
      commented.has(n.id) || n.children.some(holds);
    return commented.size ? holds : () => false;
  });

  /** Where a node's threads are drawn: once, on the side that shows it (a removal's old side). */
  private commentSide(node: BlockDiff): boolean {
    if (node.ghost) return false;
    switch (this.mode()) {
      case 'inline':
        return true;
      case 'before':
        return node.change === 'removed';
      case 'after':
        return node.change !== 'removed';
      default:
        return false;
    }
  }

  /** The module to draw the node's threads for, when it has any or one is being written. */
  protected threadsShown(node: BlockDiff): string | null {
    const module = this.item.commentModule();
    if (!module || !this.commentSide(node)) return null;
    const at = this.comments.composing();
    const writing = at?.module === module && at.blockId === node.id;
    return writing || this.commented().has(node.id) ? module : null;
  }

  /** A changed block takes a new thread from who may write. */
  protected canComment(node: BlockDiff): boolean {
    return (
      this.comments.canWrite() &&
      !!this.item.commentModule() &&
      !!node.hunk &&
      this.commentSide(node)
    );
  }

  protected commentLabel(node: BlockDiff): string {
    return this.t('editor.review.comments.commentOn', {
      kind: this.kindWord(node),
    });
  }

  /** What a thread on the node is on, in words. */
  protected anchorText(node: BlockDiff): string {
    return this.t('editor.review.comments.on', { kind: this.kindWord(node) });
  }

  protected compose(node: BlockDiff): void {
    const module = this.item.commentModule();
    if (module) this.comments.composing.set({ module, blockId: node.id });
  }

  /** What a row is matched by on the other side of side by side. */
  protected alignKey(node: BlockDiff): string | null {
    const mode = this.mode();
    if (mode !== 'before' && mode !== 'after') return null;
    return node.ghost ? `was:${node.id}` : node.id;
  }

  protected trackOf(entry: Shown<BlockNode>): string {
    return entry.kind === 'run'
      ? `run:${entry.key}`
      : `${entry.node.ghost ? 'was:' : ''}${entry.node.id}`;
  }

  protected readonly headingLevel = computed(() =>
    Math.min(6, this.level() + 3),
  );

  protected readonly imageMode = computed((): NodesMode => {
    const mode = this.mode();
    return mode === 'side' ? 'inline' : mode;
  });

  /** Whether a side of side by side shows the node. */
  protected hasSide(node: BlockDiff, side: 'before' | 'after'): boolean {
    if (side === 'before')
      return node.change === 'added' ? !!node.wraps : !node.movedFrom;
    return node.change !== 'removed' && !node.ghost;
  }

  /** The change navigation visits a change once: where its new version is, or a removal's old. */
  protected hunkHere(node: BlockDiff): boolean {
    if (!node.hunk) return false;
    const mode = this.mode();
    if (node.hunk === 'removed') return mode === 'inline' || mode === 'before';
    return mode !== 'before';
  }

  protected anchorOf(node: BlockDiff): string | null {
    const key = this.item.key();
    if (node.ghost)
      return this.mode() === 'after' ? null : anchorId(key, node.id, true);
    return this.mode() === 'before' && node.change !== 'removed'
      ? null
      : anchorId(key, node.id);
  }

  protected rowClass(node: BlockDiff): string {
    const mode = this.mode();
    if (node.ghost) return ROWS.ghost;
    if (node.inherited) return ROWS.same;
    if (mode === 'rendered') {
      // The reader's view: marked at the edge, never tinted.
      return node.hunk ? 'border-info' : ROWS.same;
    }
    if (node.change === 'added') return node.wraps ? ROWS.wrap : ROWS.added;
    if (node.change === 'removed') return ROWS.removed;
    if (node.change === 'changed') return ROWS.changed;
    if (node.movedFrom) return ROWS.moved;
    return ROWS.same;
  }

  protected typeOf(node: BlockDiff): string {
    const n = shownNode(node);
    return n.kind === 'item' ? 'item' : n.block.type;
  }

  protected itemOf(node: BlockDiff) {
    const n = shownNode(node);
    return n.kind === 'item' ? n : { step: false, ordered: false, ordinal: 0 };
  }

  private blockOf(node: BlockDiff, side?: 'before' | 'after'): Block | null {
    const n = side ? node[side] : shownNode(node);
    return n?.kind === 'block' ? n.block : null;
  }

  /** The table whose layout is drawn: the old one in the before column. */
  private tableOf(node: BlockDiff): Block | null {
    const old = this.blockOf(node, 'before');
    return this.mode() === 'before' && old?.type === 'table'
      ? old
      : this.blockOf(node);
  }

  protected kindWord(node: BlockDiff): string {
    const n = shownNode(node);
    const kind = n.kind === 'item' ? (n.step ? 'step' : 'item') : n.block.type;
    const key = KIND_KEYS[kind];
    return key ? this.t(key) : kind;
  }

  /** A code block's language: both sides' when it changed. */
  protected languageOf(node: BlockDiff): string {
    const lang = (n: BlockNode | undefined) =>
      n?.kind === 'block' && n.block.type === 'literal'
        ? (n.block.language ?? '')
        : '';
    const before = lang(node.before);
    const after = lang(node.after);
    if (this.mode() === 'before') return before;
    if (this.mode() !== 'inline' || before === after || !node.before)
      return after;
    return `${before || '–'} → ${after || '–'}`;
  }

  protected hasText(node: BlockDiff): boolean {
    return (node.texts['text'] ?? []).length > 0;
  }

  /** The text to show: with both marks (inline), one side's, or the new text plain (rendered). */
  protected segmentsOf(node: BlockDiff): readonly Segment[] {
    const segments = node.texts['text'] ?? [];
    switch (this.mode()) {
      case 'before':
        return segments.filter((s) => s.op !== 'ins');
      case 'after':
        return segments.filter((s) => s.op !== 'del');
      case 'rendered': {
        const text = segments
          .filter((s) => s.op !== 'del')
          .map((s) => s.text)
          .join('');
        return text ? [{ op: 'same', text }] : [];
      }
      default:
        return segments;
    }
  }

  private words(): Record<SafetySeverity, string> {
    return signalWords({
      config: this.review.config(),
      lang: this.item.lang(),
    });
  }

  protected safetyOf(node: BlockDiff): {
    level: SafetySeverity;
    word: string;
  } {
    const b = this.blockOf(node);
    const level = safetyLevel(b?.type === 'safety' ? b.severity : undefined);
    return { level, word: this.words()[level] };
  }

  protected admonitionWord(node: BlockDiff): string {
    const b = this.blockOf(node);
    const kind = b?.type === 'admonition' ? b.kind : '';
    const key = ADMONITION_KEYS[kind];
    return key ? this.t(key) : kind;
  }

  protected chipsOf(
    node: BlockDiff,
    side?: 'before' | 'after',
  ): VariantCondition[] {
    const b = this.blockOf(node, side);
    return (
      conditionChips(
        b?.type === 'variant' ? b.when : null,
        this.review.config(),
        this.t('editor.review.variant.rule'),
      ) ?? []
    );
  }

  private chipsText(node: BlockDiff, side?: 'before' | 'after'): string {
    return this.chipsOf(node, side)
      .map((c) => `${c.attribute}: ${c.values.join(', ')}`)
      .join('; ');
  }

  protected refOf(node: BlockDiff): string {
    const b = this.blockOf(node);
    return b?.type === 'moduleRef' ? b.module : '';
  }

  protected tableRows(node: BlockDiff): {
    colspan: number | null;
    rowspan: number | null;
    nodes: BlockDiff[];
  }[][] {
    const b = this.tableOf(node);
    if (b?.type !== 'table') return [];
    // A moved block's ghost has its ID too: a cell holds the block itself; in the old table,
    // where it stood (its ghost), and what a new frame holds where it stood before the frame.
    const before = this.mode() === 'before';
    const own = (list: readonly BlockDiff[]): BlockDiff[] =>
      list.flatMap((c) =>
        before && c.change === 'added' && c.wraps ? own(c.children) : [c],
      );
    const byId = new Map(
      own(node.children)
        .filter((c) => (before ? !c.movedFrom : !c.ghost))
        .map((c) => [c.id, c]),
    );
    return b.rows.map((row) =>
      row.cells.map((cell) => ({
        colspan: cell.colspan && cell.colspan > 1 ? cell.colspan : null,
        rowspan: cell.rowspan && cell.rowspan > 1 ? cell.rowspan : null,
        nodes: cell.blocks.flatMap((x) => {
          const found = byId.get(x.id);
          return found ? [found] : [];
        }),
      })),
    );
  }

  /** What the table shown holds no cell for: removed blocks and the ghosts of moved ones. */
  protected tableLeftovers(node: BlockDiff): BlockDiff[] {
    const b = this.tableOf(node);
    if (b?.type !== 'table') return [];
    const placed = new Set(
      b.rows.flatMap((r) => r.cells.flatMap((c) => c.blocks.map((x) => x.id))),
    );
    const before = this.mode() === 'before';
    return node.children.filter((c) =>
      before
        ? !placed.has(c.id) && !(c.change === 'added' && c.wraps)
        : !placed.has(c.id) || c.ghost,
    );
  }

  private section(blocks: readonly Block[], parentId: string | null): string {
    return sectionTitle(blocks, parentId) ?? '';
  }

  /** The mark of a change: what happened, in words, with a symbol. */
  protected markOf(node: BlockDiff): Mark | null {
    const key = this.item.key();
    const kind = this.kindWord(node);
    if (node.ghost) {
      const to = node.movedTo?.parentId ?? null;
      const here = to === this.parentId();
      const title = this.section(this.item.after(), to);
      return {
        symbol: SYMBOLS.ghost,
        tone: TONES.ghost,
        text: here
          ? this.t('editor.review.mark.wasHere', { kind })
          : title
            ? this.t('editor.review.mark.movedTo', { kind, section: title })
            : this.t('editor.review.mark.movedToTop', { kind }),
        ...(this.mode() !== 'before' && {
          jump: {
            target: anchorId(key, node.id),
            label: this.t('editor.review.mark.showNow'),
          },
        }),
      };
    }
    if (!node.hunk) return null;
    if (node.hunk === 'added') {
      if (node.wraps) {
        const detail = this.wrapDetail(node);
        return {
          symbol: SYMBOLS.added,
          tone: TONES.added,
          text: detail
            ? this.t('editor.review.mark.wrappedIn', { kind, detail })
            : this.t('editor.review.mark.wrappedInPlain', { kind }),
        };
      }
      return {
        symbol: SYMBOLS.added,
        tone: TONES.added,
        text: this.t('editor.review.mark.added', { kind }),
      };
    }
    if (node.hunk === 'removed') {
      return {
        symbol: SYMBOLS.removed,
        tone: TONES.removed,
        text: node.unwraps
          ? this.t('editor.review.mark.unwrapped', { kind })
          : this.t('editor.review.mark.removed', { kind }),
      };
    }
    const moved = node.movedFrom ? this.movedText(node, kind) : null;
    const jump =
      node.movedFrom && this.mode() !== 'after' && this.mode() !== 'rendered'
        ? {
            target: anchorId(key, node.id, true),
            label: this.t('editor.review.mark.showWas'),
          }
        : undefined;
    if (node.hunk === 'moved') {
      return {
        symbol: SYMBOLS.moved,
        tone: TONES.moved,
        text: moved ?? '',
        ...(jump && { jump }),
      };
    }
    const what = this.changedText(node, kind);
    return {
      symbol: SYMBOLS.changed,
      tone: TONES.changed,
      text: moved ? `${what} · ${moved}` : what,
      ...(jump && { jump }),
    };
  }

  private movedText(node: BlockDiff, kind: string): string {
    const from = node.movedFrom?.parentId ?? null;
    if (from === this.parentId())
      return this.t('editor.review.mark.reordered', { kind });
    const title = this.section(this.item.before(), from);
    return title
      ? this.t('editor.review.mark.movedFrom', { kind, section: title })
      : this.t('editor.review.mark.movedFromTop', { kind });
  }

  /** What changed in a block: its text, its level, its condition, its picture… */
  private changedText(node: BlockDiff, kind: string): string {
    const b = this.blockOf(node, 'before');
    const a = this.blockOf(node, 'after');
    if (
      b?.type === 'safety' &&
      a?.type === 'safety' &&
      b.severity !== a.severity
    ) {
      const words = this.words();
      return this.t('editor.review.mark.level', {
        from: words[safetyLevel(b.severity)],
        to: words[safetyLevel(a.severity)],
      });
    }
    if (b?.type === 'variant' && a?.type === 'variant') {
      return this.t('editor.review.mark.condition', {
        from: this.chipsText(node, 'before'),
        to: this.chipsText(node, 'after'),
      });
    }
    if (b?.type === 'image' && a?.type === 'image' && b.asset !== a.asset)
      return this.t('editor.review.mark.imageReplaced');
    // Another file under the block: named even when its facts read the same.
    if (
      b?.type === 'attachment' &&
      a?.type === 'attachment' &&
      b.asset !== a.asset
    )
      return this.t('editor.review.mark.fileReplaced');
    if (b?.type === 'moduleRef' && a?.type === 'moduleRef')
      return this.t('editor.review.mark.referenceChanged');
    const words = Object.values(node.texts).some((list) =>
      list.some((s) => s.op !== 'same'),
    );
    const inline = this.inlineChanges(node);
    if (inline)
      return this.t(
        words
          ? 'editor.review.mark.textAndInline'
          : 'editor.review.mark.inline',
        { kind, changes: inline },
      );
    return words
      ? this.t('editor.review.mark.textChanged', { kind })
      : this.t('editor.review.mark.formatting', { kind });
  }

  /**
   * What changed in a node's text beside its words, as one line: bold added to "word", a link's
   * new address, a cross-reference's new target… Empty when only words changed.
   */
  private inlineChanges(node: BlockDiff): string {
    const { added, removed } = inlineDetailChanges(
      inlineDetailsOf(node.before),
      inlineDetailsOf(node.after),
    );
    const say = (d: InlineDetail, change: 'added' | 'removed') =>
      this.t(
        change === 'added'
          ? 'editor.review.inline.added'
          : 'editor.review.inline.removed',
        {
          what: this.t(
            INLINE_KINDS[d.kind] ?? 'editor.review.inline.kind.other',
          ),
          text: d.text,
          target: d.target ?? '',
          hasTarget: d.target ? 'yes' : 'no',
        },
      );
    return [
      ...removed.map((d) => say(d, 'removed')),
      ...added.map((d) => say(d, 'added')),
    ].join('; ');
  }

  /** What a new frame around existing content is: its condition, its signal word, its kind. */
  private wrapDetail(node: BlockDiff): string {
    const b = this.blockOf(node);
    if (b?.type === 'variant') return this.chipsText(node);
    if (b?.type === 'safety') return this.safetyOf(node).word;
    if (b?.type === 'admonition') return this.admonitionWord(node);
    return '';
  }

  /** Scrolls to the other place of a move and puts the focus there. */
  protected jumpTo(target: string): void {
    const el = document.getElementById(target);
    if (!el) return;
    const reduce = window.matchMedia?.(
      '(prefers-reduced-motion: reduce)',
    ).matches;
    el.scrollIntoView?.({
      block: 'center',
      behavior: reduce ? 'auto' : 'smooth',
    });
    el.focus({ preventScroll: true });
  }
}
