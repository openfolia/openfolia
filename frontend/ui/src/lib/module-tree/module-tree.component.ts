import { injectTranslate } from '../i18n/text.pipe';
import { TranslocoPipe } from '@jsverse/transloco';
import {
  CdkDrag,
  CdkDragHandle,
  CdkDragPlaceholder,
  CdkDragPreview,
  CdkDropList,
  type CdkDragDrop,
  type CdkDragSortEvent,
} from '@angular/cdk/drag-drop';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  contentChild,
  Directive,
  ElementRef,
  inject,
  Injector,
  input,
  model,
  output,
  signal,
  TemplateRef,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideGripVertical } from '@ng-icons/lucide';

import {
  canIndent,
  canOutdent,
  changeLevel,
  dropPreview,
  moveSubtree,
  numbering,
  siblingInfo,
  siblingMoveTarget,
  subtreeEnd,
  type ModuleTreeItem,
} from './module-tree.logic';

/** A row's fade-in as it is added (opacity only: no row moves but by the space it takes). */
const ROW_ENTER =
  'animate-in fade-in-0 duration-300 ease-out motion-reduce:animate-none';

/** Marks the `<ng-template>` that renders the end of a row (a status badge, say); it gets the item. */
@Directive({ selector: 'ng-template[ofModuleTreeTrailing]' })
export class ModuleTreeTrailingDirective {
  readonly template =
    inject<TemplateRef<{ $implicit: ModuleTreeItem }>>(TemplateRef);
}

/**
 * The module tree of a manual: a numbered outline whose rows reorder by drag and drop and
 * change level with the keyboard. It owns no data: it shows `items` and emits the complete new
 * list in `itemsChange`; the host stores it and passes it back. Rows may say what nests under
 * them (`nesting`: a leaf holds nothing, a group always keeps a row); every change keeps to it.
 *
 * Keyboard (a roving tab stop, one row is tabbable; the focused row is the selected one):
 * - Up / Down / Home / End move between rows (and the selection, `selected`);
 * - Enter activates the row (`activate`: open it), as a click on its title does;
 * - Tab indents, Shift+Tab outdents the row with the rows nested under it. When the change is
 *   not possible the key does what it normally does and leaves the tree, so focus is never trapped;
 * - Alt+Up / Alt+Down move the row (with its nested rows) up or down.
 * A polite live region announces the new place after a change. `readonly` keeps the outline
 * and the selection but takes away dragging and every change. A row added once the tree is on
 * screen (an added module, an undone removal) fades in; the first rows come with the tree.
 */
@Component({
  selector: 'of-module-tree',
  imports: [
    TranslocoPipe,
    CdkDropList,
    CdkDrag,
    CdkDragHandle,
    CdkDragPlaceholder,
    CdkDragPreview,
    NgIcon,
    NgTemplateOutlet,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideGripVertical })],
  host: { class: 'block' },
  // While a row is dragged the others slide out of its way; the drop indicator is a line at the
  // level the row will land on. No motion for people who asked for less.
  styles: `
    @media (prefers-reduced-motion: no-preference) {
      .cdk-drop-list-dragging [cdkDrag]:not(.cdk-drag-placeholder),
      .cdk-drag-animating {
        transition: transform 200ms cubic-bezier(0.2, 0, 0, 1);
      }
      [data-drop-ghost] {
        transition: margin-inline-start 150ms ease-out;
      }
      [role='treeitem'] {
        transition:
          background-color 150ms ease-out,
          box-shadow 150ms ease-out;
      }
    }
  `,
  template: `
    <div
      cdkDropList
      role="tree"
      class="flex flex-col gap-0.5"
      [cdkDropListDisabled]="readonly()"
      [attr.aria-label]="label() || ('ui.moduleTree.label' | transloco)"
      [attr.aria-readonly]="readonly() || null"
      (cdkDropListDropped)="drop($event)"
      (cdkDropListSorted)="sorted($event)"
    >
      @for (item of items(); track item.id; let i = $index) {
        <div
          cdkDrag
          cdkDragLockAxis="y"
          role="treeitem"
          class="flex min-h-[34px] items-center gap-2 rounded-sm px-2 py-1 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          [class]="
            item.id === activeId()
              ? 'bg-background shadow-md ring-1 ring-border/70 dark:bg-muted'
              : 'hover:bg-muted/60'
          "
          [attr.data-id]="item.id"
          [attr.aria-level]="item.level + 1"
          [attr.aria-posinset]="siblings()[i]?.pos"
          [attr.aria-setsize]="siblings()[i]?.size"
          [attr.aria-selected]="item.id === activeId()"
          [attr.tabindex]="i === activeIndex() ? 0 : -1"
          [class.opacity-40]="carried().has(item.id)"
          [animate.enter]="rendered ? rowEnter : ''"
          (cdkDragStarted)="started(i)"
          (cdkDragEnded)="ended()"
          (focus)="select(item.id)"
          (keydown)="onKeydown($event, i)"
        >
          @if (readonly()) {
            <span class="inline-flex size-4 shrink-0" aria-hidden="true"></span>
          } @else {
            <span
              cdkDragHandle
              class="inline-flex shrink-0 cursor-grab touch-none text-muted-foreground"
              aria-hidden="true"
            >
              <ng-icon name="lucideGripVertical" />
            </span>
          }
          <span
            class="inline-block shrink-0"
            aria-hidden="true"
            [style.width.rem]="item.level * 1.25"
          ></span>
          <span
            class="min-w-10 shrink-0 font-mono text-xs text-muted-foreground"
            >{{ liveNumbers()?.get(item.id) ?? numbers()[i] }}</span
          >
          <span
            class="min-w-0 flex-1 cursor-pointer break-words [overflow-wrap:anywhere] hover:underline"
            [class.font-medium]="item.nesting === 'required'"
            (click)="activate.emit(item.id)"
            >{{ item.title }}</span
          >
          @if (trailing(); as t) {
            <ng-container
              [ngTemplateOutlet]="t.template"
              [ngTemplateOutletContext]="{ $implicit: item }"
            />
          }
          <div
            *cdkDragPlaceholder
            data-drop-ghost
            class="h-0.5 rounded-full bg-primary"
            [style.margin-inline-start]="
              'calc(1.5rem + ' + (ghost()?.level ?? item.level) * 1.25 + 'rem)'
            "
          ></div>
          <ng-template cdkDragPreview [matchSize]="true">
            <div
              data-drag-preview
              class="flex h-full items-center gap-2 rounded-sm bg-background px-2 py-1 text-sm text-foreground shadow-lg ring-1 ring-border"
            >
              <span class="inline-flex cursor-grabbing text-muted-foreground">
                <ng-icon name="lucideGripVertical" />
              </span>
              <span
                class="inline-block shrink-0"
                [style.width.rem]="(ghost()?.level ?? item.level) * 1.25"
              ></span>
              <span
                class="min-w-10 shrink-0 font-mono text-xs text-muted-foreground"
                >{{ ghost()?.number ?? numbers()[i] }}</span
              >
              <span
                class="min-w-0 flex-1 break-words"
                [class.font-medium]="item.nesting === 'required'"
                >{{ item.title }}</span
              >
              @if (carried().size > 0) {
                <span
                  class="shrink-0 rounded-full bg-muted px-1.5 text-xs text-muted-foreground"
                  >+{{ carried().size }}</span
                >
              }
            </div>
          </ng-template>
        </div>
      }
    </div>
    <div class="sr-only" role="status" aria-live="polite">{{ message() }}</div>
  `,
})
export class ModuleTreeComponent {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  readonly items = input.required<readonly ModuleTreeItem[]>();
  /** Default: "Manual structure", translated. */
  readonly label = input('');
  /** Shows the outline only: no dragging, no change of order or level. */
  readonly readonly = input(false);
  /** The selected row's ID (the tree's tab stop); follows focus and clicks. */
  readonly selected = model<string | null>(null);
  /** The complete new list after a drop, an indent, an outdent or a keyboard move. */
  readonly itemsChange = output<readonly ModuleTreeItem[]>();
  /** A row is opened: Enter on it, or a click on its title. Gives its ID. */
  readonly activate = output<string>();

  protected readonly trailing = contentChild(ModuleTreeTrailingDirective);
  /** Whether the first rows are on screen: rows added from then on fade in. */
  protected rendered = false;
  protected readonly rowEnter = ROW_ENTER;

  constructor() {
    afterNextRender(() => (this.rendered = true));
  }
  protected readonly activeId = this.selected;
  protected readonly message = signal('');
  private readonly t = injectTranslate();
  protected readonly siblings = computed(() => siblingInfo(this.items()));
  protected readonly numbers = computed(() => numbering(this.items()));
  protected readonly activeIndex = computed(() =>
    Math.max(
      0,
      this.items().findIndex((item) => item.id === this.activeId()),
    ),
  );

  /** The row being dragged, by index, and where it would land: drives the ghost placeholder. */
  private readonly dragFrom = signal<number | null>(null);
  private readonly dragTo = signal<number | null>(null);
  protected readonly ghost = computed(() => {
    const from = this.dragFrom();
    const to = this.dragTo();
    return from === null || to === null
      ? null
      : dropPreview(this.items(), from, to);
  });
  /** While dragging, every row's number as it will be after the drop. */
  protected readonly liveNumbers = computed(() => {
    const from = this.dragFrom();
    const to = this.dragTo();
    if (from === null || to === null) return null;
    const next = moveSubtree(this.items(), from, to);
    const numbers = numbering(next);
    return new Map(next.map((item, i) => [item.id, numbers[i] ?? '']));
  });
  /** The rows nested under the dragged one: they move with it, so they are dimmed meanwhile. */
  protected readonly carried = computed(() => {
    const from = this.dragFrom();
    if (from === null) return new Set<string>();
    const items = this.items();
    return new Set(
      items.slice(from + 1, subtreeEnd(items, from)).map((item) => item.id),
    );
  });

  protected started(index: number): void {
    this.dragFrom.set(index);
    this.dragTo.set(index);
  }

  protected sorted(event: CdkDragSortEvent): void {
    this.dragTo.set(event.currentIndex);
  }

  protected ended(): void {
    this.dragFrom.set(null);
    this.dragTo.set(null);
  }

  protected drop(event: CdkDragDrop<unknown>): void {
    if (this.readonly()) return;
    this.apply(
      moveSubtree(this.items(), event.previousIndex, event.currentIndex),
      this.items()[event.previousIndex]?.id,
    );
  }

  protected select(id: string): void {
    if (this.selected() !== id) this.selected.set(id);
  }

  protected onKeydown(event: KeyboardEvent, index: number): void {
    if (event.target !== event.currentTarget) return; // keys of content in a row are its own
    const items = this.items();
    const last = items.length - 1;
    const id = items[index]?.id;
    if (id === undefined) return;
    const changes = !this.readonly();
    switch (event.key) {
      case 'Enter':
        event.preventDefault();
        this.activate.emit(id);
        break;
      case 'ArrowDown':
        event.preventDefault();
        if (event.altKey) {
          if (!changes) break;
          const to = siblingMoveTarget(items, index, 1);
          if (to !== null) this.apply(moveSubtree(items, index, to), id);
        } else this.focusRow(Math.min(index + 1, last));
        break;
      case 'ArrowUp':
        event.preventDefault();
        if (event.altKey) {
          if (!changes) break;
          const to = siblingMoveTarget(items, index, -1);
          if (to !== null) this.apply(moveSubtree(items, index, to), id);
        } else this.focusRow(Math.max(index - 1, 0));
        break;
      case 'Home':
        event.preventDefault();
        this.focusRow(0);
        break;
      case 'End':
        event.preventDefault();
        this.focusRow(last);
        break;
      case 'Tab': {
        if (!changes) return; // focus leaves the tree
        const possible = event.shiftKey
          ? canOutdent(items, index)
          : canIndent(items, index);
        if (!possible) return; // let focus leave the tree
        event.preventDefault();
        this.apply(changeLevel(items, index, event.shiftKey ? -1 : 1), id);
        break;
      }
    }
  }

  private apply(next: readonly ModuleTreeItem[], id: string | undefined): void {
    if (next === this.items() || id === undefined) return;
    this.itemsChange.emit(next);
    const index = next.findIndex((item) => item.id === id);
    const moved = next[index];
    this.select(id);
    if (moved) {
      this.message.set(
        this.t('ui.moduleTree.moved', {
          title: moved.title,
          number: numbering(next)[index],
          level: moved.level + 1,
        }),
      );
    }
    afterNextRender(
      () => this.rowElement(id)?.focus({ preventScroll: false }),
      { injector: this.injector },
    );
  }

  /** Moves the focus (and so the selection) to the row `id` once it is rendered. */
  focusItem(id: string): void {
    afterNextRender(
      () => this.rowElement(id)?.focus({ preventScroll: false }),
      { injector: this.injector },
    );
  }

  private focusRow(index: number): void {
    const id = this.items()[index]?.id;
    if (id !== undefined) this.rowElement(id)?.focus();
  }

  private rowElement(id: string): HTMLElement | null {
    const rows =
      this.host.nativeElement.querySelectorAll<HTMLElement>('[data-id]');
    return Array.from(rows).find((row) => row.dataset['id'] === id) ?? null;
  }
}
