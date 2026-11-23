import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  output,
  signal,
  untracked,
  viewChild,
  ElementRef,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideGitBranch, lucideLock } from '@ng-icons/lucide';

import { AvatarComponent } from '@openfolia/ui/avatar';
import { ZardButtonComponent } from '@openfolia/ui/button';
import { CollapseComponent } from '@openfolia/ui/collapse';
import { ZardDialogImports } from '@openfolia/ui/dialog';
import { DatePipe, RelativeTimePipe } from '@openfolia/ui/i18n';
import { ZardTextareaComponent } from '@openfolia/ui/textarea';

import { GuardDirective } from '../permissions/guard.directive';
import { STATE_KEYS } from '../session/change-set-control.component';
import { heldLong, TAKE_OVER_COMMENT_MAX, type HeldLock } from './module-lock';

/** Where the dialog stands: told who edits the module, or writing why to take it over. */
export type LockedStep = 'ask' | 'takeOver';

/** When the lock was taken, as the holder card shows it: "09:12" today, else "Nov 18, 09:12". */
const SINCE_TODAY: Intl.DateTimeFormatOptions = { timeStyle: 'short' };
const SINCE: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
};

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

/**
 * Screen 12: someone else is editing this module. Says who and since when (and in which
 * revision, when the API says it), and offers to open it read-only (the default), to go back to
 * the content, or (only for those who may, by the permission helper: `admin.roles`) to take
 * over editing. Taking over asks why in the same dialog (the comment the API records with the
 * broken lock) and hands it on (`takeOver`); the page breaks the lock and opens the module for
 * editing, or says here why not (`error`).
 *
 * The reader's own lock, in another of their revisions (`own`, #472): it says so and names that
 * revision, and offers to open it there (`openThere`, the default) or, while that revision has
 * no changes to the module, to release it there (`releaseThere`) and edit it here.
 *
 * The page keeps the step in the address, so the dialog only reports what was chosen.
 */
@Component({
  selector: 'of-module-locked-dialog',
  imports: [
    ZardDialogImports,
    ZardButtonComponent,
    ZardTextareaComponent,
    AvatarComponent,
    CollapseComponent,
    DatePipe,
    RelativeTimePipe,
    GuardDirective,
    TranslocoPipe,
    NgIcon,
  ],
  viewProviders: [provideIcons({ lucideLock, lucideGitBranch })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <z-dialog
      [zVisible]="open()"
      [zCloseOnNavigation]="false"
      [zClosable]="false"
      [zMaskClosable]="step() === 'ask' && !busy()"
      (zVisibleChange)="$event || readOnly.emit()"
      class="sm:max-w-[32rem]"
    >
      <z-dialog-header>
        <span
          class="bg-info-muted text-info mb-2 flex size-10 items-center justify-center rounded-lg"
          aria-hidden="true"
        >
          <ng-icon name="lucideLock" size="18" />
        </span>
        <z-dialog-title class="text-lg/7 break-words">{{
          (own() ? 'editor.moduleLock.own.title' : 'editor.moduleLock.title')
            | transloco
        }}</z-dialog-title>
      </z-dialog-header>

      <div class="flex min-w-0 flex-col gap-4">
        @if (own()) {
          <div
            class="bg-muted flex min-w-0 items-center gap-3 rounded-lg px-3 py-2.5"
            data-slot="lock-change-set"
          >
            <span
              class="bg-background text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-full"
              aria-hidden="true"
            >
              <ng-icon name="lucideGitBranch" size="16" />
            </span>
            <span class="flex min-w-0 flex-col gap-0.5">
              <span class="text-sm font-medium break-words">{{
                lock()?.changeSetTitle ||
                  ('editor.moduleLock.own.untitled' | transloco)
              }}</span>
              <span class="text-muted-foreground text-xs break-words">
                @if (stateKey(); as state) {
                  {{ state | transloco }}{{ lock()?.since ? ' ·' : '' }}
                }
                @if (lock()?.since; as since) {
                  {{
                    'editor.moduleLock.since'
                      | transloco
                        : {
                            since: since | ofDate: sinceFormat(),
                            ago: since | ofRelativeTime,
                          }
                  }}
                }
              </span>
            </span>
          </div>
        } @else {
          <div
            class="bg-muted flex min-w-0 items-center gap-3 rounded-lg px-3 py-2.5"
            data-slot="lock-holder"
          >
            <of-avatar
              [name]="holderName() || ('editor.moduleLock.someone' | transloco)"
            />
            <span class="flex min-w-0 flex-col gap-0.5">
              <span class="text-sm font-medium break-words">{{
                holderName() || ('editor.moduleLock.someone' | transloco)
              }}</span>
              @if (lock()?.since; as since) {
                <span class="text-muted-foreground text-xs break-words">
                  {{
                    'editor.moduleLock.since'
                      | transloco
                        : {
                            since: since | ofDate: sinceFormat(),
                            ago: since | ofRelativeTime,
                          }
                  }}
                </span>
              }
              @if (lock()?.changeSetTitle; as title) {
                <span
                  class="text-muted-foreground text-xs break-words"
                  data-slot="lock-holder-change-set"
                >
                  {{ 'editor.moduleLock.inChangeSet' | transloco: { title } }}
                </span>
              }
            </span>
          </div>
        }

        <z-dialog-description class="text-foreground break-words">
          {{
            description()
              | transloco: { since: (lock()?.since ?? '' | ofDate: longSince) }
          }}
        </z-dialog-description>

        <of-collapse [open]="step() === 'takeOver'">
          <form
            id="lock-take-over-form"
            class="flex flex-col gap-1.5"
            novalidate
            (submit)="submit($event)"
          >
            <p class="text-muted-foreground m-0 mb-1 text-sm break-words">
              {{ 'editor.moduleLock.takeOver.what' | transloco }}
            </p>
            <label class="text-sm font-medium" for="lock-take-over-comment">{{
              'editor.moduleLock.takeOver.comment' | transloco
            }}</label>
            <textarea
              #comment
              id="lock-take-over-comment"
              z-textarea
              rows="3"
              required
              aria-describedby="lock-take-over-hint"
              [attr.maxlength]="commentMax"
              [attr.aria-invalid]="missing() ? 'true' : null"
              [value]="text()"
              (input)="text.set($any($event.target).value)"
            ></textarea>
            <p
              id="lock-take-over-hint"
              class="text-muted-foreground m-0 text-xs break-words"
              [class.text-destructive]="missing()"
            >
              {{
                (missing()
                  ? 'editor.moduleLock.takeOver.commentMissing'
                  : 'editor.moduleLock.takeOver.commentHint'
                ) | transloco
              }}
            </p>
          </form>
        </of-collapse>
        @if (error(); as message) {
          <p class="text-destructive m-0 text-sm break-words" role="alert">
            {{ message }}
          </p>
        }
      </div>

      <z-dialog-footer>
        @if (step() === 'ask') {
          <button
            z-button
            zType="ghost"
            type="button"
            class="text-muted-foreground hover:text-foreground sm:me-auto"
            data-slot="lock-take-over"
            [ofGuard]="{
              permission: 'admin.roles',
              blockedReason: lock()?.id
                ? null
                : 'editor.moduleLock.unknownLock',
            }"
            (click)="startTakeOver.emit()"
          >
            {{ 'editor.moduleLock.takeOver.action' | transloco }}
          </button>
          @if (own()) {
            <button
              z-button
              zType="ghost"
              type="button"
              data-slot="lock-read-only"
              [zDisabled]="busy()"
              (click)="readOnly.emit()"
            >
              {{ 'editor.moduleLock.readOnly' | transloco }}
            </button>
            @if (lock()?.hasChanges === false) {
              <button
                z-button
                zType="outline"
                type="button"
                data-slot="lock-release-there"
                [zDisabled]="busy()"
                [zLoading]="releasing()"
                (click)="releaseThere.emit()"
              >
                {{ 'editor.moduleLock.own.release' | transloco }}
              </button>
            }
            <button
              z-button
              type="button"
              data-slot="lock-open-there"
              cdkFocusInitial
              [zDisabled]="busy()"
              (click)="openThere.emit()"
            >
              {{ 'editor.moduleLock.own.open' | transloco }}
            </button>
          } @else {
            <button
              z-button
              zType="ghost"
              type="button"
              data-slot="lock-back"
              (click)="back.emit()"
            >
              {{ 'editor.moduleLock.back' | transloco }}
            </button>
            <button
              z-button
              type="button"
              data-slot="lock-read-only"
              cdkFocusInitial
              (click)="readOnly.emit()"
            >
              {{ 'editor.moduleLock.readOnly' | transloco }}
            </button>
          }
        } @else {
          <button
            z-button
            zType="ghost"
            type="button"
            data-slot="lock-take-over-cancel"
            [zDisabled]="busy()"
            (click)="cancelTakeOver.emit()"
          >
            {{ 'editor.moduleLock.takeOver.cancel' | transloco }}
          </button>
          <button
            z-button
            type="submit"
            form="lock-take-over-form"
            data-slot="lock-take-over-confirm"
            [zDisabled]="busy()"
            [zLoading]="busy()"
          >
            {{ 'editor.moduleLock.takeOver.confirm' | transloco }}
          </button>
        }
      </z-dialog-footer>
    </z-dialog>
  `,
})
export class ModuleLockedDialogComponent {
  readonly open = input(false);
  readonly step = input<LockedStep>('ask');
  /** The lock another change set holds. */
  readonly lock = input<HeldLock | null>(null);
  /** The holder as people read them; empty when the API does not say who it is. */
  readonly holderName = input('');
  /** The lock is the reader's own, in another of their revisions (#472). */
  readonly own = input(false);
  /** A take-over, or a release there, is under way. */
  readonly busy = input(false);
  /** Releasing it there is under way. */
  readonly releasing = input(false);
  /** Why the last take-over (or release there) failed, translated; empty when it did not. */
  readonly error = input('');

  /** "Open read-only", Escape, the mask, the close button. */
  readonly readOnly = output<void>();
  readonly back = output<void>();
  readonly startTakeOver = output<void>();
  readonly cancelTakeOver = output<void>();
  /** "Open that revision": the module, in the revision holding it (`own`). */
  readonly openThere = output<void>();
  /** "Release it there": frees it in that revision, to edit it here (`own`, unchanged there). */
  readonly releaseThere = output<void>();
  /** The comment, trimmed. */
  readonly takeOver = output<string>();

  protected readonly commentMax = TAKE_OVER_COMMENT_MAX;
  protected readonly longSince = SINCE;
  protected readonly sinceFormat = computed(() => {
    const since = this.lock()?.since;
    return since && sameDay(new Date(since), new Date()) ? SINCE_TODAY : SINCE;
  });
  /** The holding revision's state, as people read it (a key); null when not told. */
  protected readonly stateKey = computed(() => {
    const state = this.lock()?.changeSetState;
    return state && state in STATE_KEYS
      ? STATE_KEYS[state as keyof typeof STATE_KEYS]
      : null;
  });
  /**
   * What the reader can do: their own lock says whether their changes are kept there; someone
   * else's says to wait, unless it has been held for over a day (locks never expire: waiting
   * would never end), then since when.
   */
  protected readonly description = computed(() => {
    const lock = this.lock();
    if (this.own()) {
      return lock?.hasChanges === false
        ? 'editor.moduleLock.own.unchanged'
        : 'editor.moduleLock.own.kept';
    }
    return lock && heldLong(lock)
      ? 'editor.moduleLock.waitLong'
      : 'editor.moduleLock.wait';
  });
  protected readonly text = signal('');
  private readonly submitted = signal(false);
  protected readonly missing = computed(
    () => this.submitted() && this.text().trim() === '',
  );
  private readonly comment = viewChild('comment', {
    read: ElementRef<HTMLTextAreaElement>,
  });

  constructor() {
    // Each take-over starts empty, with the caret in the comment.
    effect(() => {
      const writing = this.open() && this.step() === 'takeOver';
      untracked(() => {
        if (!writing) {
          this.text.set('');
          this.submitted.set(false);
          return;
        }
        queueMicrotask(() =>
          this.comment()?.nativeElement.focus({ preventScroll: true }),
        );
      });
    });
  }

  protected submit(event: Event): void {
    event.preventDefault();
    this.submitted.set(true);
    const comment = this.text().trim();
    if (!comment || this.busy()) return;
    this.takeOver.emit(comment);
  }
}
