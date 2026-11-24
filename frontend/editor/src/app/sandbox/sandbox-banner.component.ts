import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  DOCUMENT,
  ElementRef,
  inject,
  input,
  signal,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowRight,
  lucideClock,
  lucideExternalLink,
  lucideFlaskConical,
  lucideLogOut,
  lucideTrash2,
} from '@ng-icons/lucide';

import { ZardAlertDialogImports } from '@openfolia/ui/alert-dialog';
import { buttonVariants, ZardButtonComponent } from '@openfolia/ui/button';
import { mergeClasses } from '@openfolia/ui/ui';

import { SandboxSession } from './sandbox-session';

/** From this many minutes left the time is set apart (heavier, its clock in the warning colour). */
const SOON_MINUTES = 5;

/** The CSS variable a list cap subtracts with its fixed offset: the banner's height and margin. */
export const SANDBOX_HEIGHT_VAR = '--of-sandbox-h';

/**
 * The public sandbox's banner (#826), slim, at the top of every screen (the shell's page column
 * and the sign-in pages): that this sandbox is the visitor's alone and goes with the session,
 * and the time left. Nothing in a normal instance. The mode is known before the first screen
 * renders (`SandboxSession.start()` in the app's initializer), so it is there at first paint and
 * nothing below it moves; the time is in tabular figures, so it does not jitter as it counts.
 *
 * With `measure` (the shell's), its height and bottom margin, as wrapped at the width shown, are
 * `--of-sandbox-h` on the root, for the lists capped at the viewport less a fixed offset
 * (`calc(100dvh - 20rem - var(--of-sandbox-h, 0px))`), so their pagination stays in view.
 *
 * The time is not announced as it counts (a live region ticking every minute would talk over the
 * page); the session's end is, once.
 *
 * "End demo" (#846), when the API names an end address: the `ui` alert dialog asks first
 * ("Everything in it is deleted"), then the session posts to the launcher and goes to its "thanks"
 * page; a failure is said in the dialog, which stays open. Once the session has ended, the same
 * place offers the way back to the start page, without asking.
 */
@Component({
  selector: 'of-sandbox-banner',
  imports: [NgIcon, TranslocoPipe, ZardButtonComponent, ZardAlertDialogImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideArrowRight,
      lucideClock,
      lucideExternalLink,
      lucideFlaskConical,
      lucideLogOut,
      lucideTrash2,
    }),
  ],
  host: { class: 'block empty:hidden' },
  template: `
    @if (session.on()) {
      <aside
        data-testid="sandbox-banner"
        [attr.aria-label]="'editor.sandbox.banner.label' | transloco"
        class="border-info/25 bg-info-muted text-foreground flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border px-3 py-1.5 text-xs/5"
      >
        <p class="m-0 flex min-w-0 flex-1 basis-64 items-start gap-2">
          <ng-icon
            name="lucideFlaskConical"
            class="text-info mt-0.5 size-4 shrink-0"
            size="16"
            strokeWidth="1.75"
            aria-hidden="true"
          />
          <span class="min-w-0 break-words">{{
            'editor.sandbox.banner.text' | transloco
          }}</span>
        </p>
        @if (session.info()?.portalUrl; as portalUrl) {
          <a
            data-testid="sandbox-portal-link"
            [class]="portalClass"
            [href]="portalUrl"
            target="_blank"
            rel="noopener noreferrer"
          >
            {{ 'editor.sandbox.banner.portal' | transloco }}
            <span class="sr-only">{{
              'editor.sandbox.banner.portalNewTab' | transloco
            }}</span>
            <ng-icon
              name="lucideExternalLink"
              class="size-3.5 shrink-0"
              size="14"
              strokeWidth="1.75"
              aria-hidden="true"
            />
          </a>
        }
        @let minutes = session.minutesLeft();
        @if (minutes !== null) {
          <p
            data-testid="sandbox-time-left"
            class="m-0 ms-auto flex shrink-0 items-center gap-1.5 whitespace-nowrap tabular-nums max-sm:ms-6"
            [class]="
              minutes <= soon
                ? 'text-foreground font-semibold'
                : 'text-foreground/80 font-medium'
            "
            [attr.data-soon]="minutes > 0 && minutes <= soon ? '' : null"
          >
            <ng-icon
              name="lucideClock"
              class="size-3.5 shrink-0"
              [class.text-warning]="minutes <= soon"
              size="14"
              strokeWidth="1.75"
              aria-hidden="true"
            />
            {{
              minutes === 0
                ? ('editor.sandbox.banner.ended' | transloco)
                : ('editor.sandbox.banner.timeLeft' | transloco: { minutes })
            }}
          </p>
        }
        @if (session.info()?.endUrl) {
          @if (minutes === 0) {
            <button
              type="button"
              z-button
              zSize="sm"
              data-testid="sandbox-start-page"
              [class]="actionClass"
              (click)="leave()"
            >
              {{ 'editor.sandbox.banner.startPage' | transloco }}
              <ng-icon
                name="lucideArrowRight"
                class="size-3.5 shrink-0"
                size="14"
                strokeWidth="1.75"
                aria-hidden="true"
              />
            </button>
          } @else {
            <button
              type="button"
              z-button
              zType="outline"
              zSize="sm"
              data-testid="sandbox-end"
              aria-haspopup="dialog"
              [class]="actionClass"
              (click)="confirming.set(true)"
            >
              <ng-icon
                name="lucideLogOut"
                class="size-3.5 shrink-0"
                size="14"
                strokeWidth="1.75"
                aria-hidden="true"
              />
              {{ 'editor.sandbox.banner.end' | transloco }}
            </button>
          }
        }
        <!-- Always there, so a screen reader hears the end when it is filled in. -->
        <span
          role="status"
          class="sr-only"
          data-testid="sandbox-ended-status"
          >{{
            minutes === 0 ? ('editor.sandbox.banner.ended' | transloco) : ''
          }}</span
        >
      </aside>
      <z-alert-dialog
        [zVisible]="confirming()"
        (zVisibleChange)="confirming.set($event)"
        (zAfterClose)="failed.set(false)"
        data-testid="sandbox-end-dialog"
      >
        <z-alert-dialog-header>
          <z-alert-dialog-media class="bg-destructive/10 text-destructive">
            <ng-icon
              name="lucideTrash2"
              strokeWidth="1.75"
              aria-hidden="true"
            />
          </z-alert-dialog-media>
          <z-alert-dialog-title>{{
            'editor.sandbox.end.title' | transloco
          }}</z-alert-dialog-title>
          <z-alert-dialog-description>{{
            'editor.sandbox.end.description' | transloco
          }}</z-alert-dialog-description>
        </z-alert-dialog-header>
        <!-- Always there, so the failure is heard when it is filled in; no room taken until then. Under
             the description: past the media on wide screens, centred as the header on narrow ones. -->
        <p
          role="alert"
          data-testid="sandbox-end-error"
          class="text-destructive m-0 text-center text-sm text-balance empty:hidden sm:ps-14 sm:text-start"
        >
          {{ failed() ? ('editor.sandbox.end.failed' | transloco) : '' }}
        </p>
        <z-alert-dialog-footer>
          <button
            type="button"
            z-button
            zType="outline"
            z-alert-dialog-close
            [zDisabled]="ending()"
          >
            {{ 'editor.sandbox.end.cancel' | transloco }}
          </button>
          <button
            type="button"
            z-button
            zType="destructive"
            data-testid="sandbox-end-confirm"
            [zLoading]="ending()"
            (click)="end()"
          >
            {{
              (ending()
                ? 'editor.sandbox.end.ending'
                : 'editor.sandbox.end.confirm'
              ) | transloco
            }}
          </button>
        </z-alert-dialog-footer>
      </z-alert-dialog>
    }
  `,
})
export class SandboxBannerComponent {
  protected readonly session = inject(SandboxSession);
  protected readonly soon = SOON_MINUTES;
  /** The `ui` outline button, small: it stands out from the banner's tint in both themes. */
  protected readonly portalClass = mergeClasses(
    buttonVariants({ zType: 'outline', zSize: 'sm' }),
    'text-xs gap-1.5 shadow-xs motion-reduce:transition-none max-sm:ms-6',
  );
  /** "End demo" and "Back to the start page": the portal button's size, in the banner's text size. */
  protected readonly actionClass =
    'text-xs gap-1.5 shadow-xs motion-reduce:transition-none';
  /** The confirmation is open. */
  protected readonly confirming = signal(false);
  /** The end request is under way: the dialog's buttons wait. */
  protected readonly ending = signal(false);
  /** The last end request failed: the dialog says so. */
  protected readonly failed = signal(false);

  /** Ends the sandbox once confirmed; on a failure the dialog says so and stays (or opens again). */
  protected async end(): Promise<void> {
    if (this.ending()) return;
    this.ending.set(true);
    this.failed.set(false);
    try {
      await this.session.end();
    } catch {
      this.failed.set(true);
      this.confirming.set(true);
      this.ending.set(false);
    }
  }

  /** The session has ended: to the launcher's page, which thanks the visitor. */
  protected leave(): void {
    this.session.leave();
  }

  /** Publish the height as `--of-sandbox-h` (the shell's banner; the sign-in pages have no lists). */
  readonly measure = input(false);

  constructor() {
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    const root = inject(DOCUMENT).documentElement;
    let observer: ResizeObserver | null = null;
    afterNextRender(() => {
      if (!this.measure() || typeof ResizeObserver === 'undefined') return;
      const publish = () => {
        const height = host.getBoundingClientRect().height;
        const margin = parseFloat(getComputedStyle(host).marginBottom) || 0;
        root.style.setProperty(
          SANDBOX_HEIGHT_VAR,
          `${height > 0 ? Math.ceil(height + margin) : 0}px`,
        );
      };
      observer = new ResizeObserver(publish);
      observer.observe(host);
      publish();
    });
    inject(DestroyRef).onDestroy(() => {
      observer?.disconnect();
      if (this.measure()) root.style.removeProperty(SANDBOX_HEIGHT_VAR);
    });
  }
}
