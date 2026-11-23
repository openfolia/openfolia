import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  model,
  output,
  signal,
  untracked,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { ZardDialogImports } from '@openfolia/ui/dialog';
import { ZardTextareaComponent } from '@openfolia/ui/textarea';

import { REASON_MAX, reasonProblem } from './releases-model';

/**
 * Withdrawing a release (#331: final, so it is confirmed with the reason, never undone): what it
 * does, the reason (required, shown to every reader), and a destructive "Withdraw release". The
 * page withdraws what it hands over (`withdraw`) and closes the dialog once the API took it, or
 * shows why not (`error`) and keeps it open.
 */
@Component({
  selector: 'of-withdraw-release-dialog',
  imports: [
    ZardDialogImports,
    ZardButtonComponent,
    ZardTextareaComponent,
    TranslocoPipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <z-dialog [(zVisible)]="open" class="sm:max-w-[32rem]">
      <z-dialog-header>
        <z-dialog-title class="break-words">{{
          'editor.releases.withdraw.title' | transloco: { name: name() }
        }}</z-dialog-title>
        <z-dialog-description>{{
          'editor.releases.withdraw.description' | transloco
        }}</z-dialog-description>
      </z-dialog-header>
      @if (open()) {
        <form
          id="withdraw-release-form"
          class="flex flex-col gap-1.5"
          novalidate
          (submit)="submit($event)"
        >
          <label class="text-sm" for="withdraw-reason">{{
            'editor.releases.withdraw.reason' | transloco
          }}</label>
          <textarea
            id="withdraw-reason"
            z-textarea
            rows="4"
            required
            aria-describedby="withdraw-reason-hint"
            [attr.maxlength]="reasonMax"
            [attr.aria-invalid]="shown() ? 'true' : null"
            [value]="reason()"
            (input)="reason.set($any($event.target).value)"
          ></textarea>
          <p
            id="withdraw-reason-hint"
            class="text-muted-foreground m-0 text-xs break-words"
            [class.text-destructive]="!!shown()"
          >
            {{ shown() ?? 'editor.releases.withdraw.reasonHint' | transloco }}
          </p>
          @if (error(); as message) {
            <p
              class="text-destructive m-0 text-sm break-words"
              role="alert"
              aria-live="assertive"
            >
              {{ message }}
            </p>
          }
        </form>
      }
      <z-dialog-footer>
        <button z-button zType="ghost" type="button" z-dialog-close>
          {{ 'editor.releases.cancel' | transloco }}
        </button>
        <button
          z-button
          zType="destructive"
          type="submit"
          form="withdraw-release-form"
          data-slot="withdraw-confirm"
          [zDisabled]="busy()"
          [zLoading]="busy()"
        >
          {{ 'editor.releases.withdraw.confirm' | transloco }}
        </button>
      </z-dialog-footer>
    </z-dialog>
  `,
})
export class WithdrawReleaseDialogComponent {
  readonly open = model(false);
  /** The release as people read it ("North 2.1"). */
  readonly name = input('');
  /** Withdrawing is under way: the button waits. */
  readonly busy = input(false);
  /** Why the last attempt failed, translated; empty when it did not. */
  readonly error = input('');
  /** The reason, trimmed. */
  readonly withdraw = output<string>();

  protected readonly reasonMax = REASON_MAX;
  protected readonly reason = signal('');
  private readonly submitted = signal(false);
  private readonly problem = computed(() => reasonProblem(this.reason()));
  protected readonly shown = computed(() =>
    this.submitted() ? this.problem() : null,
  );

  constructor() {
    // Every opening starts empty.
    effect(() => {
      if (!this.open()) return;
      untracked(() => {
        this.reason.set('');
        this.submitted.set(false);
      });
    });
  }

  protected submit(event: Event): void {
    event.preventDefault();
    this.submitted.set(true);
    if (this.problem() || this.busy()) return;
    this.withdraw.emit(this.reason().trim());
  }
}
