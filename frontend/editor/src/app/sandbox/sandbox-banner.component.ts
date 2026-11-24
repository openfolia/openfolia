import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  DOCUMENT,
  ElementRef,
  inject,
  input,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideClock,
  lucideExternalLink,
  lucideFlaskConical,
} from '@ng-icons/lucide';

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
 */
@Component({
  selector: 'of-sandbox-banner',
  imports: [NgIcon, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({ lucideClock, lucideExternalLink, lucideFlaskConical }),
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
            class="text-foreground focus-visible:ring-ring inline-flex shrink-0 items-center gap-1.5 rounded-sm font-medium whitespace-nowrap underline underline-offset-4 outline-none hover:no-underline focus-visible:ring-2 max-sm:ms-6"
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
    }
  `,
})
export class SandboxBannerComponent {
  protected readonly session = inject(SandboxSession);
  protected readonly soon = SOON_MINUTES;
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
