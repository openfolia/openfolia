import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  forwardRef,
  inject,
  input,
  output,
  signal,
  viewChild,
  ViewEncapsulation,
} from '@angular/core';
import { type ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';

import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideSearch } from '@ng-icons/lucide';

import { ZardCommand } from '../command/command.tokens';
import { ZardInputComponent } from '../input/input.component';
import { ZardInputGroupImports } from '../input-group/input-group.imports';

@Component({
  selector: 'z-command-input',
  imports: [
    TranslocoPipe,
    NgIcon,
    ZardInputComponent,
    ...ZardInputGroupImports,
  ],
  template: `
    <div
      data-slot="command-input-wrapper"
      [class]="zVariant() === 'palette' ? 'border-b px-2 py-1.5' : 'p-1 pb-0'"
    >
      <z-input-group
        [class]="
          zVariant() === 'palette'
            ? 'h-10 border-0 shadow-none! has-[input:focus-visible]:ring-0! dark:bg-transparent [&_input]:text-base'
            : 'border-input/30 has-[input:focus-visible]:border-input/30! shadow-none! has-[input:focus-visible]:ring-0!'
        "
      >
        <z-input-group-addon>
          <ng-icon
            name="lucideSearch"
            [class]="
              zVariant() === 'palette'
                ? 'text-muted-foreground size-4! shrink-0'
                : 'size-4! shrink-0 opacity-50'
            "
          />
        </z-input-group-addon>
        <input
          z-input
          #searchInput
          [placeholder]="
            placeholder() || ('ui.command.placeholder' | transloco)
          "
          [value]="searchTerm()"
          [disabled]="disabled()"
          (input)="onInput($event)"
          (keydown)="onKeyDown($event)"
          (blur)="onTouched()"
          [attr.aria-controls]="commandComponent?.uid + '-list'"
          [attr.aria-activedescendant]="commandComponent?.activeOptionId()"
          [attr.aria-label]="label() || ('ui.command.search' | transloco)"
          [attr.aria-describedby]="commandComponent?.uid + '-instructions'"
          aria-haspopup="listbox"
          autocomplete="off"
          autocorrect="off"
          spellcheck="false"
          role="combobox"
          [attr.aria-expanded]="true"
        />
        <z-input-group-addon zAlign="inline-end" class="empty:hidden"
          ><ng-content select="[data-slot=command-input-trailing]"
        /></z-input-group-addon>
      </z-input-group>
    </div>
  `,
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => ZardCommandInputComponent),
      multi: true,
    },
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  viewProviders: [provideIcons({ lucideSearch })],
  exportAs: 'zCommandInput',
})
export class ZardCommandInputComponent implements ControlValueAccessor {
  protected readonly commandComponent = inject(ZardCommand, { optional: true });
  // `#searchInput` sits on an `input[z-input]` component, so read the element explicitly.
  readonly searchInput = viewChild<unknown, ElementRef<HTMLInputElement>>(
    'searchInput',
    { read: ElementRef },
  );

  /** Default: "Type a command or search…", translated. */
  readonly placeholder = input<string>('');
  /**
   * `palette`: the search row of a command palette (Cmd/Ctrl+K): no field border, a rule below,
   * larger text. Project a key hint (`data-slot="command-input-trailing"`) to show at its end.
   */
  readonly zVariant = input<'default' | 'palette'>('default');
  /** The field's accessible name. Default: "Search commands", translated. */
  readonly label = input<string>('');

  readonly valueChange = output<string>();

  readonly searchTerm = signal('');
  readonly disabled = signal(false);

  protected onChange = (_: string) => {
    /* CVA */
  };

  protected onTouched = () => {
    /* CVA */
  };

  onInput(event: Event) {
    const { value } = event.target as HTMLInputElement;
    this.updateParentComponents(value);
  }

  updateParentComponents(value: string): void {
    this.searchTerm.set(value);
    this.commandComponent?.onSearch(value);
    this.onChange(value);
    this.valueChange.emit(value);
  }

  onKeyDown(event: KeyboardEvent) {
    if (['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(event.key)) {
      if (event.key !== 'Escape') {
        event.preventDefault();
        event.stopPropagation();
      }
      this.commandComponent?.onKeyDown(event);
    }
  }

  writeValue(value: string | null): void {
    const normalized = value ?? '';
    this.searchTerm.set(normalized);
    this.commandComponent?.onSearch(normalized);
  }

  registerOnChange(fn: (value: string) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this.disabled.set(isDisabled);
  }

  focus(): void {
    this.searchInput()?.nativeElement?.focus();
  }
}
