import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideBookOpen,
  lucideBraces,
  lucideCodeXml,
  lucideCornerDownRight,
  lucideFileSymlink,
  lucideHeading,
  lucideImage,
  lucideInfo,
  lucideKeyboard,
  lucideLink,
  lucideList,
  lucideListChecks,
  lucideListOrdered,
  lucideMapPin,
  lucideMessageCircleQuestionMark,
  lucidePaperclip,
  lucidePilcrow,
  lucideSeparatorHorizontal,
  lucideSplit,
  lucideTable,
  lucideTextQuote,
  lucideTriangleAlert,
} from '@ng-icons/lucide';
import {
  commandItemVariants,
  commandListVariants,
  commandVariants,
} from '@openfolia/ui/command';
import { mergeClasses } from '@openfolia/ui/ui';

import type { SlashMenuState, SlashMenuView } from './slash/slash-command';
import type { SlashItem } from './slash/slash-items';
import { TranslocoPipe } from '@jsverse/transloco';

let nextId = 0;

/**
 * The slash menu: a list box under the caret. The focus stays in the document, so the keys come
 * from the editor (`keyDown`) and the editor points at the highlighted row through
 * `aria-activedescendant`.
 */
@Component({
  selector: 'of-slash-menu',
  imports: [TranslocoPipe, NgIcon],
  viewProviders: [
    provideIcons({
      lucideBookOpen,
      lucideBraces,
      lucideCodeXml,
      lucideCornerDownRight,
      lucideFileSymlink,
      lucideHeading,
      lucideImage,
      lucideInfo,
      lucideKeyboard,
      lucideLink,
      lucideList,
      lucideListChecks,
      lucideListOrdered,
      lucideMapPin,
      lucideMessageCircleQuestionMark,
      lucidePaperclip,
      lucidePilcrow,
      lucideSeparatorHorizontal,
      lucideSplit,
      lucideTable,
      lucideTextQuote,
      lucideTriangleAlert,
    }),
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'z-50 block',
    '[class.hidden]': '!state()',
  },
  template: `
    @if (state(); as s) {
      <div [class]="panelClasses">
        <ul
          [id]="listId"
          role="listbox"
          [attr.aria-label]="
            s.label ?? 'editor.docEditor.slash.label' | transloco
          "
          [class]="listClasses"
        >
          @for (item of s.items; track item.id; let i = $index) {
            <li
              [id]="optionId(i)"
              role="option"
              data-slot="command-item"
              [attr.aria-selected]="i === current()"
              [attr.data-selected]="i === current() ? '' : null"
              [attr.aria-disabled]="s.reasons.has(item.id) || null"
              [class]="itemClasses"
              (mousedown)="$event.preventDefault()"
              (mouseenter)="hover(item)"
              (click)="s.choose(item)"
            >
              <ng-icon
                [name]="item.icon"
                aria-hidden="true"
                [class]="
                  s.reasons.has(item.id)
                    ? 'text-muted-foreground mt-0.5 self-start'
                    : ''
                "
              />
              @if (s.reasons.get(item.id); as reason) {
                <span class="flex min-w-0 flex-1 flex-col">
                  <span class="text-muted-foreground whitespace-nowrap">{{
                    item.label | transloco: item.labelParams
                  }}</span>
                  <span class="text-muted-foreground text-xs break-words">{{
                    reason.key | transloco: reason.params
                  }}</span>
                </span>
              } @else {
                <span class="flex-1 whitespace-nowrap">{{
                  item.label | transloco: item.labelParams
                }}</span>
                <span
                  class="text-muted-foreground ms-4 min-w-0 truncate text-xs"
                  >{{ item.hint | transloco: item.hintParams }}</span
                >
              }
            </li>
          } @empty {
            <li class="text-muted-foreground px-2 py-1.5 text-sm">
              {{
                s.empty ?? 'editor.docEditor.slash.empty'
                  | transloco: { query: s.query }
              }}
            </li>
          }
        </ul>
      </div>
    }
  `,
})
export class SlashMenuComponent implements SlashMenuView {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  /** The editor's element, which carries the combobox attributes while the menu is open. */
  readonly editorElement = input<HTMLElement | null>(null);

  protected readonly state = signal<SlashMenuState | null>(null);
  /** The row highlighted, as set; `current` is where it is in the list shown. */
  private readonly active = signal(0);
  /**
   * The highlighted row's place in the list, within it: a list that shortens under the
   * highlight (an item no longer available at the caret) keeps one highlighted. -1: no rows.
   */
  protected readonly current = computed(() => {
    const count = this.state()?.items.length ?? 0;
    return count === 0 ? -1 : Math.min(this.active(), count - 1);
  });
  private unmount: (() => void) | null = null;

  protected readonly listId = `of-slash-menu-${nextId++}`;
  protected readonly panelClasses = mergeClasses(
    commandVariants(),
    'w-72 max-w-[calc(100vw-2rem)]',
  );
  protected readonly listClasses = mergeClasses(
    commandListVariants(),
    'm-0 list-none',
  );
  protected readonly itemClasses = commandItemVariants();

  protected readonly activeItem = computed<SlashItem | null>(
    () => this.state()?.items[this.current()] ?? null,
  );

  constructor() {
    // The editor is the combobox while the menu is open.
    effect(() => {
      const el = this.editorElement();
      const open = this.state() !== null;
      if (!el) return;
      if (open) {
        el.setAttribute('aria-controls', this.listId);
        el.setAttribute('aria-expanded', 'true');
        const count = this.state()?.items.length ?? 0;
        if (count > 0)
          el.setAttribute(
            'aria-activedescendant',
            this.optionId(this.current()),
          );
        else el.removeAttribute('aria-activedescendant');
      } else {
        el.removeAttribute('aria-controls');
        el.removeAttribute('aria-expanded');
        el.removeAttribute('aria-activedescendant');
      }
    });
    // The highlighted row stays in view as the arrows move it.
    effect(() => {
      const index = this.current();
      if (index < 0) return;
      queueMicrotask(() =>
        this.host.nativeElement
          .querySelector(`#${this.optionId(index)}`)
          ?.scrollIntoView?.({ block: 'nearest' }),
      );
    });
  }

  /**
   * The pointer entered a row: it is highlighted, at its place in the list now. A row of the
   * list before (the pointer resting over the menu while typing narrows it, its rows still on
   * screen until the next render) that the list has no more highlights nothing (#578).
   */
  protected hover(item: SlashItem): void {
    const index =
      this.state()?.items.findIndex((it) => it.id === item.id) ?? -1;
    if (index >= 0) this.active.set(index);
  }

  protected optionId(index: number): string {
    return `${this.listId}-${index}`;
  }

  open(state: SlashMenuState): void {
    this.active.set(0);
    this.state.set(state);
    this.unmount?.();
    this.unmount = state.mount(this.host.nativeElement);
  }

  update(state: SlashMenuState): void {
    if (state.query !== this.state()?.query) this.active.set(0);
    this.state.set(state);
  }

  keyDown(event: KeyboardEvent): boolean {
    const state = this.state();
    if (!state) return false;
    const count = state.items.length;
    const at = this.current();
    switch (event.key) {
      case 'ArrowDown':
        if (count) this.active.set((at + 1) % count);
        return true;
      case 'ArrowUp':
        if (count) this.active.set((at - 1 + count) % count);
        return true;
      case 'Enter': {
        const item = this.activeItem();
        if (!item) return false;
        // A disabled row takes the key and does nothing: its reason is on screen.
        state.choose(item);
        return true;
      }
      case 'Escape':
        this.close();
        return true;
      default:
        return false;
    }
  }

  close(): void {
    this.unmount?.();
    this.unmount = null;
    this.state.set(null);
  }
}
