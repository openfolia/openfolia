import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  input,
  model,
  viewChild,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';

import { ZardInputComponent } from '@openfolia/ui/input';

/**
 * A code of the authenticator app, or with `recovery` a recovery code (#611): one field, so a
 * whole code pastes and a password manager fills it. It takes the focus when it appears.
 */
@Component({
  selector: 'of-second-factor-code',
  imports: [TranslocoPipe, ZardInputComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex flex-col gap-1.5' },
  template: `
    <label class="text-sm" [attr.for]="inputId()">{{
      (recovery()
        ? 'editor.secondFactor.code.recovery'
        : 'editor.secondFactor.code.app'
      ) | transloco
    }}</label>
    <input
      #field
      z-input
      type="text"
      autocapitalize="none"
      spellcheck="false"
      maxlength="64"
      required
      [id]="inputId()"
      [attr.inputmode]="recovery() ? 'text' : 'numeric'"
      [attr.autocomplete]="recovery() ? 'off' : 'one-time-code'"
      [attr.aria-describedby]="inputId() + '-hint'"
      [attr.aria-invalid]="invalid() ? 'true' : null"
      [class]="
        recovery()
          ? 'font-mono text-sm tracking-wide uppercase'
          : 'font-mono text-lg tracking-[0.3em]'
      "
      [value]="code()"
      (input)="code.set($any($event.target).value)"
    />
    <p
      class="text-muted-foreground m-0 text-xs break-words"
      [id]="inputId() + '-hint'"
    >
      {{
        (recovery()
          ? 'editor.secondFactor.code.recoveryHint'
          : 'editor.secondFactor.code.appHint'
        ) | transloco
      }}
    </p>
  `,
})
export class SecondFactorCodeComponent {
  readonly inputId = input.required<string>();
  readonly recovery = input(false);
  readonly invalid = input(false);
  readonly code = model('');

  // `z-input` is a component: its element is asked for.
  private readonly field = viewChild.required<
    unknown,
    ElementRef<HTMLInputElement>
  >('field', { read: ElementRef });

  constructor() {
    afterNextRender(() => this.focus());
  }

  focus(): void {
    this.field().nativeElement.focus({ preventScroll: true });
  }
}
