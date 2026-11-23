import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  resource,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideChevronRight,
  lucideFileText,
  lucideFolder,
} from '@ng-icons/lucide';
import { CollapseComponent } from '@openfolia/ui/collapse';
import {
  DiffDeletedComponent,
  DiffInsertedComponent,
} from '@openfolia/ui/diff-marks';
import { injectTranslate } from '@openfolia/ui/i18n';
import { ZardSkeletonComponent } from '@openfolia/ui/skeleton';

import { MeService } from '../permissions/me';
import { chapterTitle, entryModule, type EntryDiff } from './manual-diff';
import { anchorId, DIFF_ITEM, ReviewContext } from './review-context';
import type { Segment } from './review-diff';
import { foldUnchanged, type Shown } from './tree-diff';
import type { EntryNode } from './manual-diff';

/** Where a module entry's own diff is on this page, if it is. */
export type ModuleLink = (
  moduleId: string,
) => Record<string, string | null> | null;

const SYMBOLS = {
  added: '+',
  removed: '−',
  changed: '~',
  moved: '↕',
  ghost: '↳',
} as const;

/** A module entry's title, read at the side's commit in the manual's source language. */
@Component({
  selector: 'of-outline-title',
  imports: [ZardSkeletonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (read.isLoading()) {
      <z-skeleton class="inline-block h-4 w-40 align-middle" />
    } @else {
      {{ title() }}
    }
  `,
})
export class OutlineTitleComponent {
  private readonly item = inject(DIFF_ITEM);
  private readonly review = inject(ReviewContext);
  private readonly me = inject(MeService).me;

  readonly moduleId = input.required<string>();
  readonly old = input(false);

  protected readonly read = resource({
    params: () => ({
      lang: this.item.lang(),
      id: this.moduleId(),
      ref: this.old() ? this.item.base() : this.item.head(),
      // Read again for another person: what was shown was the one before's (#716).
      who: this.me().id,
    }),
    loader: ({ params }) =>
      this.review.moduleTitle(params.lang, params.id, params.ref),
  });
  protected readonly title = computed(
    () => (this.read.hasValue() && this.read.value()) || this.moduleId(),
  );
}

/**
 * A manual's outline compared, as a tree: chapters and modules, each entry added, removed,
 * moved (from which chapter, with a link to where it stood) or renamed marked as blocks are, and
 * a module whose own changes are on this page linked to them. Runs of unchanged entries fold.
 */
@Component({
  selector: 'of-diff-outline',
  imports: [
    NgTemplateOutlet,
    RouterLink,
    TranslocoPipe,
    NgIcon,
    CollapseComponent,
    DiffInsertedComponent,
    DiffDeletedComponent,
    OutlineTitleComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({ lucideChevronRight, lucideFileText, lucideFolder }),
  ],
  host: { class: 'flex min-w-0 flex-col gap-1', role: 'list' },
  template: `
    @for (entry of shown(); track trackOf(entry)) {
      @if (entry.kind === 'run') {
        @let open = item.open().has(entry.key);
        <div role="listitem" class="flex min-w-0 flex-col">
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
              (open
                ? 'editor.review.fold.hideEntries'
                : 'editor.review.fold.showEntries'
              ) | transloco: { count: entry.nodes.length }
            }}
          </button>
          <of-collapse [open]="open">
            <div class="flex flex-col gap-1 pt-1">
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
      @let mark = markOf(node);
      @let e = (node.after ?? node.before)!;
      <div
        role="listitem"
        class="min-w-0 scroll-mt-24 rounded-e-md border-s-[3px] py-1 ps-3 pe-1 outline-none focus-visible:ring-2 focus-visible:ring-ring data-[current]:ring-2 data-[current]:ring-ring"
        [class]="rowClass(node)"
        [attr.id]="anchorOf(node)"
        [attr.data-hunk]="node.hunk"
        [attr.tabindex]="node.hunk || node.ghost ? -1 : null"
      >
        <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          <ng-icon
            [name]="isChapter(e) ? 'lucideFolder' : 'lucideFileText'"
            class="text-muted-foreground shrink-0"
            aria-hidden="true"
          />
          @if (isChapter(e)) {
            <span class="text-sm font-semibold break-words">
              <ng-container
                *ngTemplateOutlet="
                  text;
                  context: { $implicit: segmentsOf(node, 'text') }
                "
              />
            </span>
          } @else {
            @let id = moduleOf(e);
            <span class="min-w-0 text-sm break-words">
              <of-outline-title [moduleId]="id" [old]="!node.after" />
            </span>
            <span
              class="text-muted-foreground font-mono text-xs [overflow-wrap:anywhere]"
              >{{ id }}</span
            >
            @if (link()(id); as params) {
              <a
                class="text-foreground focus-visible:ring-ring rounded-sm text-xs underline underline-offset-2 outline-none focus-visible:ring-2"
                [routerLink]="[]"
                [queryParams]="params"
                queryParamsHandling="merge"
                >{{ 'editor.review.outline.showModule' | transloco }}</a
              >
            }
          }
          @if (segmentsOf(node, 'when').length) {
            <span
              class="border-border bg-background rounded-full border px-2 text-xs break-words"
            >
              <ng-container
                *ngTemplateOutlet="
                  text;
                  context: { $implicit: segmentsOf(node, 'when') }
                "
              />
            </span>
          }
        </div>
        @if (mark) {
          <p
            class="m-0 mt-0.5 flex items-baseline gap-x-1.5 text-xs font-medium"
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
          </p>
        }
        @if (node.children.length && !node.ghost) {
          <of-diff-outline
            class="mt-1"
            [nodes]="node.children"
            [parentId]="node.id"
            [all]="all()"
            [link]="link()"
          />
        }
      </div>
    </ng-template>

    <ng-template #text let-segments>
      @for (s of segments; track $index) {
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
export class DiffOutlineComponent {
  protected readonly item = inject(DIFF_ITEM);
  private readonly t = injectTranslate();

  readonly nodes = input.required<readonly EntryDiff[]>();
  /** The chapter these entries are in (null: the top level). */
  readonly parentId = input<string | null>(null);
  /** The whole compared outline, to name the chapter a move came from. */
  readonly all = input.required<readonly EntryDiff[]>();
  readonly link = input<ModuleLink>(() => null);

  protected readonly shown = computed((): Shown<EntryNode>[] =>
    foldUnchanged(this.nodes()),
  );

  protected trackOf(entry: Shown<EntryNode>): string {
    return entry.kind === 'run'
      ? `run:${entry.key}`
      : `${entry.node.ghost ? 'was:' : ''}${entry.node.id}`;
  }

  protected isChapter(e: EntryNode): boolean {
    return entryModule(e) === null;
  }

  protected moduleOf(e: EntryNode): string {
    return entryModule(e) ?? '';
  }

  protected segmentsOf(node: EntryDiff, key: string): readonly Segment[] {
    return node.texts[key] ?? [];
  }

  protected anchorOf(node: EntryDiff): string {
    return anchorId(this.item.key(), node.id, node.ghost);
  }

  protected rowClass(node: EntryDiff): string {
    if (node.ghost)
      return 'border-muted-foreground/50 border-dashed text-muted-foreground';
    if (node.inherited) return 'border-transparent';
    if (node.change === 'added') return 'border-success bg-success-muted/70';
    if (node.change === 'removed')
      return 'border-destructive bg-destructive-muted/70';
    if (node.change === 'changed') return 'border-info';
    if (node.movedFrom) return 'border-info border-dashed';
    return 'border-transparent';
  }

  private chapter(key: string | null, side: 'before' | 'after'): string | null {
    return chapterTitle(this.all(), key, side);
  }

  protected markOf(node: EntryDiff) {
    const key = this.item.key();
    const kind = this.t(
      node.id.startsWith('chapter:')
        ? 'editor.review.kind.chapter'
        : 'editor.review.kind.entry',
    );
    if (node.ghost) {
      const to = node.movedTo?.parentId ?? null;
      const title = this.chapter(to, 'after');
      return {
        symbol: SYMBOLS.ghost,
        tone: 'text-muted-foreground',
        text:
          to === this.parentId()
            ? this.t('editor.review.mark.wasHere', { kind })
            : title
              ? this.t('editor.review.mark.movedTo', { kind, section: title })
              : this.t('editor.review.mark.movedToManualTop', { kind }),
        jump: {
          target: anchorId(key, node.id),
          label: this.t('editor.review.mark.showNow'),
        },
      };
    }
    if (!node.hunk) return null;
    if (node.hunk === 'added')
      return {
        symbol: SYMBOLS.added,
        tone: 'text-success',
        text: this.t('editor.review.mark.added', { kind }),
      };
    if (node.hunk === 'removed')
      return {
        symbol: SYMBOLS.removed,
        tone: 'text-destructive',
        text: this.t('editor.review.mark.removed', { kind }),
      };
    const from = node.movedFrom?.parentId ?? null;
    const moved = node.movedFrom
      ? from === this.parentId()
        ? this.t('editor.review.mark.reordered', { kind })
        : this.chapter(from, 'before')
          ? this.t('editor.review.mark.movedFrom', {
              kind,
              section: this.chapter(from, 'before'),
            })
          : this.t('editor.review.mark.movedFromManualTop', { kind })
      : null;
    const jump = node.movedFrom
      ? {
          target: anchorId(key, node.id, true),
          label: this.t('editor.review.mark.showWas'),
        }
      : undefined;
    if (node.hunk === 'moved')
      return {
        symbol: SYMBOLS.moved,
        tone: 'text-info',
        text: moved ?? '',
        jump,
      };
    const renamed = (node.texts['text'] ?? []).some((s) => s.op !== 'same');
    const what = renamed
      ? this.t('editor.review.mark.renamed', { kind })
      : this.t('editor.review.mark.conditionOnly', { kind });
    return {
      symbol: SYMBOLS.changed,
      tone: 'text-info',
      text: moved ? `${what} · ${moved}` : what,
      jump,
    };
  }

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
