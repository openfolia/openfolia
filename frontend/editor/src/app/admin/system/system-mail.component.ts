import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  output,
  signal,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCircleCheck,
  lucideMailCheck,
  lucideTriangleAlert,
} from '@ng-icons/lucide';
import { firstValueFrom } from 'rxjs';

import { ZardButtonComponent } from '@openfolia/ui/button';
import {
  injectTranslate,
  LanguageService,
  translated,
} from '@openfolia/ui/i18n';
import {
  SkeletonRowsComponent,
  ErrorStateComponent,
} from '@openfolia/ui/states';
import { ToastService } from '@openfolia/ui/toast';

import { ApiClient, toApiError, type ApiError, type Response } from '../../api';
import { apiErrorText } from '../../i18n';
import { SandboxSession } from '../../sandbox/sandbox-session';
import { SandboxNoteComponent } from '../../sandbox/sandbox-note.component';

type MailSettings = Response<'/mail'>['data'];

/** The languages an email is written in; another interface language leaves it to the installation's. */
const MAIL_LANGUAGES: ReadonlySet<string> = new Set(['en', 'de']);

/**
 * The Email section of Admin › System (#609): whether the server sends email and through which
 * mail server (`GET /mail`: host, port, TLS, sign-in, sender; never the password), read-only as
 * the settings are in the environment. Off, it says exactly why: no mail server, or no instance
 * secret key (with a link to where the key is shown, `secretKey`). "Send a test email" queues
 * one to the signed-in administrator (`POST /mail/test`), in the interface's language.
 */
@Component({
  selector: 'of-system-mail',
  imports: [
    SandboxNoteComponent,
    TranslocoPipe,
    NgIcon,
    ZardButtonComponent,
    SkeletonRowsComponent,
    ErrorStateComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({ lucideCircleCheck, lucideMailCheck, lucideTriangleAlert }),
  ],
  host: { class: 'block min-w-0' },
  template: `
    <section
      class="bg-card flex min-h-40 min-w-0 flex-col gap-3 rounded-xl border p-4"
      data-slot="mail-card"
      aria-labelledby="mail-heading"
      [attr.data-state]="settings()?.attributes?.state ?? null"
    >
      <div class="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id="mail-heading" class="m-0 text-base font-semibold">
          {{ 'editor.admin.system.mail.title' | transloco }}
        </h2>
        <span class="text-muted-foreground text-xs break-words">
          {{ 'editor.admin.system.mail.readOnly' | transloco }}
        </span>
      </div>
      @if (sandbox.on()) {
        <!-- A public sandbox sends no email (issue 826): every message is dropped. -->
        <of-sandbox-note [text]="'editor.sandbox.mailOff' | transloco" />
      }

      @if (loadError(); as e) {
        <of-error-state
          [kind]="e.kind"
          [heading]="'editor.admin.system.mail.loadFailed' | transloco"
          [message]="e.message"
          (retry)="load()"
        />
      } @else if (settings(); as s) {
        <div class="of-mail-fade flex min-w-0 flex-col gap-3">
          @switch (s.attributes.state) {
            @case ('on') {
              <p
                class="m-0 flex min-w-0 items-start gap-2 text-sm"
                data-slot="mail-on"
              >
                <ng-icon
                  name="lucideCircleCheck"
                  aria-hidden="true"
                  class="text-success mt-0.5 shrink-0"
                />
                <span class="min-w-0 break-words">{{
                  'editor.admin.system.mail.on' | transloco
                }}</span>
              </p>
              <dl
                class="m-0 grid min-w-0 grid-cols-1 gap-3 text-sm sm:grid-cols-2"
                data-slot="mail-settings"
              >
                <div class="min-w-0">
                  <dt class="text-muted-foreground text-xs">
                    {{ 'editor.admin.system.mail.server' | transloco }}
                  </dt>
                  <dd
                    class="m-0 font-mono text-xs [overflow-wrap:anywhere]"
                    data-slot="mail-server"
                  >
                    {{ s.attributes.host }}:{{ s.attributes.port }}
                  </dd>
                </div>
                <div class="min-w-0">
                  <dt class="text-muted-foreground text-xs">
                    {{ 'editor.admin.system.mail.tls' | transloco }}
                  </dt>
                  <dd class="m-0 break-words" data-slot="mail-tls">
                    {{ tlsKey() | transloco }}
                  </dd>
                </div>
                <div class="min-w-0">
                  <dt class="text-muted-foreground text-xs">
                    {{ 'editor.admin.system.mail.sender' | transloco }}
                  </dt>
                  <dd
                    class="m-0 [overflow-wrap:anywhere]"
                    data-slot="mail-sender"
                  >
                    {{ s.attributes.senderName }} &lt;{{
                      s.attributes.from
                    }}&gt;
                  </dd>
                </div>
                <div class="min-w-0">
                  <dt class="text-muted-foreground text-xs">
                    {{ 'editor.admin.system.mail.signIn' | transloco }}
                  </dt>
                  <dd class="m-0 break-words" data-slot="mail-sign-in">
                    {{
                      (s.attributes.authenticated
                        ? 'editor.admin.system.mail.signInYes'
                        : 'editor.admin.system.mail.signInNo'
                      ) | transloco
                    }}
                  </dd>
                </div>
              </dl>
              <!-- A public sandbox sends no email (issue 826): no test, the note above says why. -->
              @if (!sandbox.on()) {
                <div class="flex min-w-0 flex-wrap items-center gap-3">
                  <button
                    z-button
                    zType="outline"
                    type="button"
                    data-slot="mail-test"
                    [zLoading]="sending()"
                    [zDisabled]="sending()"
                    (click)="sendTest()"
                  >
                    {{ 'editor.admin.system.mail.sendTest' | transloco }}
                  </button>
                  @if (queuedTo(); as to) {
                    <p
                      role="status"
                      class="text-muted-foreground of-mail-fade m-0 flex min-w-0 items-start gap-2 text-xs"
                      data-slot="mail-test-queued"
                    >
                      <ng-icon
                        name="lucideMailCheck"
                        aria-hidden="true"
                        class="mt-0.5 shrink-0"
                      />
                      <span class="min-w-0 [overflow-wrap:anywhere]">{{
                        'editor.admin.system.mail.queued' | transloco: { to }
                      }}</span>
                    </p>
                  }
                </div>
              }
            }
            @case ('no-secret-key') {
              <div
                role="status"
                class="border-warning bg-warning-muted flex min-w-0 items-start gap-3 rounded-lg border p-3 text-sm"
                data-slot="mail-no-secret-key"
              >
                <ng-icon
                  name="lucideTriangleAlert"
                  aria-hidden="true"
                  class="text-warning mt-0.5 shrink-0"
                />
                <div class="flex min-w-0 flex-col gap-1">
                  <p class="m-0 font-medium break-words">
                    {{ 'editor.admin.system.mail.noKey.title' | transloco }}
                  </p>
                  <p class="text-muted-foreground m-0 break-words">
                    {{
                      'editor.admin.system.mail.noKey.text'
                        | transloco: { host: s.attributes.host }
                    }}
                  </p>
                  <a
                    class="text-foreground w-fit underline underline-offset-4 hover:no-underline focus-visible:no-underline"
                    href="#system-secret-key"
                    data-slot="mail-secret-key-link"
                    (click)="toSecretKey($event)"
                    >{{ 'editor.admin.system.mail.noKey.link' | transloco }}</a
                  >
                </div>
              </div>
            }
            @default {
              <div
                class="flex min-w-0 items-start gap-3 rounded-lg border p-3 text-sm"
                data-slot="mail-off"
              >
                <ng-icon
                  name="lucideTriangleAlert"
                  aria-hidden="true"
                  class="text-muted-foreground mt-0.5 shrink-0"
                />
                <div class="flex min-w-0 flex-col gap-1">
                  <p class="m-0 font-medium break-words">
                    {{ 'editor.admin.system.mail.off.title' | transloco }}
                  </p>
                  <p class="text-muted-foreground m-0 break-words">
                    {{ 'editor.admin.system.mail.off.text' | transloco }}
                  </p>
                </div>
              </div>
            }
          }
        </div>
      } @else {
        <of-skeleton-rows
          [count]="3"
          [label]="'editor.admin.system.mail.loading' | transloco"
        />
      }
    </section>
  `,
  styles: `
    .of-mail-fade {
      animation: of-mail-fade 160ms ease-out;
    }
    @keyframes of-mail-fade {
      from {
        opacity: 0;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .of-mail-fade {
        animation: none;
      }
    }
  `,
})
export class SystemMailComponent {
  protected readonly sandbox = inject(SandboxSession);
  private readonly api = inject(ApiClient);
  private readonly language = inject(LanguageService);
  private readonly toast = inject(ToastService);
  private readonly t = injectTranslate();

  /** Asks the page to bring the secret key's entry into view. */
  readonly secretKey = output<void>();

  protected readonly settings = signal<MailSettings | null>(null);
  private readonly loadFailure = signal<ApiError | null>(null);
  protected readonly sending = signal(false);
  protected readonly queuedTo = signal<string | null>(null);

  protected readonly loadError = computed(() => {
    const failure = this.loadFailure();
    if (!failure) return null;
    const text = apiErrorText(failure);
    return { kind: failure.kind, message: this.t(text.key, text.params) };
  });

  protected readonly tlsKey = computed(() => {
    switch (this.settings()?.attributes.tls) {
      case 'implicit':
        return 'editor.admin.system.mail.tlsImplicit';
      case 'opportunistic':
        return 'editor.admin.system.mail.tlsOpportunistic';
      default:
        return 'editor.admin.system.mail.tlsStarttls';
    }
  });

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    this.loadFailure.set(null);
    try {
      const doc = await firstValueFrom(this.api.get('/mail'));
      this.settings.set(doc.data);
    } catch (error) {
      this.loadFailure.set(toApiError(error));
    }
  }

  protected async sendTest(): Promise<void> {
    if (this.sending()) return;
    this.sending.set(true);
    this.queuedTo.set(null);
    const language = this.language.active();
    try {
      const doc = await firstValueFrom(
        this.api.act(
          '/mail/test',
          { path: {} as never },
          {
            data: {
              type: 'MailTest',
              ...(MAIL_LANGUAGES.has(language) && {
                attributes: { language: language as 'en' | 'de' },
              }),
            },
          },
        ),
      );
      const to = doc.data.attributes.to;
      this.queuedTo.set(to);
      this.toast.success(
        translated('editor.admin.system.mail.queuedToast', { to }),
      );
    } catch (error) {
      const failure = toApiError(error);
      const text = apiErrorText(failure);
      this.toast.error(translated(text.key, text.params));
      // Turned off since it was read (a restart without the key): show why.
      if (failure.code === 'not-configured') void this.load();
    } finally {
      this.sending.set(false);
    }
  }

  protected toSecretKey(event: Event): void {
    event.preventDefault();
    this.secretKey.emit();
  }
}
