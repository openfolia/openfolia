import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCircleAlert, lucideImage, lucideTrash2 } from '@ng-icons/lucide';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { injectTranslate, LanguageService } from '@openfolia/ui/i18n';
import { ZardInputComponent } from '@openfolia/ui/input';

import { CHECK_TITLES, type CheckCode } from '../checks/checks-model';
import { languageName, type ProjectConfig } from '../content/browser-model';
import { ImageSources } from '../images/image-sources';
import { ImageThumbComponent } from '../images/image-thumb.component';
import { InsertImageDialogComponent } from '../images/insert-image-dialog.component';
import { ManualDraft } from './manual-draft';
import {
  altIn,
  coverOf,
  issuesFor,
  withAlt,
  withCover,
  unshownCovers,
  withoutCoverAt,
  type CoverImage,
  type CoverTarget,
  type Issue,
} from './manual-settings';
import { variantLabel, type VariantValues } from './manual-variants';

const FROM_MANUAL = 'editor.manuals.settings.cover.fromManual';
const FROM_DESIGN = 'editor.manuals.settings.cover.fromDesign';

/** One row of the list: the manual's image, or a variant's. */
interface CoverRow {
  readonly key: string;
  readonly target: CoverTarget;
  readonly label: string;
  /** Its own image, if it has one. */
  readonly image: CoverImage | undefined;
  /** What it shows without one (a key): the manual's image, or the design's. */
  readonly fallback: string;
}

/** An image chosen for a row without one, waiting for its alternative text. */
interface Pending {
  readonly key: string;
  readonly target: CoverTarget;
  readonly asset: string;
}

/**
 * The manual's cover image in its settings (#394): the manual's own and, with more than one
 * variant, each variant's own, which replaces the manual's. An image comes from the media library
 * or an upload into the change set (the image dialog); its alternative text is required in the
 * source language (one chosen without it waits for it before it is saved) and translatable, one
 * field per language. Every change is saved at once through the builder's working copy. Read-only,
 * it shows the images and their texts.
 */
@Component({
  selector: 'of-cover-image-settings',
  imports: [
    TranslocoPipe,
    NgIcon,
    ZardButtonComponent,
    ZardInputComponent,
    ImageThumbComponent,
    InsertImageDialogComponent,
  ],
  // The thumbnails and the image dialog read images through these sources.
  providers: [ImageSources],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({ lucideCircleAlert, lucideImage, lucideTrash2 }),
  ],
  host: {
    class: 'flex flex-col gap-2',
    'data-testid': 'settings-cover',
    role: 'group',
    '[attr.aria-labelledby]': '"settings-cover-heading"',
  },
  template: `
    <h3 id="settings-cover-heading" class="m-0 text-sm font-medium">
      {{ 'editor.manuals.settings.cover.heading' | transloco }}
    </h3>
    <p class="m-0 text-xs text-muted-foreground">
      {{ 'editor.manuals.settings.cover.hint' | transloco }}
    </p>
    <ul
      class="m-0 flex list-none flex-col divide-y divide-border rounded-lg border border-border p-0"
    >
      @for (row of rows(); track row.key) {
        @let waiting = pending()?.key === row.key ? pending() : null;
        <li
          class="flex min-w-0 flex-col gap-2 px-3 py-2"
          [attr.data-cover]="row.key"
        >
          <div class="flex min-w-0 flex-wrap items-center gap-3">
            <div class="w-20 shrink-0">
              @if (waiting?.asset ?? row.image?.asset; as asset) {
                <of-image-thumb [asset]="asset" [changeSetId]="changeSetId()" />
              } @else {
                <div
                  class="flex aspect-[8/5] items-center justify-center rounded-md border border-dashed border-border text-muted-foreground"
                >
                  <ng-icon name="lucideImage" size="18" aria-hidden="true" />
                </div>
              }
            </div>
            <div class="flex min-w-0 flex-1 basis-32 flex-col gap-0.5">
              <span class="text-sm break-words">{{ row.label }}</span>
              <span
                class="text-xs break-words text-muted-foreground"
                data-testid="cover-status"
                >{{
                  (row.image
                    ? 'editor.manuals.settings.cover.own'
                    : row.fallback
                  ) | transloco
                }}</span
              >
            </div>
            @if (editable()) {
              <div class="flex shrink-0 flex-wrap items-center gap-1">
                <button
                  z-button
                  zType="outline"
                  zSize="sm"
                  type="button"
                  data-testid="cover-choose"
                  [attr.aria-label]="
                    (row.image
                      ? 'editor.manuals.settings.cover.changeFor'
                      : 'editor.manuals.settings.cover.chooseFor'
                    ) | transloco: { target: row.label }
                  "
                  (click)="choose(row)"
                >
                  {{
                    (row.image
                      ? 'editor.manuals.settings.cover.change'
                      : 'editor.manuals.settings.cover.choose'
                    ) | transloco
                  }}
                </button>
                @if (row.image) {
                  <button
                    z-button
                    zType="ghost"
                    zSize="icon-sm"
                    type="button"
                    data-testid="cover-remove"
                    [attr.aria-label]="
                      'editor.manuals.settings.cover.removeFor'
                        | transloco: { target: row.label }
                    "
                    (click)="remove(row)"
                  >
                    <ng-icon name="lucideTrash2" aria-hidden="true" />
                  </button>
                }
              </div>
            }
          </div>

          @if (waiting) {
            <form
              class="flex flex-col gap-1.5"
              data-testid="cover-pending"
              (submit)="usePending($event)"
            >
              <label
                class="text-xs font-medium"
                [attr.for]="'cover-alt-new-' + row.key"
                >{{
                  'editor.manuals.settings.cover.alt'
                    | transloco: { language: languageLabel(source()) }
                }}</label
              >
              <input
                z-input
                maxlength="500"
                data-testid="cover-alt-new"
                [attr.lang]="source()"
                dir="auto"
                [id]="'cover-alt-new-' + row.key"
                [attr.aria-describedby]="'cover-alt-new-hint-' + row.key"
                [value]="pendingAlt()"
                (input)="pendingAlt.set($any($event.target).value)"
                (keydown.escape)="cancelPending($event)"
              />
              <p
                class="m-0 text-xs text-muted-foreground"
                [id]="'cover-alt-new-hint-' + row.key"
              >
                {{
                  'editor.manuals.settings.cover.altRequired'
                    | transloco: { language: languageLabel(source()) }
                }}
              </p>
              <div class="flex flex-wrap gap-2">
                <button
                  z-button
                  zSize="sm"
                  type="submit"
                  data-testid="cover-use"
                  [zDisabled]="pendingAlt().trim() === ''"
                >
                  {{ 'editor.manuals.settings.cover.save' | transloco }}
                </button>
                <button
                  z-button
                  zType="ghost"
                  zSize="sm"
                  type="button"
                  (click)="cancelPending($event)"
                >
                  {{ 'editor.manuals.settings.cover.cancel' | transloco }}
                </button>
              </div>
            </form>
          } @else if (row.image; as image) {
            @if (editable()) {
              <div class="flex flex-col gap-1.5">
                @for (field of fields(); track field.key) {
                  @let lang = field.lang;
                  <label
                    class="text-xs text-muted-foreground"
                    [attr.for]="'cover-alt-' + row.key + '-' + lang"
                    >{{
                      'editor.manuals.settings.cover.alt'
                        | transloco: { language: languageLabel(lang) }
                    }}</label
                  >
                  <input
                    z-input
                    maxlength="500"
                    [attr.data-alt]="lang"
                    [attr.lang]="lang"
                    dir="auto"
                    [id]="'cover-alt-' + row.key + '-' + lang"
                    [attr.aria-invalid]="
                      altError() === row.key && lang === source() ? true : null
                    "
                    [value]="altIn(image.alt, lang)"
                    (change)="commitAlt(row, lang, $event)"
                  />
                }
                @if (altError() === row.key) {
                  <p
                    class="m-0 flex items-start gap-1.5 text-xs break-words text-destructive"
                    data-testid="cover-alt-error"
                  >
                    <ng-icon
                      name="lucideCircleAlert"
                      class="mt-px shrink-0"
                      aria-hidden="true"
                    />
                    {{
                      'editor.manuals.settings.cover.altRequired'
                        | transloco: { language: languageLabel(source()) }
                    }}
                  </p>
                } @else {
                  <p class="m-0 text-xs text-muted-foreground">
                    {{
                      'editor.manuals.settings.cover.altHint'
                        | transloco: { language: languageLabel(source()) }
                    }}
                  </p>
                }
              </div>
            } @else {
              <ul class="m-0 flex list-none flex-col gap-0.5 p-0 text-xs">
                @for (lang of languages(); track lang) {
                  @if (altIn(image.alt, lang); as text) {
                    <li class="break-words" [attr.data-alt]="lang" dir="auto">
                      {{
                        'editor.manuals.settings.cover.readAlt'
                          | transloco
                            : { language: languageLabel(lang), text: text }
                      }}
                    </li>
                  }
                }
              </ul>
            }
          }
        </li>
      }
    </ul>
    @if (unshown().length > 0) {
      <ul
        class="m-0 flex list-none flex-col gap-1 p-0"
        data-testid="cover-unshown"
      >
        @for (u of unshown(); track u.index) {
          <li class="flex min-w-0 items-start gap-2 text-xs text-warning">
            <ng-icon
              name="lucideCircleAlert"
              class="mt-px shrink-0"
              aria-hidden="true"
            />
            <span class="min-w-0 flex-1 break-words">{{
              'editor.manuals.settings.cover.unshown'
                | transloco: { target: u.label }
            }}</span>
            @if (editable()) {
              <button
                z-button
                zType="ghost"
                zSize="icon-sm"
                type="button"
                data-testid="cover-unshown-remove"
                [attr.aria-label]="
                  'editor.manuals.settings.cover.removeFor'
                    | transloco: { target: u.label }
                "
                (click)="removeUnshown(u.index)"
              >
                <ng-icon name="lucideTrash2" aria-hidden="true" />
              </button>
            }
          </li>
        }
      </ul>
    }
    @for (issue of issues(); track $index) {
      <p
        class="m-0 flex items-start gap-1.5 text-xs break-words"
        [class.text-destructive]="issue.severity === 'error'"
        [class.text-warning]="issue.severity !== 'error'"
        data-testid="settings-issue"
      >
        <ng-icon
          name="lucideCircleAlert"
          class="mt-px shrink-0"
          aria-hidden="true"
        />
        <span>
          <span class="sr-only">{{
            (issue.severity === 'error'
              ? 'editor.manuals.settings.issueError'
              : 'editor.manuals.settings.issueWarning'
            ) | transloco
          }}</span>
          {{ issueText(issue) }}
        </span>
      </p>
    }
    @if (editable()) {
      <of-insert-image-dialog [changeSetId]="changeSetId()" [pickOnly]="true" />
    }
  `,
})
export class CoverImageSettingsComponent {
  private readonly draft = inject(ManualDraft);
  private readonly language = inject(LanguageService);
  private readonly t = injectTranslate();
  private readonly dialog = viewChild(InsertImageDialogComponent);

  readonly config = input.required<ProjectConfig>();
  /** Changeable now (the settings panel's judgement). */
  readonly editable = input(false);
  /** The draft change set: uploads go there, and its uploads can be previewed. */
  readonly changeSetId = input<string | null>(null);

  protected readonly pending = signal<Pending | null>(null);
  protected readonly pendingAlt = signal('');
  /** The row whose source-language text was emptied (refused). */
  protected readonly altError = signal<string | null>(null);
  protected readonly altIn = altIn;
  /** Bumps when a refused text is put back: the fields are drawn again from the settings. */
  private readonly resets = signal(0);

  private readonly covers = computed(() => this.draft.settings()?.coverImage);
  private readonly manualId = computed(() => this.draft.manual()?.id);
  private readonly variants = computed(
    () => this.draft.settings()?.variants ?? [],
  );

  constructor() {
    // Another manual, change set or reload: an image waiting for its text belongs to the old one.
    effect(() => {
      // The manual (by its ID: its header is renewed by every save).
      this.manualId();
      // The rows are the variants by place: one waiting must not land on another's.
      this.variants();
      untracked(() => {
        this.pending.set(null);
        this.altError.set(null);
      });
    });
  }

  protected readonly source = computed(() => this.config().languages.source);
  /** The source language first, then the targets. */
  protected readonly languages = computed(() => [
    this.config().languages.source,
    ...this.config().languages.targets.filter(
      (l) => l !== this.config().languages.source,
    ),
  ]);

  /**
   * The languages of the text fields. A new list after a refused text, so the fields are drawn
   * again with the saved text (a field keeps what was typed otherwise).
   */
  protected readonly fields = computed(() => {
    const n = this.resets();
    return this.languages().map((lang) => ({ lang, key: `${lang}:${n}` }));
  });

  protected readonly rows = computed((): CoverRow[] => {
    const covers = this.covers();
    const manual = coverOf(covers, 'manual');
    const rows: CoverRow[] = [
      {
        key: 'manual',
        target: 'manual',
        label: this.t('editor.manuals.settings.cover.manual'),
        image: manual,
        fallback: FROM_DESIGN,
      },
    ];
    const variants = this.variants();
    // A variant's own image only means something beside another variant.
    if (variants.length > 1 || (covers?.variants.length ?? 0) > 0) {
      variants.forEach((values, i) =>
        rows.push({
          key: `variant-${i}`,
          target: values,
          label: this.variantName(values),
          image: coverOf(covers, values),
          fallback: manual ? FROM_MANUAL : FROM_DESIGN,
        }),
      );
    }
    return rows;
  });

  /** The variants' own images that are never shown, to be taken away. */
  protected readonly unshown = computed(() => {
    const covers = this.covers();
    return unshownCovers(covers, this.variants()).map((index) => ({
      index,
      label: this.variantName(covers?.variants[index]?.variant ?? {}),
    }));
  });

  // An image never shown is listed above, with its remove button: not again here.
  protected readonly issues = computed(() =>
    issuesFor(this.draft.issues(), { kind: 'cover' }).filter(
      (issue) => issue.code !== 'unknown-cover-variant',
    ),
  );

  protected issueText(issue: Issue): string {
    const key = CHECK_TITLES[issue.code as CheckCode] as string | undefined;
    return key ? `${this.t(key)}: ${issue.message}` : issue.message;
  }

  protected languageLabel(lang: string): string {
    return languageName(this.language.locale(), lang);
  }

  private variantName(values: VariantValues): string {
    return (
      variantLabel(values, this.config()) ||
      this.t('editor.manuals.settings.variants.nothingSet')
    );
  }

  /** Picks an image: a row with one keeps its texts; one without waits for its text. */
  protected async choose(row: CoverRow): Promise<void> {
    const dialog = this.dialog();
    if (!dialog || !this.editable()) return;
    const scope = this.draft.scope();
    const current = row.image?.asset;
    const choice = await dialog.open(
      current ? { asset: current, alt: '', caption: '', width: null } : null,
    );
    if (!choice || this.draft.scope() !== scope || !this.editable()) return;
    const image = coverOf(this.covers(), row.target);
    if (image) {
      if (image.asset === choice.asset) return;
      this.save(row.target, { asset: choice.asset, alt: image.alt });
      return;
    }
    this.altError.set(null);
    this.pendingAlt.set('');
    this.pending.set({ key: row.key, target: row.target, asset: choice.asset });
  }

  protected usePending(event: Event): void {
    event.preventDefault();
    const waiting = this.pending();
    const text = this.pendingAlt().trim().replace(/\s+/g, ' ');
    if (!waiting || text === '' || !this.editable()) return;
    this.pending.set(null);
    this.save(waiting.target, {
      asset: waiting.asset,
      alt: { [this.source()]: text },
    });
  }

  protected cancelPending(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.pending.set(null);
  }

  protected remove(row: CoverRow): void {
    if (!this.editable()) return;
    if (this.altError() === row.key) this.altError.set(null);
    this.draft.changeSettings({
      coverImage: withCover(this.covers(), row.target, undefined),
    });
  }

  protected removeUnshown(index: number): void {
    if (!this.editable()) return;
    this.draft.changeSettings({
      coverImage: withoutCoverAt(this.covers(), index),
    });
  }

  /** A language's text, saved when it changes; the source language's may not be emptied. */
  protected commitAlt(row: CoverRow, lang: string, event: Event): void {
    const field = event.target as HTMLInputElement;
    const image = coverOf(this.covers(), row.target);
    if (!image || !this.editable()) return;
    const text = field.value.trim();
    if (lang === this.source() && text === '') {
      // The field is drawn again with the saved text.
      this.resets.update((n) => n + 1);
      this.altError.set(row.key);
      return;
    }
    if (this.altError() === row.key) this.altError.set(null);
    const alt = withAlt(image.alt, lang, text, this.source());
    if (!alt || JSON.stringify(alt) === JSON.stringify(image.alt)) {
      // Nothing changed (a target cleared falls back to the one text): drawn again as saved.
      this.resets.update((n) => n + 1);
      return;
    }
    this.save(row.target, { asset: image.asset, alt });
  }

  private save(target: CoverTarget, image: CoverImage): void {
    this.draft.changeSettings({
      coverImage: withCover(this.covers(), target, image),
    });
  }
}
