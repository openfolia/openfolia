import {
  ChangeDetectionStrategy,
  Component,
  DOCUMENT,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCircleCheck } from '@ng-icons/lucide';
import { firstValueFrom } from 'rxjs';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { FadeInDirective } from '@openfolia/ui/smooth';
import {
  ErrorStateComponent,
  SkeletonRowsComponent,
} from '@openfolia/ui/states';

import { ApiClient, toApiError, type ApiError } from '../api';
import { SignInFrameComponent } from '../sign-in/sign-in-frame.component';
import {
  type ChosenKind,
  KIND_GROUPS,
  KIND_TEXTS,
} from './notification-settings-model';
import { NOTIFICATION_SETTINGS_PATH } from './notifications-menu-item.component';

/** What an unsubscribe token looks like (the API's `UnsubscribeToken`). */
const TOKEN = /^[A-Za-z0-9_-]{20,1000}$/;

/** Every kind, in the settings page's order. */
const NOTIFICATION_KINDS = KIND_GROUPS.flatMap((group) => group.kinds);

type View = 'ask' | 'working' | 'done' | 'nothing' | 'invalid' | 'failed';

/**
 * The page a notification email's unsubscribe link opens (#884): `unsubscribe#<token>`. The
 * token is in the fragment, which no server sees; the page takes it, drops it from the address
 * and, once the person confirms, sends it (`POST /notifications/unsubscribe/{token}`), signed in or not. Done, it names the
 * kinds that now come in the app only; a link this server did not make says so; a failure offers
 * to try again. Nothing else changes. It asks first (one button), so a link scanner that opens the page
 * changes nothing; a mail client's own one-click unsubscribe posts to the API directly.
 */
@Component({
  selector: 'of-unsubscribe-page',
  imports: [
    TranslocoPipe,
    RouterLink,
    NgIcon,
    ZardButtonComponent,
    FadeInDirective,
    SkeletonRowsComponent,
    ErrorStateComponent,
    SignInFrameComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideCircleCheck })],
  host: { class: 'block', 'data-testid': 'unsubscribe-page' },
  template: `
    <of-sign-in-frame
      [heading]="headings[view()] | transloco"
      [busy]="view() === 'working'"
    >
      <div [attr.data-view]="view()" class="flex flex-col gap-4">
        @switch (view()) {
          @case ('ask') {
            <div ofFadeIn class="flex flex-col gap-3 text-sm">
              @if (asked.length > 0) {
                <p class="m-0 break-words">
                  {{ 'editor.unsubscribe.done' | transloco }}
                </p>
                <ul
                  class="m-0 flex list-disc flex-col gap-1 ps-5"
                  data-slot="unsubscribe-kinds"
                >
                  @for (kind of asked; track kind) {
                    <li class="break-words">
                      {{ kindTexts[kind].label | transloco }}
                    </li>
                  }
                </ul>
                <p class="text-muted-foreground m-0 break-words">
                  {{ 'editor.unsubscribe.askInApp' | transloco }}
                </p>
              } @else {
                <p class="text-muted-foreground m-0 break-words">
                  {{ 'editor.unsubscribe.ask' | transloco }}
                </p>
              }
              <button
                z-button
                type="button"
                class="w-fit"
                data-slot="unsubscribe-confirm"
                (click)="send()"
              >
                {{ 'editor.unsubscribe.confirm' | transloco }}
              </button>
            </div>
          }
          @case ('working') {
            <of-skeleton-rows
              [count]="2"
              [label]="'editor.unsubscribe.working' | transloco"
            />
          }
          @case ('done') {
            <div ofFadeIn class="flex flex-col gap-3 text-sm">
              <p class="m-0 flex min-w-0 items-start gap-2">
                <ng-icon
                  name="lucideCircleCheck"
                  aria-hidden="true"
                  class="text-success mt-0.5 shrink-0"
                />
                <span class="min-w-0 break-words">{{
                  'editor.unsubscribe.done' | transloco
                }}</span>
              </p>
              <ul
                class="m-0 flex list-disc flex-col gap-1 ps-9"
                data-slot="unsubscribed-kinds"
              >
                @for (kind of kinds(); track kind) {
                  <li class="break-words">
                    {{ kindTexts[kind].label | transloco }}
                  </li>
                }
              </ul>
              <p class="text-muted-foreground m-0 break-words">
                {{ 'editor.unsubscribe.stillInApp' | transloco }}
              </p>
              <a
                z-button
                zType="outline"
                class="w-fit"
                [routerLink]="settingsPath"
                data-slot="to-settings"
                >{{ 'editor.unsubscribe.toSettings' | transloco }}</a
              >
            </div>
          }
          @case ('nothing') {
            <div ofFadeIn class="flex flex-col gap-3 text-sm">
              <p class="text-muted-foreground m-0 break-words">
                {{ 'editor.unsubscribe.nothing' | transloco }}
              </p>
              <a
                z-button
                zType="outline"
                class="w-fit"
                [routerLink]="settingsPath"
                >{{ 'editor.unsubscribe.toSettings' | transloco }}</a
              >
            </div>
          }
          @case ('invalid') {
            <div ofFadeIn class="flex flex-col gap-3 text-sm">
              <p class="text-muted-foreground m-0 break-words">
                {{ 'editor.unsubscribe.invalid' | transloco }}
              </p>
              <a
                z-button
                zType="outline"
                class="w-fit"
                [routerLink]="settingsPath"
                >{{ 'editor.unsubscribe.toSettings' | transloco }}</a
              >
            </div>
          }
          @case ('failed') {
            <of-error-state
              class="py-4"
              [kind]="failure()?.kind ?? 'unknown'"
              [retryable]="true"
              (retry)="send()"
            />
          }
        }
      </div>
    </of-sign-in-frame>
  `,
})
export class UnsubscribePage {
  private readonly api = inject(ApiClient);
  private readonly token: string | null;

  /** The kinds the link names, to say before asking; none from a link without them. */
  protected readonly asked: readonly ChosenKind[];

  protected readonly settingsPath = NOTIFICATION_SETTINGS_PATH;
  protected readonly kindTexts = KIND_TEXTS;
  protected readonly headings: Readonly<Record<View, string>> = {
    ask: 'editor.unsubscribe.heading.ask',
    working: 'editor.unsubscribe.heading.working',
    done: 'editor.unsubscribe.heading.done',
    nothing: 'editor.unsubscribe.heading.nothing',
    invalid: 'editor.unsubscribe.heading.invalid',
    failed: 'editor.unsubscribe.heading.failed',
  };
  protected readonly view = signal<View>('ask');
  protected readonly failure = signal<ApiError | null>(null);
  protected readonly kinds = signal<readonly ChosenKind[]>([]);

  constructor() {
    const location = inject(DOCUMENT).location;
    // `<token>&kinds=<kind>,…`: the kinds are only named, what stops is what the token holds (the
    // answer says which), so a changed link can stop nothing else.
    const [token = '', kinds = ''] = location.hash
      .replace(/^#/, '')
      .split('&kinds=');
    this.token = TOKEN.test(token) ? token : null;
    const named = new Set(kinds.split(','));
    this.asked = NOTIFICATION_KINDS.filter((kind) => named.has(kind));
    // Out of the address (and the history) at once: whoever has the link can use it.
    if (location.hash) {
      history.replaceState(history.state, '', location.pathname);
    }
    // Asked first: a link scanner that opens the page (and runs it) changes nothing. The mail
    // client's one-click unsubscribe (RFC 8058) posts to the API itself.
    if (this.token === null) this.view.set('invalid');
  }

  async send(): Promise<void> {
    if (this.token === null) {
      this.view.set('invalid');
      return;
    }
    this.view.set('working');
    this.failure.set(null);
    try {
      const doc = await firstValueFrom(
        this.api.act('/notifications/unsubscribe/{token}', {
          path: { token: this.token },
        }),
      );
      this.kinds.set(doc.meta.kinds);
      this.view.set(doc.meta.kinds.length > 0 ? 'done' : 'nothing');
    } catch (error) {
      const failure = toApiError(error);
      if (failure.code === 'unsubscribe-link-invalid') {
        this.view.set('invalid');
        return;
      }
      this.failure.set(failure);
      this.view.set('failed');
    }
  }
}
