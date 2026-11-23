import {
  booleanAttribute,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  type OnInit,
  signal,
  ViewEncapsulation,
} from '@angular/core';

import { NgIcon, type IconName } from '@ng-icons/core';
import type { ClassValue } from 'clsx';

import type { ZardCommandOptionGroupComponent } from '../command/command-option-group.component';
import { ZardCommand } from '../command/command.tokens';
import {
  commandItemVariants,
  commandShortcutVariants,
  type ZardCommandItemVariants,
} from '../command/command.variants';
import { mergeClasses } from '../ui/merge-classes';

@Component({
  selector: 'z-command-option',
  imports: [NgIcon],
  template: `
    @if (isOptionVisible()) {
      <div
        [class]="classes()"
        data-slot="command-item"
        [id]="id"
        [attr.role]="'option'"
        [attr.aria-selected]="isSelected()"
        [attr.data-selected]="isSelected() ? '' : null"
        [attr.data-disabled]="zDisabled()"
        [attr.aria-disabled]="zDisabled() || null"
        [attr.tabindex]="0"
        (click)="onClick()"
        (keydown.{enter,space}.prevent)="onClick()"
        (mouseenter)="onMouseEnter()"
      >
        <ng-content select="[data-slot=command-option-leading]" />
        @if (zIcon()) {
          <ng-icon [name]="zIcon()!" />
        }
        <!-- A richer label (two lines, highlighted matches) replaces the plain one. -->
        <span class="min-w-0 flex-1"
          ><ng-content select="[data-slot=command-option-label]">{{
            zLabel()
          }}</ng-content></span
        >
        @if (zShortcut()) {
          <span [class]="shortcutClasses()" data-slot="command-shortcut">{{
            zShortcut()
          }}</span>
        }
        <ng-content select="[data-slot=command-option-trailing]" />
      </div>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  exportAs: 'zCommandOption',
})
export class ZardCommandOptionComponent implements OnInit {
  private static nextId = 0;
  /** The option's element id, for the input's `aria-activedescendant`. */
  readonly id = `z-command-option-${ZardCommandOptionComponent.nextId++}`;
  private readonly elementRef = inject(ElementRef);
  private readonly parentCommandComponent = inject(ZardCommand, {
    optional: true,
  });

  readonly zValue = input.required<unknown>();
  readonly zLabel = input.required<string>();
  readonly zCommand = input<string>('');
  readonly zIcon = input<IconName>();
  readonly zShortcut = input<string>('');
  readonly zDisabled = input(false, { transform: booleanAttribute });
  readonly variant = input<ZardCommandItemVariants>('default');
  readonly class = input<ClassValue>('');
  readonly parentCommand = input<ZardCommand | null>(null);
  readonly commandGroup = input<ZardCommandOptionGroupComponent | null>(null);

  readonly isSelected = signal(false);
  /**
   * Whether its inputs are set: an option added to an open command (a list that loaded, a search
   * text) is in the command's content before its bindings ran, and reading `zLabel` then throws.
   */
  readonly ready = signal(false);

  protected readonly classes = computed(() =>
    mergeClasses(
      commandItemVariants({ variant: this.variant() }),
      this.class(),
    ),
  );

  protected readonly shortcutClasses = computed(() =>
    mergeClasses(commandShortcutVariants()),
  );

  private get commandComponent() {
    let parent = this.parentCommand();
    parent ||= this.parentCommandComponent;
    return parent;
  }

  protected readonly isOptionVisible = computed(() => {
    const parent = this.commandComponent;

    if (!parent) {
      return true;
    }
    /*
      If no search term, show this option, otherwise check
      if this option is included in the filtered list
     */
    return !parent.searchTerm() || parent.filteredOptions().includes(this);
  });

  constructor() {
    effect((onCleanup) => {
      const cmd = this.parentCommand();
      const grp = this.commandGroup();

      if (cmd) {
        cmd.registerOption(this);
        onCleanup(() => cmd.unregisterOption(this));
      }

      if (grp) {
        grp.registerOption(this);
        onCleanup(() => grp.unregisterOption(this));
      }
    });
  }

  ngOnInit(): void {
    this.ready.set(true);
  }

  onClick() {
    if (this.zDisabled()) {
      return;
    }

    this.commandComponent?.selectOption(this);
  }

  onMouseEnter() {
    if (this.zDisabled()) {
      return;
    }
    const parent = this.commandComponent;
    if (!parent) {
      return;
    }
    const idx = parent.filteredOptions().indexOf(this);
    if (idx >= 0) {
      parent.setActiveByIndex(idx);
    }
  }

  setSelected(selected: boolean) {
    this.isSelected.set(selected);
  }

  /**
   * Brings this option into view. Focus intentionally stays on the search
   * input while navigating, so typing keeps filtering the list.
   */
  scrollIntoView() {
    this.elementRef.nativeElement.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
    });
  }
}
