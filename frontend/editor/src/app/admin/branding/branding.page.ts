import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideImageUp, lucideRotateCcw, lucideTrash2 } from '@ng-icons/lucide';
import { firstValueFrom } from 'rxjs';

import { ZardAlertDialogService } from '@openfolia/ui/alert-dialog';
import { ZardButtonComponent } from '@openfolia/ui/button';
import { injectTranslate, type TranslatedText } from '@openfolia/ui/i18n';
import { ZardInputComponent } from '@openfolia/ui/input';
import { ZardSkeletonComponent } from '@openfolia/ui/skeleton';
import { ErrorStateComponent } from '@openfolia/ui/states';
import { ToastService } from '@openfolia/ui/toast';

import { API_BASE_URL, ApiClient, toApiError, type ApiError } from '../../api';
import {
  type BrandingFields,
  type BrandingResource,
  changedFields,
  fieldsOf,
  IMAGE_FIELDS,
  type ImageField,
  imageUrl,
  normalHex,
  RESET,
  SQUARE_FIELDS,
} from '../../branding/branding-model';
import { BrandingService } from '../../branding/branding.service';
import { apiErrorText } from '../../i18n';
import { brandingErrorText, fieldErrors, PAIR_TEXTS } from './branding-errors';
import { SandboxSession } from '../../sandbox/sandbox-session';
import { SandboxNoteComponent } from '../../sandbox/sandbox-note.component';

/** What an image upload takes, as the API does: checked here first, to say so at once. */
const IMAGE_TYPES = ['image/png', 'image/webp'];
const MAX_IMAGE_BYTES = 1024 * 1024;

const COLOUR_FIELDS = ['primary', 'accent'] as const;
type ColourField = (typeof COLOUR_FIELDS)[number];

const IMAGE_KEYS: Readonly<
  Record<ImageField, { label: string; hint: string }>
> = {
  logoLight: {
    label: 'editor.admin.branding.images.logoLight.label',
    hint: 'editor.admin.branding.images.logoLight.hint',
  },
  logoDark: {
    label: 'editor.admin.branding.images.logoDark.label',
    hint: 'editor.admin.branding.images.logoDark.hint',
  },
  mark: {
    label: 'editor.admin.branding.images.mark.label',
    hint: 'editor.admin.branding.images.mark.hint',
  },
  favicon: {
    label: 'editor.admin.branding.images.favicon.label',
    hint: 'editor.admin.branding.images.favicon.hint',
  },
  appIcon: {
    label: 'editor.admin.branding.images.appIcon.label',
    hint: 'editor.admin.branding.images.appIcon.hint',
  },
};

const COLOUR_KEYS: Readonly<
  Record<ColourField, { label: string; picker: string; hint: string }>
> = {
  primary: {
    label: 'editor.admin.branding.colours.primary.label',
    picker: 'editor.admin.branding.colours.primary.picker',
    hint: 'editor.admin.branding.colours.primary.hint',
  },
  accent: {
    label: 'editor.admin.branding.colours.accent.label',
    picker: 'editor.admin.branding.colours.accent.picker',
    hint: 'editor.admin.branding.colours.accent.hint',
  },
};

const THEME_KEYS = {
  light: 'editor.admin.branding.themes.light',
  dark: 'editor.admin.branding.themes.dark',
} as const;

/**
 * The Branding tab of Admin (#169, `admin.branding`): the product name, the logos for light and
 * dark pages, the mark, the favicon, the app icon and the brand colours, with a preview of the
 * sidebar, a button and a card in light and dark. Every change is sent at once (`PATCH
 * /branding`) and shown at once in the whole editor; a refusal puts the last saved branding back,
 * says why under the field and in a toast. Images are uploaded first (`POST /branding/images`),
 * then named. "Reset to default" clears every field.
 */
@Component({
  selector: 'of-branding-page',
  imports: [
    SandboxNoteComponent,
    TranslocoPipe,
    NgIcon,
    ErrorStateComponent,
    ZardButtonComponent,
    ZardInputComponent,
    ZardSkeletonComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({ lucideImageUp, lucideRotateCcw, lucideTrash2 }),
  ],
  host: { class: 'flex min-w-0 flex-col gap-4' },
  template: `
    @if (loadError(); as e) {
      <of-error-state
        [kind]="e.kind"
        [heading]="'editor.admin.branding.loadFailed' | transloco"
        [message]="e.message"
        (retry)="load()"
      />
    } @else if (!saved()) {
      <div class="flex flex-col gap-4" data-slot="branding-loading">
        <z-skeleton class="h-28 w-full rounded-xl" />
        <z-skeleton class="h-72 w-full rounded-xl" />
      </div>
    } @else {
      <div
        class="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] xl:items-start"
      >
        <div class="flex min-w-0 flex-col gap-4">
          <section
            class="bg-card flex min-w-0 flex-col gap-3 rounded-xl border p-4"
            aria-labelledby="branding-name-heading"
          >
            <h2 id="branding-name-heading" class="m-0 text-base font-semibold">
              {{ 'editor.admin.branding.name.title' | transloco }}
            </h2>
            <div class="flex min-w-0 flex-col gap-1.5">
              <label class="text-sm" for="branding-product-name">{{
                'editor.admin.branding.name.label' | transloco
              }}</label>
              <input
                id="branding-product-name"
                z-input
                type="text"
                autocomplete="off"
                maxlength="80"
                class="max-w-md"
                [placeholder]="defaultName"
                [value]="fields().productName ?? ''"
                [attr.aria-invalid]="errors().productName ? 'true' : null"
                aria-describedby="branding-product-name-hint"
                (change)="setName($any($event.target).value)"
                (keydown.enter)="$any($event.target).blur()"
              />
              <p
                id="branding-product-name-hint"
                class="text-muted-foreground m-0 text-xs break-words"
              >
                {{ 'editor.admin.branding.name.hint' | transloco }}
              </p>
              @if (errors().productName; as e) {
                <p
                  class="text-destructive m-0 text-xs break-words"
                  role="alert"
                >
                  {{ say(e) }}
                </p>
              }
            </div>
          </section>

          <section
            class="bg-card flex min-w-0 flex-col gap-3 rounded-xl border p-4"
            aria-labelledby="branding-images-heading"
          >
            <div class="flex min-w-0 flex-col gap-1">
              <h2
                id="branding-images-heading"
                class="m-0 text-base font-semibold"
              >
                {{ 'editor.admin.branding.images.title' | transloco }}
              </h2>
              <p class="text-muted-foreground m-0 text-xs break-words">
                {{ 'editor.admin.branding.images.hint' | transloco }}
              </p>
              @if (sandbox.on()) {
                <!-- A public sandbox takes no uploads (issue 826): the images stay as they are. -->
                <of-sandbox-note
                  class="mt-1"
                  [text]="'editor.sandbox.uploadsOff' | transloco"
                />
              }
            </div>
            <ul class="m-0 flex list-none flex-col divide-y p-0">
              @for (field of imageFields; track field) {
                <li
                  class="flex min-w-0 flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0"
                  [attr.data-field]="field"
                >
                  <div
                    class="flex h-14 w-28 shrink-0 items-center justify-center overflow-hidden rounded-md border p-1.5"
                    [class.dark]="field === 'logoDark'"
                    [class.bg-background]="true"
                    data-slot="thumbnail"
                  >
                    @if (shownImage(field); as src) {
                      <img
                        [src]="src"
                        alt=""
                        class="max-h-full max-w-full object-contain"
                      />
                    } @else {
                      <span class="text-muted-foreground text-xs">{{
                        'editor.admin.branding.images.default' | transloco
                      }}</span>
                    }
                  </div>
                  <div class="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
                    <span class="text-sm font-medium" [id]="field + '-label'">{{
                      imageKeys[field].label | transloco
                    }}</span>
                    <span class="text-muted-foreground text-xs break-words">{{
                      imageKeys[field].hint | transloco
                    }}</span>
                    @if (errors()[field]; as e) {
                      <span
                        class="text-destructive text-xs break-words"
                        role="alert"
                        >{{ say(e) }}</span
                      >
                    }
                  </div>
                  <div class="flex shrink-0 items-center gap-2">
                    @if (!sandbox.on()) {
                      <input
                        #file
                        type="file"
                        class="sr-only"
                        tabindex="-1"
                        accept="image/png,image/webp"
                        [attr.data-upload]="field"
                        [attr.aria-labelledby]="field + '-label'"
                        (change)="pick(field, file)"
                      />
                      <button
                        z-button
                        zType="outline"
                        zSize="sm"
                        type="button"
                        [zLoading]="busy() === field"
                        (click)="file.click()"
                      >
                        <ng-icon name="lucideImageUp" aria-hidden="true" />
                        {{
                          (fields()[field]
                            ? 'editor.admin.branding.images.replace'
                            : 'editor.admin.branding.images.upload'
                          ) | transloco
                        }}
                      </button>
                    }
                    @if (fields()[field]) {
                      <button
                        z-button
                        zType="ghost"
                        zSize="sm"
                        type="button"
                        [attr.aria-label]="removeLabel(field)"
                        (click)="clear(field)"
                      >
                        <ng-icon name="lucideTrash2" aria-hidden="true" />
                        {{ 'editor.admin.branding.images.remove' | transloco }}
                      </button>
                    }
                  </div>
                </li>
              }
            </ul>
          </section>

          <section
            class="bg-card flex min-w-0 flex-col gap-3 rounded-xl border p-4"
            aria-labelledby="branding-colours-heading"
          >
            <div class="flex min-w-0 flex-col gap-1">
              <h2
                id="branding-colours-heading"
                class="m-0 text-base font-semibold"
              >
                {{ 'editor.admin.branding.colours.title' | transloco }}
              </h2>
              <p class="text-muted-foreground m-0 text-xs break-words">
                {{ 'editor.admin.branding.colours.hint' | transloco }}
              </p>
            </div>
            @for (field of colourFields; track field) {
              <div
                class="flex min-w-0 flex-col gap-2 border-t pt-3 first-of-type:border-t-0 first-of-type:pt-0"
                [attr.data-field]="field"
              >
                <div class="flex min-w-0 flex-wrap items-end gap-3">
                  <div class="flex min-w-0 flex-col gap-1.5">
                    <label class="text-sm" [for]="'branding-' + field">{{
                      colourKeys[field].label | transloco
                    }}</label>
                    <div class="flex items-center gap-2">
                      <input
                        type="color"
                        class="border-input h-9 w-11 shrink-0 cursor-pointer rounded-md border bg-transparent p-1"
                        [attr.aria-label]="colourKeys[field].picker | transloco"
                        [value]="pickerValue(field)"
                        (input)="drag(field, $any($event.target).value)"
                        (change)="setColour(field, $any($event.target).value)"
                      />
                      <input
                        z-input
                        type="text"
                        class="w-32 font-mono"
                        spellcheck="false"
                        autocomplete="off"
                        maxlength="7"
                        [id]="'branding-' + field"
                        [placeholder]="
                          'editor.admin.branding.colours.default' | transloco
                        "
                        [value]="shownColour(field)"
                        [attr.aria-invalid]="errors()[field] ? 'true' : null"
                        [attr.aria-describedby]="'branding-' + field + '-hint'"
                        (change)="setColour(field, $any($event.target).value)"
                        (keydown.enter)="$any($event.target).blur()"
                      />
                    </div>
                  </div>
                  @if (fields()[field]) {
                    <button
                      z-button
                      zType="ghost"
                      zSize="sm"
                      type="button"
                      (click)="clear(field)"
                    >
                      {{
                        'editor.admin.branding.colours.useDefault' | transloco
                      }}
                    </button>
                  }
                </div>
                <p
                  class="text-muted-foreground m-0 text-xs break-words"
                  [id]="'branding-' + field + '-hint'"
                >
                  {{ colourKeys[field].hint | transloco }}
                </p>
                @if (errors()[field]; as e) {
                  <p
                    class="text-destructive m-0 text-xs break-words"
                    role="alert"
                  >
                    {{ say(e) }}
                  </p>
                }
                @if (checksOf(field).length > 0) {
                  <ul
                    class="m-0 grid list-none gap-x-4 gap-y-1 p-0 text-xs sm:grid-cols-2"
                    [attr.aria-label]="
                      'editor.admin.branding.colours.checks' | transloco
                    "
                  >
                    @for (
                      check of checksOf(field);
                      track check.theme + check.pair
                    ) {
                      <li class="flex min-w-0 justify-between gap-2">
                        <span
                          class="text-muted-foreground min-w-0 break-words"
                          >{{ checkText(check) }}</span
                        >
                        <span class="shrink-0 tabular-nums">{{
                          'editor.admin.branding.colours.ratio'
                            | transloco
                              : { ratio: check.ratio, required: check.required }
                        }}</span>
                      </li>
                    }
                  </ul>
                }
              </div>
            }
          </section>

          <div
            class="flex min-w-0 flex-wrap items-center justify-between gap-3"
          >
            <p
              class="text-muted-foreground m-0 text-xs break-words"
              role="status"
            >
              @if (busy()) {
                {{ 'editor.admin.branding.saving' | transloco }}
              } @else {
                {{ 'editor.admin.note' | transloco }}
              }
            </p>
            <button
              z-button
              zType="outline"
              type="button"
              [zDisabled]="isDefault()"
              (click)="confirmReset()"
            >
              <ng-icon name="lucideRotateCcw" aria-hidden="true" />
              {{ 'editor.admin.branding.reset.action' | transloco }}
            </button>
          </div>
        </div>

        <section
          class="bg-card flex min-w-0 flex-col gap-3 rounded-xl border p-4 xl:sticky xl:top-4"
          aria-labelledby="branding-preview-heading"
          data-slot="branding-preview"
        >
          <h2 id="branding-preview-heading" class="m-0 text-base font-semibold">
            {{ 'editor.admin.branding.preview.title' | transloco }}
          </h2>
          <div
            class="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2"
          >
            @for (theme of themes; track theme) {
              <div
                [class]="
                  theme +
                  ' bg-background text-foreground flex min-w-0 overflow-hidden rounded-lg border'
                "
                [attr.data-theme]="theme"
                role="group"
                [attr.aria-label]="themeKeys[theme] | transloco"
              >
                <div
                  class="bg-sidebar text-sidebar-foreground border-sidebar-border flex w-28 shrink-0 flex-col gap-2 border-r p-2"
                >
                  <div class="flex h-7 min-w-0 items-center gap-1.5">
                    @if (previewLogo(theme); as logo) {
                      <img
                        [src]="logo"
                        [alt]="productName()"
                        class="h-full max-w-full object-contain object-left"
                      />
                    } @else {
                      <img
                        [src]="previewMark(theme)"
                        alt=""
                        class="h-6 w-6 shrink-0"
                      />
                      <span class="min-w-0 truncate text-xs font-semibold">{{
                        productName()
                      }}</span>
                    }
                  </div>
                  <span
                    class="bg-sidebar-accent text-sidebar-accent-foreground flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs font-medium"
                  >
                    <span
                      class="bg-sidebar-primary size-2.5 shrink-0 rounded-sm"
                    ></span>
                    {{ 'editor.admin.branding.preview.selected' | transloco }}
                  </span>
                  <span class="flex items-center gap-1.5 px-1.5 py-1 text-xs">
                    <span
                      class="bg-muted-foreground/40 size-2.5 shrink-0 rounded-sm"
                    ></span>
                    {{ 'editor.admin.branding.preview.item' | transloco }}
                  </span>
                </div>
                <div class="flex min-w-0 flex-1 flex-col gap-2 p-3">
                  <div
                    class="bg-card text-card-foreground flex flex-col gap-1.5 rounded-md border p-2"
                  >
                    <span class="text-xs font-semibold">{{
                      'editor.admin.branding.preview.card' | transloco
                    }}</span>
                    <span class="text-muted-foreground text-xs break-words">{{
                      'editor.admin.branding.preview.text' | transloco
                    }}</span>
                    <span class="text-primary text-xs underline">{{
                      'editor.admin.branding.preview.link' | transloco
                    }}</span>
                  </div>
                  <span
                    class="bg-primary text-primary-foreground ring-ring/50 inline-flex w-fit items-center rounded-md px-2.5 py-1 text-xs font-medium ring-2"
                  >
                    {{ 'editor.admin.branding.preview.button' | transloco }}
                  </span>
                  <span
                    class="bg-accent text-accent-foreground rounded-md px-2 py-1 text-xs"
                    >{{
                      'editor.admin.branding.preview.hover' | transloco
                    }}</span
                  >
                </div>
              </div>
            }
          </div>
          <p class="text-muted-foreground m-0 text-xs break-words">
            {{ 'editor.admin.branding.preview.hint' | transloco }}
          </p>
        </section>
      </div>
    }
  `,
})
export class BrandingPage {
  protected readonly sandbox = inject(SandboxSession);
  private readonly api = inject(ApiClient);
  private readonly base = inject(API_BASE_URL);
  private readonly service = inject(BrandingService);
  private readonly toast = inject(ToastService);
  private readonly dialogs = inject(ZardAlertDialogService);
  private readonly t = injectTranslate();

  protected readonly imageFields = IMAGE_FIELDS;
  protected readonly colourFields = COLOUR_FIELDS;
  protected readonly imageKeys = IMAGE_KEYS;
  protected readonly colourKeys = COLOUR_KEYS;
  protected readonly themeKeys = THEME_KEYS;
  protected readonly themes = ['light', 'dark'] as const;

  /** The branding as the API last confirmed it: what a refusal puts back. */
  protected readonly saved = signal<BrandingResource | null>(null);
  /** What the screen shows: the saved branding with the change under way laid over it. */
  protected readonly fields = signal<BrandingFields>(RESET);
  private readonly loadFailure = signal<ApiError | null>(null);
  /** The field being saved or uploaded (`'all'` for a reset). */
  protected readonly busy = signal<keyof BrandingFields | 'all' | null>(null);
  /** The last refusal, by field. */
  protected readonly errors = signal<
    Partial<Record<keyof BrandingFields, TranslatedText>>
  >({});
  /** A colour being dragged in the picker, before it is let go. */
  protected readonly typing = signal<{
    field: ColourField;
    value: string;
  } | null>(null);
  /** Local previews of images being uploaded, by field. */
  private readonly pending = signal<Partial<Record<ImageField, string>>>({});
  /** Changes are sent one after the other, in order. */
  private queue: Promise<unknown> = Promise.resolve();

  protected readonly defaultName = this.service.defaultProductName;
  protected readonly productName = this.service.productName;
  protected readonly isDefault = computed(
    () => Object.keys(changedFields(RESET, this.fields())).length === 0,
  );
  protected readonly loadError = computed(() => {
    const failure = this.loadFailure();
    if (!failure) return null;
    const text = apiErrorText(failure);
    return { kind: failure.kind, message: this.t(text.key, text.params) };
  });

  constructor() {
    void this.load();
    inject(DestroyRef).onDestroy(() => {
      for (const url of Object.values(this.pending())) {
        if (url) URL.revokeObjectURL(url);
      }
    });
  }

  /** Reads `GET /branding` afresh (another admin may have changed it). */
  async load(): Promise<void> {
    this.loadFailure.set(null);
    try {
      const document = await firstValueFrom(this.api.get('/branding'));
      this.confirm(document.data);
    } catch (error) {
      this.loadFailure.set(toApiError(error));
    }
  }

  /** A translated text whose `pair` parameter is itself a key. */
  protected say(text: TranslatedText): string {
    const params = { ...(text.params ?? {}) };
    if (typeof params['pair'] === 'string')
      params['pair'] = this.t(params['pair']);
    return this.t(text.key, params);
  }

  protected checkText(check: { theme: string; pair: string }): string {
    return this.t('editor.admin.branding.colours.check', {
      theme: this.t(THEME_KEYS[check.theme === 'dark' ? 'dark' : 'light']),
      pair: this.t(
        PAIR_TEXTS[check.pair] ?? 'editor.admin.branding.pairs.other',
      ),
    });
  }

  protected checksOf(field: ColourField) {
    const checks = this.saved()?.meta.contrast ?? [];
    return checks.filter((c) => c.colour === field);
  }

  protected shownImage(field: ImageField): string | null {
    return this.pending()[field] ?? imageUrl(this.base, this.fields()[field]);
  }

  protected shownColour(field: ColourField): string {
    const typing = this.typing();
    return typing?.field === field
      ? typing.value
      : (this.fields()[field] ?? '');
  }

  /** The picker's value: the colour, else what the theme shows by default (read from the page). */
  protected pickerValue(field: ColourField): string {
    const shown = this.shownColour(field);
    if (shown) return shown;
    return this.service.tokenNow(field === 'primary' ? 'primary' : 'sidebar');
  }

  protected previewLogo(theme: 'light' | 'dark'): string | null {
    const f = this.fields();
    const light = this.pending().logoLight ?? imageUrl(this.base, f.logoLight);
    const dark = this.pending().logoDark ?? imageUrl(this.base, f.logoDark);
    if (theme === 'dark') return dark ?? light ?? this.defaultLogo('dark');
    return light ?? dark ?? this.defaultLogo('light');
  }

  protected previewMark(theme: 'light' | 'dark'): string {
    const logo = this.service.branding().logo;
    return (
      this.pending().mark ??
      (theme === 'dark' ? (logo.smallDark ?? logo.small) : logo.small)
    );
  }

  private defaultLogo(theme: 'light' | 'dark'): string | null {
    const f = this.fields();
    if (f.logoLight || f.logoDark || f.mark) return null;
    const logo = this.service.branding().logo;
    return theme === 'dark'
      ? (logo.fullDark ?? logo.full ?? null)
      : (logo.full ?? null);
  }

  protected removeLabel(field: ImageField): string {
    return this.t('editor.admin.branding.images.removeOne', {
      name: this.t(IMAGE_KEYS[field].label),
    });
  }

  protected clear(field: keyof BrandingFields): void {
    this.change({ [field]: null });
  }

  protected drag(field: ColourField, value: string): void {
    this.typing.set({ field, value });
  }

  protected setName(value: string): void {
    const name = value.trim();
    this.change({ productName: name === '' ? null : name });
  }

  protected setColour(field: ColourField, value: string): void {
    this.typing.set(null);
    if (value.trim() === '') {
      this.change({ [field]: null });
      return;
    }
    const hex = normalHex(value);
    if (hex === null) {
      this.errors.update((e) => ({
        ...e,
        [field]: { key: 'editor.admin.branding.errors.notAColour' },
      }));
      return;
    }
    this.change({ [field]: hex });
  }

  /** An image chosen for `field`: checked, shown at once, uploaded, then named. */
  protected pick(field: ImageField, input: HTMLInputElement): void {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (!IMAGE_TYPES.includes(file.type)) {
      this.refuseImage(field, 'editor.admin.branding.errors.imageType');
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      this.refuseImage(field, 'editor.admin.branding.errors.tooLarge', {
        max: MAX_IMAGE_BYTES,
      });
      return;
    }
    const local = URL.createObjectURL(file);
    this.pending.update((p) => ({ ...p, [field]: local }));
    this.errors.update((e) => ({ ...e, [field]: undefined }));
    this.enqueue(field, async () => {
      try {
        const uploaded = await firstValueFrom(
          this.api.uploadBrandingImage(file),
        );
        if (
          SQUARE_FIELDS.has(field) &&
          uploaded.data.attributes.width !== uploaded.data.attributes.height
        ) {
          // Said here as the API would, without a request it refuses anyway.
          this.refuseImage(field, 'editor.admin.branding.errors.notSquare', {
            width: uploaded.data.attributes.width,
            height: uploaded.data.attributes.height,
          });
          return;
        }
        await this.send({ [field]: uploaded.data.attributes.reference });
      } catch (error) {
        this.refused(toApiError(error), field);
      } finally {
        this.pending.update((p) => ({ ...p, [field]: undefined }));
        URL.revokeObjectURL(local);
      }
    });
  }

  /** Sends `changes` at once, showing them before the API answers. */
  change(changes: Partial<BrandingFields>): void {
    const field = Object.keys(changes)[0] as keyof BrandingFields | undefined;
    this.errors.update((e) => {
      const next = { ...e };
      for (const key of Object.keys(changes) as (keyof BrandingFields)[]) {
        delete next[key];
      }
      return next;
    });
    this.enqueue(field ?? 'all', async () => {
      try {
        await this.send(changes);
      } catch (error) {
        this.refused(toApiError(error));
      }
    });
  }

  protected confirmReset(): void {
    this.dialogs.confirm({
      zTitle: this.t('editor.admin.branding.reset.title'),
      zDescription: this.t('editor.admin.branding.reset.description'),
      zOkText: this.t('editor.admin.branding.reset.confirm'),
      zCancelText: this.t('editor.admin.cancel'),
      zOkDestructive: true,
      zOnOk: () => {
        this.errors.set({});
        this.enqueue('all', async () => {
          try {
            await this.send(RESET);
            this.toast.success({ key: 'editor.admin.branding.reset.done' });
          } catch (error) {
            this.refused(toApiError(error));
          }
        });
      },
    });
  }

  private enqueue(
    field: keyof BrandingFields | 'all',
    work: () => Promise<void>,
  ): void {
    this.queue = this.queue.then(async () => {
      this.busy.set(field);
      try {
        await work();
      } finally {
        this.busy.set(null);
      }
    });
  }

  /** Shows `changes` at once (here and in the whole editor), then sends what differs. */
  private async send(changes: Partial<BrandingFields>): Promise<void> {
    const saved = this.saved();
    if (!saved) return;
    const next = { ...this.fields(), ...changes };
    const differs = changedFields(fieldsOf(saved.attributes), next);
    this.fields.set(next);
    this.service.preview(next);
    if (Object.keys(differs).length === 0) return;
    const document = await firstValueFrom(
      this.api.patch(
        '/branding',
        { path: {} as never },
        { data: { type: 'Branding', id: 'branding', attributes: differs } },
      ),
    );
    this.confirm(document.data);
  }

  /** The API's answer: saved, shown everywhere. */
  private confirm(branding: BrandingResource): void {
    this.saved.set(branding);
    this.fields.set(fieldsOf(branding.attributes));
    this.service.show(branding);
  }

  /**
   * A refusal: what is saved shown again, the reasons under their fields, and a toast. An upload's
   * refusal names no field (`source.pointer`), so it goes under the image's own (`field`).
   */
  private refused(error: ApiError, field?: ImageField): void {
    const saved = this.saved();
    if (saved) this.confirm(saved);
    const byField = fieldErrors(error);
    if (field && !byField[field]) byField[field] = brandingErrorText(error);
    this.errors.update((e) => ({ ...e, ...byField }));
    this.toast.error(this.say(brandingErrorText(error)));
  }

  private refuseImage(
    field: ImageField,
    key: string,
    params?: Record<string, unknown>,
  ): void {
    const text: TranslatedText = { key, ...(params && { params }) };
    this.errors.update((e) => ({ ...e, [field]: text }));
    this.toast.error(text);
  }
}
