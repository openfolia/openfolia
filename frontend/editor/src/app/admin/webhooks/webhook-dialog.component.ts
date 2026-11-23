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
import { FormsModule } from '@angular/forms';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideInfo,
  lucideLock,
  lucidePlus,
  lucideTrash2,
  lucideTriangleAlert,
} from '@ng-icons/lucide';

import { ZardBadgeComponent } from '@openfolia/ui/badge';
import { ZardButtonComponent } from '@openfolia/ui/button';
import { ZardCheckboxComponent } from '@openfolia/ui/checkbox';
import { ZardDialogImports } from '@openfolia/ui/dialog';
import { ZardInputComponent } from '@openfolia/ui/input';
import { ZardSelectImports } from '@openfolia/ui/select';
import type { TranslatedText } from '@openfolia/ui/i18n';
import { ZardSwitchComponent } from '@openfolia/ui/switch';

import {
  checkUrl,
  DESCRIPTION_MAX,
  EVENT_TEXT,
  type HeaderApiError,
  HEADER_NAME_MAX,
  HEADER_PROBLEM_TEXT,
  HEADER_VALUE_GONE_TEXT,
  type HeaderDraft,
  headerDrafts,
  headerProblems,
  headersProblem,
  headersProblemText,
  HEADERS_MAX,
  sensitiveHeaderName,
  URL_PROBLEM_TEXT,
  URL_MAX,
  WEBHOOK_EVENTS,
  type WebhookDraft,
  type WebhookEvent,
  type WebhookItem,
} from './webhooks-model';

/** An audience level as the form offers it. */
export interface AudienceOption {
  readonly id: string;
  readonly label: string;
}

/** A header row: its draft, a key to track it by, and whether its value was stored secret. */
interface HeaderRow extends HeaderDraft {
  readonly key: number;
  /** A secret header stored already: "Keep" goes back to its stored value, under its stored name. */
  readonly stored: boolean;
  /** Its name as stored ('' for a new row): "Keep" after a rename restores it (#560). */
  readonly storedName: string;
  /** "Secret" was switched by hand: a sensitive name no longer turns it on. */
  readonly secretChosen: boolean;
  /** Edited (or a save was tried): its problems show. */
  readonly touched: boolean;
}

/** An error the API named for a row, shown on it until the row changes. */
interface RowApiError {
  readonly field: 'name' | 'value' | null;
  readonly text: TranslatedText;
}

/** The select's value for "no limit" (a select item needs a value; no level is spelt so). */
const NO_LIMIT = '*';

/**
 * Adding a subscriber or changing one (#254): its URL (checked as the API checks it before it is
 * sent), a name, the events it is sent (checkboxes, at least one) and an optional audience limit
 * from the configuration's levels. Editing someone else's subscriber says that pointing it at
 * another URL makes the editor its owner (it then hears what they may read) and that the secret
 * stays, so they should rotate it. A manager whose scope does not cover any owner's (`reshape`
 * false) may change only its name. Its custom headers (#457): name, value and a "Secret" switch per
 * row (on by itself for a credential's name such as `Authorization`, #560); a stored secret one shows
 * only "Set", with Replace (a password field for a new value, and Keep to go back to the stored
 * header, its name included) and Remove; the API's problems show on the rows their pointers name; a new URL asks for each secret value again, as the API does. Only its owner
 * or a manager covering any owner of any (`editHeaders`) may change them. The page saves what it hands over (`save`) and closes the
 * dialog once the API has taken it, or shows why not (`error`) and keeps it open.
 */
@Component({
  selector: 'of-webhook-dialog',
  imports: [
    FormsModule,
    ZardDialogImports,
    ZardBadgeComponent,
    ZardButtonComponent,
    ZardCheckboxComponent,
    ZardInputComponent,
    ZardSelectImports,
    ZardSwitchComponent,
    NgIcon,
    TranslocoPipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideInfo,
      lucideLock,
      lucidePlus,
      lucideTrash2,
      lucideTriangleAlert,
    }),
  ],
  template: `
    <z-dialog [(zVisible)]="open" class="sm:max-w-[36rem]">
      <z-dialog-header>
        <z-dialog-title>{{
          (webhook()
            ? 'editor.admin.webhooks.form.editTitle'
            : 'editor.admin.webhooks.form.newTitle'
          ) | transloco
        }}</z-dialog-title>
        <z-dialog-description>{{
          'editor.admin.webhooks.form.description' | transloco
        }}</z-dialog-description>
      </z-dialog-header>
      @if (open()) {
        <form
          id="webhook-form"
          class="-mx-4 flex max-h-[calc(100dvh-13rem)] min-w-0 flex-col gap-4 overflow-y-auto overscroll-contain px-4 py-1"
          novalidate
          (submit)="submit($event)"
        >
          <div class="flex flex-col gap-1.5">
            <label class="text-sm" for="webhook-url">{{
              'editor.admin.webhooks.form.url' | transloco
            }}</label>
            <input
              id="webhook-url"
              z-input
              type="url"
              inputmode="url"
              autocomplete="off"
              spellcheck="false"
              class="font-mono"
              required
              [placeholder]="urlPlaceholder"
              [attr.maxlength]="urlMax"
              [disabled]="!reshape()"
              [attr.aria-invalid]="shownUrlProblem() ? 'true' : null"
              aria-describedby="webhook-url-hint"
              [value]="url()"
              (input)="url.set($any($event.target).value)"
            />
            <p
              id="webhook-url-hint"
              class="text-muted-foreground m-0 text-xs break-words"
              [class.text-destructive]="!!shownUrlProblem()"
              [class.text-warning]="
                !shownUrlProblem() && (urlCheck().insecure || urlCheck().local)
              "
            >
              {{
                (shownUrlProblem()
                  ? urlText()
                  : urlCheck().local
                    ? 'editor.admin.webhooks.url.local'
                    : urlCheck().insecure
                      ? 'editor.admin.webhooks.url.insecure'
                      : 'editor.admin.webhooks.form.urlHint'
                ) | transloco
              }}
            </p>
            @if (takesOver()) {
              <p
                data-slot="webhook-takeover"
                class="border-warning/40 bg-warning-muted text-foreground animate-in fade-in-0 m-0 flex items-start gap-2 rounded-md border p-2.5 text-xs break-words duration-200 motion-reduce:animate-none"
              >
                <ng-icon
                  name="lucideTriangleAlert"
                  class="text-warning mt-0.5 shrink-0"
                  aria-hidden="true"
                />
                {{ 'editor.admin.webhooks.form.takeover' | transloco }}
              </p>
            } @else if (webhook()) {
              <p
                class="text-muted-foreground m-0 flex items-start gap-2 text-xs break-words"
              >
                <ng-icon
                  name="lucideInfo"
                  class="mt-0.5 shrink-0"
                  aria-hidden="true"
                />
                {{ 'editor.admin.webhooks.form.ownership' | transloco }}
              </p>
            }
          </div>

          <div class="flex flex-col gap-1.5">
            <label class="text-sm" for="webhook-name">{{
              'editor.admin.webhooks.form.name' | transloco
            }}</label>
            <input
              id="webhook-name"
              z-input
              autocomplete="off"
              [attr.maxlength]="descriptionMax"
              [placeholder]="
                'editor.admin.webhooks.form.namePlaceholder' | transloco
              "
              [value]="description()"
              (input)="description.set($any($event.target).value)"
            />
          </div>

          <fieldset class="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
            <legend class="mb-1.5 p-0 text-sm">
              {{ 'editor.admin.webhooks.form.events' | transloco }}
            </legend>
            @for (e of events; track e) {
              <div class="flex min-w-0 flex-col gap-0.5">
                <z-checkbox
                  class="min-w-0 break-words"
                  [attr.data-event]="e"
                  [zDisabled]="!reshape()"
                  [zInvalid]="shownEventsProblem()"
                  [ngModel]="chosen().includes(e)"
                  [ngModelOptions]="{ standalone: true }"
                  (checkChange)="toggle(e, $event)"
                >
                  <span class="font-mono text-[0.8125rem]">{{ e }}</span>
                </z-checkbox>
                <span class="text-muted-foreground ms-6 text-xs break-words">{{
                  eventText[e] | transloco
                }}</span>
              </div>
            }
            @if (shownEventsProblem()) {
              <p class="text-destructive m-0 text-xs" role="alert">
                {{ 'editor.admin.webhooks.form.eventsProblem' | transloco }}
              </p>
            }
          </fieldset>

          <div class="flex flex-col gap-1.5">
            <span class="text-sm" id="webhook-audience-label">{{
              'editor.admin.webhooks.form.audience' | transloco
            }}</span>
            @if (audiences().length > 0) {
              <z-select
                zPosition="popper"
                [zDisabled]="!reshape()"
                [zAriaLabel]="'editor.admin.webhooks.form.audience' | transloco"
                [zValue]="maxAudience()"
                (zSelectionChange)="setAudience($event)"
              >
                <z-select-item [zValue]="noLimit">{{
                  'editor.admin.webhooks.form.noLimit' | transloco
                }}</z-select-item>
                @for (a of audiences(); track a.id) {
                  <z-select-item [zValue]="a.id">{{
                    'editor.admin.webhooks.form.upTo'
                      | transloco: { level: a.label }
                  }}</z-select-item>
                }
              </z-select>
            } @else {
              <p class="text-muted-foreground m-0 text-xs break-words">
                {{
                  (maxAudience() !== noLimit
                    ? 'editor.admin.webhooks.form.audienceUnknown'
                    : 'editor.admin.webhooks.form.audienceNone'
                  ) | transloco: { level: maxAudience() }
                }}
              </p>
            }
            <p class="text-muted-foreground m-0 text-xs break-words">
              {{ 'editor.admin.webhooks.form.audienceHint' | transloco }}
            </p>
          </div>

          <fieldset
            class="m-0 flex min-w-0 flex-col gap-2 border-0 p-0"
            data-slot="webhook-headers"
          >
            <legend class="mb-1.5 p-0 text-sm">
              {{ 'editor.admin.webhooks.headers.title' | transloco }}
            </legend>
            <p class="text-muted-foreground m-0 text-xs break-words">
              {{ 'editor.admin.webhooks.headers.hint' | transloco }}
            </p>
            @for (h of headers(); track h.key; let i = $index) {
              <div
                class="border-border animate-in fade-in-0 slide-in-from-top-1 flex min-w-0 flex-col gap-2 rounded-md border p-2.5 duration-200 motion-reduce:animate-none"
                data-header="row"
                [attr.data-index]="i"
              >
                <div class="flex min-w-0 items-end gap-2">
                  <div class="flex min-w-0 flex-1 flex-col gap-1">
                    <label
                      class="text-xs"
                      [for]="'webhook-header-name-' + h.key"
                      >{{
                        'editor.admin.webhooks.headers.name' | transloco
                      }}</label
                    >
                    <input
                      [id]="'webhook-header-name-' + h.key"
                      z-input
                      autocomplete="off"
                      spellcheck="false"
                      class="font-mono"
                      data-header="name"
                      [placeholder]="headerNamePlaceholder"
                      [attr.maxlength]="headerNameMax"
                      [disabled]="!editHeaders()"
                      [readonly]="h.kept"
                      [attr.aria-invalid]="
                        invalidField(h, i, 'name') ? 'true' : null
                      "
                      [value]="h.name"
                      (input)="
                        setHeader(h.key, { name: $any($event.target).value })
                      "
                    />
                  </div>
                  <button
                    z-button
                    zType="ghost"
                    zSize="icon"
                    type="button"
                    data-header="remove"
                    [zDisabled]="!editHeaders()"
                    [attr.aria-label]="
                      'editor.admin.webhooks.headers.remove'
                        | transloco: { name: h.name || '…' }
                    "
                    (click)="removeHeader(h.key)"
                  >
                    <ng-icon name="lucideTrash2" aria-hidden="true" />
                  </button>
                </div>
                <div class="flex min-w-0 flex-col gap-1">
                  @if (h.kept) {
                    <span
                      class="text-xs"
                      [id]="'webhook-header-value-' + h.key"
                      >{{
                        'editor.admin.webhooks.headers.value' | transloco
                      }}</span
                    >
                    <div
                      class="flex min-w-0 flex-wrap items-center gap-2"
                      [attr.aria-labelledby]="'webhook-header-value-' + h.key"
                    >
                      <z-badge zType="secondary" data-header="set">
                        <ng-icon name="lucideLock" aria-hidden="true" />
                        {{ 'editor.admin.webhooks.headers.set' | transloco }}
                      </z-badge>
                      <button
                        z-button
                        zType="outline"
                        zSize="sm"
                        type="button"
                        data-header="replace"
                        [zDisabled]="!editHeaders()"
                        (click)="replaceHeader(h.key)"
                      >
                        {{
                          'editor.admin.webhooks.headers.replace' | transloco
                        }}
                      </button>
                    </div>
                  } @else {
                    <label
                      class="text-xs"
                      [for]="'webhook-header-value-' + h.key"
                      >{{
                        'editor.admin.webhooks.headers.value' | transloco
                      }}</label
                    >
                    <div class="flex min-w-0 items-center gap-2">
                      <input
                        [id]="'webhook-header-value-' + h.key"
                        z-input
                        autocomplete="off"
                        spellcheck="false"
                        class="min-w-0 flex-1 font-mono"
                        data-header="value"
                        [type]="h.secret ? 'password' : 'text'"
                        [disabled]="!editHeaders()"
                        [attr.aria-invalid]="
                          invalidField(h, i, 'value') ? 'true' : null
                        "
                        [value]="h.value"
                        (input)="
                          setHeader(h.key, { value: $any($event.target).value })
                        "
                      />
                      @if (h.stored) {
                        <button
                          z-button
                          zType="ghost"
                          zSize="sm"
                          type="button"
                          data-header="keep"
                          (click)="keepHeader(h.key)"
                        >
                          {{ 'editor.admin.webhooks.headers.keep' | transloco }}
                        </button>
                      }
                    </div>
                  }
                </div>
                <z-switch
                  zSize="sm"
                  data-header="secret"
                  [zChecked]="h.secret"
                  [zDisabled]="!editHeaders() || h.kept"
                  (zCheckedChange)="setHeader(h.key, { secret: $event })"
                  >{{
                    'editor.admin.webhooks.headers.secret' | transloco
                  }}</z-switch
                >
                @if (rowMessage(h, i); as message) {
                  <p
                    class="text-destructive animate-in fade-in-0 m-0 text-xs break-words duration-200 motion-reduce:animate-none"
                    role="alert"
                    data-header="problem"
                  >
                    {{ message.key | transloco: message.params }}
                  </p>
                }
              </div>
            }
            @if (listMessage(); as message) {
              <p
                class="text-destructive animate-in fade-in-0 m-0 text-xs break-words duration-200 motion-reduce:animate-none"
                role="alert"
                data-header="list-problem"
              >
                {{ message.key | transloco: message.params }}
              </p>
            }
            @if (editHeaders()) {
              <button
                z-button
                zType="outline"
                zSize="sm"
                type="button"
                class="self-start"
                data-header="add"
                [zDisabled]="headers().length >= headersMax"
                (click)="addHeader()"
              >
                <ng-icon name="lucidePlus" aria-hidden="true" />
                {{ 'editor.admin.webhooks.headers.add' | transloco }}
              </button>
            } @else {
              <p class="text-muted-foreground m-0 text-xs break-words">
                {{ 'editor.admin.webhooks.headers.notYours' | transloco }}
              </p>
            }
          </fieldset>

          @if (!reshape()) {
            <p class="text-muted-foreground m-0 text-xs break-words">
              {{ 'editor.admin.webhooks.form.narrower' | transloco }}
            </p>
          }
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
          {{ 'editor.admin.cancel' | transloco }}
        </button>
        <button
          z-button
          type="submit"
          form="webhook-form"
          data-slot="webhook-save"
          [zDisabled]="busy()"
          [zLoading]="busy()"
        >
          {{
            (webhook()
              ? 'editor.admin.save'
              : 'editor.admin.webhooks.form.create'
            ) | transloco
          }}
        </button>
      </z-dialog-footer>
    </z-dialog>
  `,
})
export class WebhookDialogComponent {
  readonly open = model(false);
  /** The subscriber to change; null to add one. */
  readonly webhook = input<WebhookItem | null>(null);
  /** Whether the actor owns it (a new one: yes). */
  readonly owned = input(true);
  /** Whether the actor may change its URL, events and audience limit. */
  readonly reshape = input(true);
  /** Whether the actor may change its custom headers (its owner, or a manager covering any owner of any). */
  readonly editHeaders = input(true);
  /** The configuration's audience levels, least restricted first; none when unknown. */
  readonly audiences = input<readonly AudienceOption[]>([]);
  readonly busy = input(false);
  /** Why the last save failed, translated; empty when it did not (or the headers say it, below). */
  readonly error = input('');
  /** The custom headers' problems of the last save, as the API named them; shown on their rows. */
  readonly headerErrors = input<readonly HeaderApiError[]>([]);
  readonly save = output<WebhookDraft>();

  protected readonly events = WEBHOOK_EVENTS;
  protected readonly eventText = EVENT_TEXT;
  protected readonly urlMax = URL_MAX;
  /** A URL's start, the same in every language. */
  protected readonly urlPlaceholder = 'https://';
  protected readonly descriptionMax = DESCRIPTION_MAX;
  protected readonly noLimit = NO_LIMIT;
  protected readonly url = signal('');
  protected readonly description = signal('');
  protected readonly chosen = signal<readonly WebhookEvent[]>([]);
  protected readonly maxAudience = signal(NO_LIMIT);
  protected readonly headers = signal<readonly HeaderRow[]>([]);
  protected readonly headersMax = HEADERS_MAX;
  protected readonly headerNameMax = HEADER_NAME_MAX;
  /** The API's problems for rows (by row key) and for the rows together, until they change. */
  private readonly apiRowErrors = signal<ReadonlyMap<number, RowApiError>>(
    new Map(),
  );
  private readonly apiListError = signal<TranslatedText | null>(null);
  /** A header name's example, the same in every language. */
  protected readonly headerNamePlaceholder = 'Authorization';
  private readonly submitted = signal(false);
  /** The rows' keys in the order the last save sent them: what the API's pointers index. */
  private sentKeys: readonly number[] = [];
  private nextKey = 0;

  /** Whether the URL differs from the stored one: kept secret headers then need their values again. */
  private readonly urlChanged = computed(() => {
    const webhook = this.webhook();
    return !!webhook && this.url().trim() !== webhook.attributes.url;
  });
  protected readonly headerChecks = computed(() =>
    headerProblems(this.headers(), this.urlChanged()),
  );

  /** The rows together: too many, or too long (a kept secret's value counts on the API only). */
  private readonly listCheck = computed(() => headersProblem(this.headers()));
  protected readonly listMessage = computed<TranslatedText | null>(() => {
    const problem = this.listCheck();
    return problem ? headersProblemText(problem) : this.apiListError();
  });

  protected readonly urlCheck = computed(() => checkUrl(this.url()));
  protected readonly shownUrlProblem = computed(() => {
    const problem = this.urlCheck().problem;
    // While typing a new URL, say what is wrong only once a save was tried (or something was typed).
    if (!problem) return null;
    if (problem === 'empty') return this.submitted() ? problem : null;
    return this.url().trim() ? problem : null;
  });
  protected readonly urlText = computed(() => {
    const problem = this.shownUrlProblem();
    return problem ? URL_PROBLEM_TEXT[problem] : '';
  });
  protected readonly shownEventsProblem = computed(
    () => this.submitted() && this.chosen().length === 0,
  );
  /** Someone else's, pointed at another URL: the editor becomes its owner. */
  protected readonly takesOver = computed(() => {
    const webhook = this.webhook();
    return (
      !!webhook &&
      !this.owned() &&
      this.url().trim() !== '' &&
      this.url().trim() !== webhook.attributes.url
    );
  });

  constructor() {
    // Every opening starts from the subscriber (or empty, with every release event).
    effect(() => {
      if (!this.open()) return;
      const webhook = this.webhook();
      untracked(() => {
        this.url.set(webhook?.attributes.url ?? '');
        this.description.set(webhook?.attributes.description ?? '');
        this.chosen.set(
          webhook?.attributes.events ?? ['manual.released', 'module.released'],
        );
        this.maxAudience.set(webhook?.attributes.maxAudience ?? NO_LIMIT);
        this.headers.set(
          headerDrafts(webhook?.attributes.headers ?? []).map((d) => ({
            ...d,
            key: this.nextKey++,
            stored: d.kept,
            storedName: d.name,
            secretChosen: false,
            touched: false,
          })),
        );
        this.submitted.set(false);
      });
    });
    // The API's header problems go to the rows their pointers name: the rows as they were sent
    // (`sentKeys`), so a row added, removed or moved while the answer was on its way is never
    // marked for another's problem; one whose row was removed meanwhile no longer holds. Any other
    // shows on the rows together.
    effect(() => {
      const errors = this.headerErrors();
      untracked(() => {
        const rows = this.headers();
        const byRow = new Map<number, RowApiError>();
        let list: TranslatedText | null = null;
        for (const e of errors) {
          const sentKey = e.index === null ? undefined : this.sentKeys[e.index];
          if (sentKey === undefined) {
            list ??= e.text;
            continue;
          }
          const row = rows.find((r) => r.key === sentKey);
          if (!row) continue;
          if (byRow.has(row.key)) continue;
          byRow.set(row.key, {
            field: e.field,
            text:
              row.kept && e.code === 'header-value-required'
                ? { key: HEADER_VALUE_GONE_TEXT }
                : e.text,
          });
        }
        this.apiRowErrors.set(byRow);
        this.apiListError.set(list);
      });
    });
  }

  /** The rows changed: the API's problem with one row (or all of them) no longer holds. */
  private settled(key: number | null): void {
    this.apiListError.set(null);
    if (key === null || !this.apiRowErrors().has(key)) return;
    this.apiRowErrors.update((errors) => {
      const next = new Map(errors);
      next.delete(key);
      return next;
    });
  }

  protected toggle(event: WebhookEvent, on: boolean): void {
    this.chosen.update((list) =>
      WEBHOOK_EVENTS.filter((e) => (e === event ? on : list.includes(e))),
    );
  }

  /** A row's problem once it was edited or a save was tried (a kept secret's at once: the URL changed). */
  private shownProblem(row: HeaderRow, index: number) {
    const problem = this.headerChecks()[index] ?? null;
    if (!problem) return null;
    return row.touched || this.submitted() || problem === 'value-again'
      ? problem
      : null;
  }

  /** What a row says is wrong: the form's own check first, else what the API said of it. */
  protected rowMessage(row: HeaderRow, index: number): TranslatedText | null {
    const problem = this.shownProblem(row, index);
    if (problem) {
      return {
        key: HEADER_PROBLEM_TEXT[problem],
        params: { max: HEADER_NAME_MAX },
      };
    }
    return this.apiRowErrors().get(row.key)?.text ?? null;
  }

  protected invalidField(
    row: HeaderRow,
    index: number,
    field: 'name' | 'value',
  ): boolean {
    const problem = this.shownProblem(row, index);
    if (problem) return problem.startsWith(field);
    return this.apiRowErrors().get(row.key)?.field === field;
  }

  protected addHeader(): void {
    this.headers.update((rows) => [
      ...rows,
      {
        key: this.nextKey++,
        name: '',
        value: '',
        secret: false,
        kept: false,
        stored: false,
        storedName: '',
        secretChosen: false,
        touched: false,
      },
    ]);
    this.settled(null);
  }

  protected removeHeader(key: number): void {
    this.headers.update((rows) => rows.filter((r) => r.key !== key));
    this.settled(key);
  }

  /**
   * A row edited. A sensitive name (`Authorization`, `X-Api-Key`, …) turns "Secret" on unless it
   * was switched by hand; it only ever turns it on, so a value typed already is never shown.
   */
  protected setHeader(
    key: number,
    change: Partial<Pick<HeaderDraft, 'name' | 'value' | 'secret'>>,
  ): void {
    this.headers.update((rows) =>
      rows.map((r) => {
        if (r.key !== key) return r;
        const chosen = r.secretChosen || change.secret !== undefined;
        const sensitive =
          !chosen &&
          change.name !== undefined &&
          sensitiveHeaderName(change.name);
        return {
          ...r,
          ...change,
          ...(sensitive && { secret: true }),
          secretChosen: chosen,
          touched: true,
        };
      }),
    );
    this.settled(key);
  }

  /** A stored secret's value is never shown: replacing it asks for a new one. */
  protected replaceHeader(key: number): void {
    this.headers.update((rows) =>
      rows.map((r) => (r.key === key ? { ...r, kept: false, value: '' } : r)),
    );
    this.settled(key);
  }

  /**
   * Back to the stored secret, as it is stored: its name too, so a rename after Replace never
   * keeps a stored value under another name (which the API refuses, #560).
   */
  protected keepHeader(key: number): void {
    this.headers.update((rows) =>
      rows.map((r) =>
        r.key === key
          ? { ...r, name: r.storedName, kept: true, secret: true, value: '' }
          : r,
      ),
    );
    this.settled(key);
  }

  protected setAudience(value: string | string[]): void {
    const level = Array.isArray(value) ? value[0] : value;
    this.maxAudience.set(level || NO_LIMIT);
  }

  protected submit(event: Event): void {
    event.preventDefault();
    this.submitted.set(true);
    if (
      this.urlCheck().problem ||
      this.chosen().length === 0 ||
      this.headerChecks().some((p) => p !== null) ||
      this.listCheck() ||
      this.busy()
    ) {
      return;
    }
    this.sentKeys = this.headers().map((r) => r.key);
    this.save.emit({
      url: this.url().trim(),
      description: this.description().trim().replace(/\s+/g, ' '),
      events: this.chosen(),
      maxAudience: this.maxAudience() === NO_LIMIT ? '' : this.maxAudience(),
      headers: this.headers().map(({ name, value, secret, kept }) => ({
        name,
        value,
        secret,
        kept,
      })),
    });
  }
}
