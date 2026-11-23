import { NgTemplateOutlet } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowLeft,
  lucideFileCode,
  lucideImage,
  lucideInfo,
  lucideLock,
  lucideTrash2,
  lucideTriangleAlert,
  lucideUndo2,
} from '@ng-icons/lucide';
import { firstValueFrom, map } from 'rxjs';

import {
  BACK_PAGE_POSITIONS,
  HEADING_NUMBERINGS,
  NOTE_STYLES,
  PAGE_SIZES,
  SAFETY_STANDARDS,
  STEP_MARKERS,
  TABLE_BORDERS,
  TYPE_SCALE_STEPS,
  type BackPagePosition,
  type LocalizedText,
  type PageDesignPreset,
  type PageSize,
} from '@openfolia/content-model/core';
import { ZardButtonComponent } from '@openfolia/ui/button';
import { CollapseComponent } from '@openfolia/ui/collapse';
import {
  injectTranslate,
  LanguageService,
  translated,
} from '@openfolia/ui/i18n';
import { ZardInputComponent } from '@openfolia/ui/input';
import { ZardSelectImports } from '@openfolia/ui/select';
import {
  SegmentedComponent,
  type SegmentedOption,
} from '@openfolia/ui/segmented';
import { ZardSkeletonComponent } from '@openfolia/ui/skeleton';
import { FadeInDirective } from '@openfolia/ui/smooth';
import {
  SortableRowDirective,
  SortableListComponent,
} from '@openfolia/ui/sortable-list';
import { ErrorStateComponent, SaveStatusComponent } from '@openfolia/ui/states';
import { ZardSwitchComponent } from '@openfolia/ui/switch';
import { ToastService } from '@openfolia/ui/toast';

import { API_BASE_URL, ApiClient, pageQuery, toApiError } from '../../api';
import { BrandingService } from '../../branding/branding.service';
import { languageName, type StoredConfig } from '../../content/browser-model';
import { apiErrorText, labelsInUi, UiTextPipe, UiTexts } from '../../i18n';
import { ImageSources } from '../../images/image-sources';
import { ImageThumbComponent } from '../../images/image-thumb.component';
import { InsertImageDialogComponent } from '../../images/insert-image-dialog.component';
import { ChangeSetSession } from '../../session/change-set-session';
import { ChangeSetUrl } from '../../session/change-set-url';
import { DesignDraft, type DesignChangeSet } from './design-draft';
import { DesignFontsComponent } from './design-fonts.component';
import {
  COLOUR_ROLES,
  contrastOnWhite,
  copyrightIn,
  FIELD_LABELS,
  fieldRows,
  FIXED_SETTINGS,
  issuesAt,
  levels,
  normalColour,
  otherIssues,
  presetShowsCover,
  SAFETY_SWATCHES,
  shownFields,
  withCopyright,
  withLevel,
  type ColourRole,
  type Copyright,
  type DesignIssue,
  type PageDesign,
  type RunningRegion,
} from './design-model';
import {
  DesignPreviewComponent,
  type DesignPreviewRequest,
} from './design-preview.component';
import { platformLogoFile, uploadLogo } from './platform-logo';
import { PresetPickerComponent } from './preset-picker.component';
import { RegionTextsComponent } from './region-texts.component';
import { asDesignRegions, type Regions } from './region-text';
import { RunningRegionComponent } from './running-region.component';
import { issueText } from './design-issues';

type Margin = keyof PageDesign['page']['margins'];
const MARGINS: readonly Margin[] = ['top', 'right', 'bottom', 'left'];
type LogoSlot = 'light' | 'dark';
type Numeric =
  | { readonly kind: 'margin'; readonly side: Margin }
  | {
      readonly kind: 'body';
      readonly key: 'fontSize' | 'lineHeight' | 'paragraphSpacing';
    };

/** The ranges of the numbers the screen takes, as the content model checks them. */
const RANGES = {
  margin: { min: 0, max: 100, step: 1 },
  fontSize: { min: 6, max: 24, step: 0.5 },
  lineHeight: { min: 1, max: 3, step: 0.05 },
  paragraphSpacing: { min: 0, max: 36, step: 1 },
} as const;

const COLOUR_LABELS: Readonly<Record<ColourRole, string>> = {
  primary: 'editor.admin.pageDesigns.colours.primary',
  accent: 'editor.admin.pageDesigns.colours.accent',
  text: 'editor.admin.pageDesigns.colours.text',
};
const COLOUR_HINTS: Readonly<Record<ColourRole, string>> = {
  primary: 'editor.admin.pageDesigns.colours.primaryHint',
  accent: 'editor.admin.pageDesigns.colours.accentHint',
  text: 'editor.admin.pageDesigns.colours.textHint',
};
const MARGIN_LABELS: Readonly<Record<Margin, string>> = {
  top: 'editor.admin.pageDesigns.page.margins.top',
  right: 'editor.admin.pageDesigns.page.margins.right',
  bottom: 'editor.admin.pageDesigns.page.margins.bottom',
  left: 'editor.admin.pageDesigns.page.margins.left',
};
const NUMBERING_LABELS: Readonly<Record<string, string>> = {
  decimal: 'editor.admin.pageDesigns.headings.numberings.decimal',
  none: 'editor.admin.pageDesigns.headings.numberings.none',
};
const SIZE_LABELS: Readonly<Record<string, string>> = {
  base: 'editor.admin.pageDesigns.headings.sizes.base',
  lg: 'editor.admin.pageDesigns.headings.sizes.lg',
  xl: 'editor.admin.pageDesigns.headings.sizes.xl',
  '2xl': 'editor.admin.pageDesigns.headings.sizes.2xl',
  '3xl': 'editor.admin.pageDesigns.headings.sizes.3xl',
};
const PAGE_SIZE_LABELS: Readonly<Record<PageSize, string>> = {
  a4: 'editor.admin.pageDesigns.page.sizes.a4',
  'us-letter': 'editor.admin.pageDesigns.page.sizes.usLetter',
  a5: 'editor.admin.pageDesigns.page.sizes.a5',
};
const ROLE_LABELS: Readonly<Record<string, string>> = {
  text: 'editor.admin.pageDesigns.colours.text',
  primary: 'editor.admin.pageDesigns.colours.primary',
  accent: 'editor.admin.pageDesigns.colours.accent',
};
const BORDER_LABELS: Readonly<Record<string, string>> = {
  none: 'editor.admin.pageDesigns.tables.borderOptions.none',
  horizontal: 'editor.admin.pageDesigns.tables.borderOptions.horizontal',
  grid: 'editor.admin.pageDesigns.tables.borderOptions.grid',
};
const MARKER_LABELS: Readonly<Record<string, string>> = {
  'filled-circle': 'editor.admin.pageDesigns.steps.markers.filledCircle',
  number: 'editor.admin.pageDesigns.steps.markers.number',
};
const NOTE_LABELS: Readonly<Record<string, string>> = {
  tinted: 'editor.admin.pageDesigns.steps.notes.tinted',
  framed: 'editor.admin.pageDesigns.steps.notes.framed',
};
const STANDARD_LABELS: Readonly<Record<string, string>> = {
  'ansi-z535': 'editor.admin.pageDesigns.safety.standards.ansi',
  'iso-3864': 'editor.admin.pageDesigns.safety.standards.iso',
};
const POSITION_LABELS: Readonly<Record<BackPagePosition, string>> = {
  last: 'editor.admin.pageDesigns.backPage.positions.last',
  'inside-cover': 'editor.admin.pageDesigns.backPage.positions.insideCover',
};
const POSITION_HINTS: Readonly<Record<BackPagePosition, string>> = {
  last: 'editor.admin.pageDesigns.backPage.positions.lastHint',
  'inside-cover': 'editor.admin.pageDesigns.backPage.positions.insideCoverHint',
};
const STANDARD_HINTS: Readonly<Record<string, string>> = {
  'ansi-z535': 'editor.admin.pageDesigns.safety.standards.ansiHint',
  'iso-3864': 'editor.admin.pageDesigns.safety.standards.isoHint',
};

/** A manual the preview can show, with its variants. */
interface PreviewManual {
  readonly id: string;
  /** One per language, perhaps (#731): shown in the interface language. */
  readonly title: LocalizedText;
  readonly variants: readonly {
    slug: string;
    label: string;
    values: Readonly<Record<string, string>>;
  }[];
}

/**
 * One page design (#392), Admin › Page design › a design: its settings on the left, grouped as
 * the PDF reads (layout, page, logo, colours, fonts, the title page's fields, the running header
 * and footer, headings, body, tables, steps and notes, safety notices), and the live preview of a
 * manual of the person's choosing on the right (`of-design-preview`). Every change is shown at
 * once and saved into the chosen change set's working copy (`DesignDraft`), with Undo; the preview
 * renders again shortly after each save. Problems the API finds show where they are, and what
 * the safety standards fix is listed, read-only, with why. Read-only, with the reason, wherever
 * the person cannot change it.
 */
@Component({
  selector: 'of-page-design-editor',
  imports: [
    UiTextPipe,
    NgTemplateOutlet,
    TranslocoPipe,
    NgIcon,
    RouterLink,
    ZardButtonComponent,
    ZardInputComponent,
    ZardSelectImports,
    ZardSkeletonComponent,
    ZardSwitchComponent,
    SegmentedComponent,
    CollapseComponent,
    SortableListComponent,
    SortableRowDirective,
    ErrorStateComponent,
    SaveStatusComponent,
    FadeInDirective,
    ImageThumbComponent,
    InsertImageDialogComponent,
    DesignPreviewComponent,
    DesignFontsComponent,
    PresetPickerComponent,
    RegionTextsComponent,
    RunningRegionComponent,
  ],
  // The logo's thumbnails and the image dialog read images through the page's sources.
  providers: [DesignDraft, ImageSources],
  viewProviders: [
    provideIcons({
      lucideArrowLeft,
      lucideFileCode,
      lucideImage,
      lucideInfo,
      lucideLock,
      lucideTrash2,
      lucideTriangleAlert,
      lucideUndo2,
    }),
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-w-0 flex-col gap-4' },
  template: `
    <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
      <a
        z-button
        zType="ghost"
        zSize="sm"
        routerLink=".."
        [queryParams]="linkQuery()"
        data-slot="designs-back"
      >
        <ng-icon
          name="lucideArrowLeft"
          data-icon="inline-start"
          aria-hidden="true"
        />
        {{ 'editor.admin.pageDesigns.back' | transloco }}
      </a>
      <p
        class="text-muted-foreground m-0 flex min-h-7 min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-sm"
        data-slot="design-status"
      >
        @if (mode().kind === 'edit') {
          <span class="min-w-0 break-words">{{
            'editor.admin.pageDesigns.savedIn'
              | transloco: { changeSet: changeSets.selected()?.title ?? '' }
          }}</span>
          <span aria-hidden="true">·</span>
          <a
            class="text-foreground focus-visible:ring-ring/50 rounded-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-2"
            routerLink="/review"
            [queryParams]="{ cs: changeSets.selected()?.id }"
            >{{ 'editor.admin.pageDesigns.openReview' | transloco }}</a
          >
        } @else if (draft.status() === 'ready') {
          <ng-icon
            name="lucideLock"
            class="shrink-0"
            size="16"
            aria-hidden="true"
          />
          <span class="min-w-0 flex-1 break-words" data-slot="read-reason">{{
            readReason() | transloco
          }}</span>
        }
      </p>
      <span class="ms-auto flex shrink-0 items-center gap-2">
        @if (draft.saveState(); as s) {
          <of-save-status [status]="s" />
        }
        @if (mode().kind === 'edit') {
          <button
            z-button
            zType="outline"
            zSize="sm"
            type="button"
            data-slot="design-undo"
            [zDisabled]="!draft.canUndo()"
            (click)="draft.undo()"
          >
            <ng-icon
              name="lucideUndo2"
              data-icon="inline-start"
              aria-hidden="true"
            />
            {{ 'editor.admin.pageDesigns.undo' | transloco }}
          </button>
        }
      </span>
    </div>

    @switch (draft.status()) {
      @case ('error') {
        <of-error-state
          [kind]="draft.error()?.kind ?? 'unknown'"
          [message]="draft.error()?.message ?? ''"
          (retry)="reload()"
        />
      }
      @case ('stalled') {
        <of-error-state
          kind="unavailable"
          data-slot="design-stalled"
          [heading]="'editor.admin.pageDesigns.stalled.title' | transloco"
          [message]="'editor.admin.pageDesigns.stalled.text' | transloco"
          (retry)="reload()"
        />
      }
      @case ('missing') {
        <of-error-state
          kind="not-found"
          [heading]="'editor.admin.pageDesigns.missing.title' | transloco"
          [message]="'editor.admin.pageDesigns.missing.text' | transloco"
        />
      }
      @case ('ready') {
        @if (design(); as d) {
          <div
            ofFadeIn
            class="grid min-w-0 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)] xl:grid-cols-[minmax(0,1fr)_minmax(20rem,28rem)]"
          >
            <fieldset
              class="m-0 flex min-w-0 flex-col gap-4 border-0 p-0"
              [disabled]="!editable()"
              data-slot="design-settings"
            >
              <legend class="sr-only">
                {{ 'editor.admin.pageDesigns.settings' | transloco }}
              </legend>

              <section
                class="bg-card flex min-w-0 flex-col gap-3 rounded-xl border p-4"
                aria-labelledby="pd-name"
              >
                <label
                  id="pd-name"
                  class="text-sm font-medium"
                  for="pd-name-input"
                  >{{ 'editor.admin.pageDesigns.name' | transloco }}</label
                >
                <input
                  id="pd-name-input"
                  z-input
                  type="text"
                  autocomplete="off"
                  maxlength="200"
                  class="max-w-md"
                  [value]="d.name"
                  (change)="setName($any($event.target).value)"
                  (keydown.enter)="$any($event.target).blur()"
                />
                <p class="text-muted-foreground m-0 text-xs break-words">
                  {{
                    'editor.admin.pageDesigns.idIs' | transloco: { id: d.id }
                  }}
                </p>
              </section>

              <section
                class="bg-card flex min-w-0 flex-col gap-3 rounded-xl border p-4"
                aria-labelledby="pd-layout"
                data-section="layout"
              >
                <div class="flex min-w-0 flex-col gap-1">
                  <h2 id="pd-layout" class="m-0 text-base font-semibold">
                    {{ 'editor.admin.pageDesigns.layout.title' | transloco }}
                  </h2>
                  <p class="text-muted-foreground m-0 text-xs break-words">
                    {{ 'editor.admin.pageDesigns.layout.hint' | transloco }}
                  </p>
                </div>
                <of-preset-picker
                  [value]="d.preset"
                  [primary]="d.colours.primary"
                  [accent]="d.colours.accent"
                  [disabled]="!editable()"
                  (valueChange)="setPreset($event)"
                />
                @if (showsCover()) {
                  <p
                    class="text-muted-foreground m-0 text-xs break-words"
                    data-slot="cover-note"
                  >
                    {{
                      'editor.admin.pageDesigns.layout.coverNote' | transloco
                    }}
                  </p>
                }
                <div class="flex min-w-0 flex-col gap-1.5">
                  <span
                    class="text-muted-foreground text-xs"
                    id="pd-template"
                    >{{
                      'editor.admin.pageDesigns.template.label' | transloco
                    }}</span
                  >
                  <z-select
                    class="w-full min-w-0 sm:max-w-sm"
                    zPosition="popper"
                    data-slot="template-select"
                    [zDisabled]="!editable() || templates() === null"
                    [zAriaLabel]="
                      'editor.admin.pageDesigns.template.label' | transloco
                    "
                    [zValue]="d.template ?? noTemplate"
                    (zSelectionChange)="setTemplate($any($event))"
                  >
                    <z-select-item [zValue]="noTemplate">{{
                      'editor.admin.pageDesigns.template.none' | transloco
                    }}</z-select-item>
                    @for (id of templateChoices(); track id) {
                      <z-select-item [zValue]="id">{{
                        (templates() ?? []).includes(id)
                          ? id
                          : ('editor.admin.pageDesigns.template.missing'
                            | transloco: { id })
                      }}</z-select-item>
                    }
                  </z-select>
                  <p class="text-muted-foreground m-0 text-xs break-words">
                    {{ 'editor.admin.pageDesigns.template.hint' | transloco }}
                  </p>
                  @if (d.template && (templates() ?? []).includes(d.template)) {
                    <a
                      ofFadeIn
                      class="text-foreground focus-visible:ring-ring/50 inline-flex w-fit items-center gap-1.5 rounded-sm text-xs font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-2"
                      data-slot="template-edit"
                      [routerLink]="['../templates', d.template]"
                      [queryParams]="linkQuery()"
                    >
                      <ng-icon
                        name="lucideFileCode"
                        size="14"
                        aria-hidden="true"
                      />
                      {{ 'editor.admin.pageDesigns.template.edit' | transloco }}
                    </a>
                  }
                  @if (templatesFailed()) {
                    <p
                      class="text-destructive m-0 text-xs break-words"
                      data-slot="templates-failed"
                    >
                      {{
                        'editor.admin.pageDesigns.template.loadFailed'
                          | transloco
                      }}
                    </p>
                  }
                </div>
                <ng-container
                  *ngTemplateOutlet="
                    issuesTpl;
                    context: {
                      $implicit: issuesOf('preset', 'coverImage', 'template'),
                    }
                  "
                />
              </section>

              <section
                class="bg-card flex min-w-0 flex-col gap-3 rounded-xl border p-4"
                aria-labelledby="pd-page"
                data-section="page"
              >
                <h2 id="pd-page" class="m-0 text-base font-semibold">
                  {{ 'editor.admin.pageDesigns.page.title' | transloco }}
                </h2>
                <div class="flex min-w-0 flex-col gap-1.5">
                  <span class="text-muted-foreground text-xs" id="pd-size">{{
                    'editor.admin.pageDesigns.page.size' | transloco
                  }}</span>
                  <of-segmented
                    data-slot="page-size"
                    [options]="sizeOptions()"
                    [value]="d.page.size"
                    [label]="'editor.admin.pageDesigns.page.size' | transloco"
                    (valueChange)="setSize($event)"
                  />
                </div>
                <div class="grid min-w-0 grid-cols-2 gap-3 sm:grid-cols-4">
                  @for (side of margins; track side) {
                    <div class="flex min-w-0 flex-col gap-1.5">
                      <label
                        class="text-muted-foreground text-xs"
                        [for]="'pd-margin-' + side"
                        >{{ marginLabels[side] | transloco }}</label
                      >
                      <input
                        z-input
                        type="number"
                        inputmode="decimal"
                        [id]="'pd-margin-' + side"
                        [attr.data-margin]="side"
                        [min]="ranges.margin.min"
                        [max]="ranges.margin.max"
                        [step]="ranges.margin.step"
                        [value]="d.page.margins[side]"
                        [attr.aria-invalid]="
                          invalid() === 'margin-' + side ? 'true' : null
                        "
                        (change)="
                          setNumber(
                            { kind: 'margin', side },
                            $any($event.target)
                          )
                        "
                      />
                    </div>
                  }
                </div>
                <p class="text-muted-foreground m-0 text-xs">
                  {{ 'editor.admin.pageDesigns.page.marginsHint' | transloco }}
                </p>
                <z-switch
                  class="text-sm"
                  data-slot="double-sided"
                  [zDisabled]="!editable()"
                  [zChecked]="d.page.doubleSided"
                  (zCheckedChange)="setDoubleSided($event)"
                  >{{
                    'editor.admin.pageDesigns.page.doubleSided' | transloco
                  }}</z-switch
                >
                <ng-container
                  *ngTemplateOutlet="
                    issuesTpl;
                    context: { $implicit: issuesOf('page') }
                  "
                />
              </section>

              <section
                class="bg-card flex min-w-0 flex-col gap-3 rounded-xl border p-4"
                aria-labelledby="pd-logo"
                data-section="logo"
              >
                <div class="flex min-w-0 flex-col gap-1">
                  <h2 id="pd-logo" class="m-0 text-base font-semibold">
                    {{ 'editor.admin.pageDesigns.logo.title' | transloco }}
                  </h2>
                  <p class="text-muted-foreground m-0 text-xs break-words">
                    {{ 'editor.admin.pageDesigns.logo.hint' | transloco }}
                  </p>
                </div>
                <ul class="m-0 flex list-none flex-col divide-y p-0">
                  @for (slot of logoSlots; track slot) {
                    @let asset = logoOf(slot);
                    <li
                      class="flex min-w-0 flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0"
                      [attr.data-logo]="slot"
                    >
                      <div
                        class="flex h-14 w-28 shrink-0 items-center justify-center overflow-hidden rounded-md border p-1"
                        [class.bg-white]="slot === 'light'"
                        [class.bg-neutral-900]="slot === 'dark'"
                      >
                        @if (asset) {
                          <of-image-thumb
                            class="w-full"
                            [asset]="asset"
                            [changeSetId]="changeSetId()"
                          />
                        } @else {
                          <span
                            class="text-xs"
                            [class.text-neutral-500]="true"
                            >{{
                              'editor.admin.pageDesigns.logo.none' | transloco
                            }}</span
                          >
                        }
                      </div>
                      <div
                        class="flex min-w-0 flex-1 basis-40 flex-col gap-0.5"
                      >
                        <span class="text-sm font-medium">{{
                          (slot === 'light'
                            ? 'editor.admin.pageDesigns.logo.light'
                            : 'editor.admin.pageDesigns.logo.dark'
                          ) | transloco
                        }}</span>
                        <span
                          class="text-muted-foreground text-xs break-words"
                          >{{
                            (slot === 'light'
                              ? 'editor.admin.pageDesigns.logo.lightHint'
                              : 'editor.admin.pageDesigns.logo.darkHint'
                            ) | transloco
                          }}</span
                        >
                      </div>
                      <div class="flex shrink-0 flex-wrap items-center gap-2">
                        <button
                          z-button
                          zType="outline"
                          zSize="sm"
                          type="button"
                          [attr.data-slot]="'logo-pick-' + slot"
                          [zDisabled]="
                            !editable() || (slot === 'dark' && !logoOf('light'))
                          "
                          (click)="pickLogo(slot)"
                        >
                          <ng-icon
                            name="lucideImage"
                            data-icon="inline-start"
                            aria-hidden="true"
                          />
                          {{ 'editor.admin.pageDesigns.logo.pick' | transloco }}
                        </button>
                        @if (slot === 'light') {
                          <button
                            z-button
                            zType="ghost"
                            zSize="sm"
                            type="button"
                            data-slot="logo-platform"
                            [zLoading]="copyingPlatform()"
                            [zDisabled]="!editable() || !platformLogo()"
                            [attr.aria-describedby]="
                              platformLogo() ? null : 'pd-no-platform-logo'
                            "
                            (click)="usePlatformLogo()"
                          >
                            {{
                              'editor.admin.pageDesigns.logo.platform'
                                | transloco
                            }}
                          </button>
                        }
                        @if (asset) {
                          <button
                            z-button
                            zType="ghost"
                            zSize="sm"
                            type="button"
                            [attr.data-slot]="'logo-remove-' + slot"
                            [zDisabled]="!editable()"
                            (click)="removeLogo(slot)"
                          >
                            <ng-icon
                              name="lucideTrash2"
                              data-icon="inline-start"
                              aria-hidden="true"
                            />
                            {{
                              'editor.admin.pageDesigns.logo.remove' | transloco
                            }}
                          </button>
                        }
                      </div>
                    </li>
                  }
                </ul>
                @if (!platformLogo()) {
                  <p
                    id="pd-no-platform-logo"
                    class="text-muted-foreground m-0 text-xs"
                  >
                    {{ 'editor.admin.pageDesigns.logo.noPlatform' | transloco }}
                  </p>
                }
                <ng-container
                  *ngTemplateOutlet="
                    issuesTpl;
                    context: { $implicit: issuesOf('logo') }
                  "
                />
              </section>

              <section
                class="bg-card flex min-w-0 flex-col gap-3 rounded-xl border p-4"
                aria-labelledby="pd-colours"
                data-section="colours"
              >
                <div class="flex min-w-0 flex-col gap-1">
                  <h2 id="pd-colours" class="m-0 text-base font-semibold">
                    {{ 'editor.admin.pageDesigns.colours.title' | transloco }}
                  </h2>
                  <p class="text-muted-foreground m-0 text-xs break-words">
                    {{ 'editor.admin.pageDesigns.colours.hint' | transloco }}
                  </p>
                </div>
                @for (role of colourRoles; track role) {
                  @let value = d.colours[role];
                  @let contrast = contrastOf(value);
                  <div
                    class="flex min-w-0 flex-col gap-1.5 border-t pt-3 first-of-type:border-t-0 first-of-type:pt-0"
                    [attr.data-colour]="role"
                  >
                    <label class="text-sm" [for]="'pd-colour-' + role">{{
                      colourLabels[role] | transloco
                    }}</label>
                    <div class="flex min-w-0 flex-wrap items-center gap-2">
                      <input
                        type="color"
                        class="border-input h-9 w-11 shrink-0 cursor-pointer rounded-md border bg-transparent p-1 disabled:cursor-not-allowed disabled:opacity-50"
                        [attr.data-picker]="role"
                        [attr.aria-label]="
                          'editor.admin.pageDesigns.colours.picker'
                            | transloco
                              : { colour: (colourLabels[role] | transloco) }
                        "
                        [value]="value"
                        (change)="setColour(role, $any($event.target).value)"
                      />
                      <input
                        z-input
                        type="text"
                        class="w-32 font-mono"
                        spellcheck="false"
                        autocomplete="off"
                        maxlength="7"
                        [id]="'pd-colour-' + role"
                        [value]="value"
                        [attr.aria-invalid]="
                          invalid() === 'colour-' + role ? 'true' : null
                        "
                        [attr.aria-describedby]="'pd-colour-' + role + '-hint'"
                        (change)="setColour(role, $any($event.target).value)"
                        (keydown.enter)="$any($event.target).blur()"
                      />
                      <span
                        class="text-xs tabular-nums"
                        [class.text-muted-foreground]="contrast.enough"
                        [class.text-destructive]="!contrast.enough"
                        [attr.data-contrast]="role"
                        >{{
                          (contrast.enough
                            ? 'editor.admin.pageDesigns.colours.contrastOk'
                            : 'editor.admin.pageDesigns.colours.contrastLow'
                          ) | transloco: { ratio: contrast.ratio }
                        }}</span
                      >
                    </div>
                    <p
                      class="text-muted-foreground m-0 text-xs break-words"
                      [id]="'pd-colour-' + role + '-hint'"
                    >
                      {{ colourHints[role] | transloco }}
                    </p>
                    @if (invalid() === 'colour-' + role) {
                      <p class="text-destructive m-0 text-xs" role="alert">
                        {{
                          'editor.admin.pageDesigns.colours.invalid' | transloco
                        }}
                      </p>
                    }
                  </div>
                }
                <div
                  class="bg-muted/50 flex min-w-0 flex-col gap-2 rounded-lg p-3"
                  data-slot="safety-colours"
                >
                  <p class="m-0 flex items-center gap-1.5 text-xs font-medium">
                    <ng-icon name="lucideLock" size="14" aria-hidden="true" />
                    {{
                      'editor.admin.pageDesigns.fixed.safetyColours.title'
                        | transloco
                    }}
                  </p>
                  <ul class="m-0 flex list-none flex-wrap gap-1.5 p-0">
                    @for (s of swatches; track s.level) {
                      <li
                        class="rounded px-2 py-0.5 text-[0.6875rem] font-semibold tracking-wide"
                        [class]="s.swatch"
                      >
                        {{ s.label | transloco }}
                      </li>
                    }
                  </ul>
                  <p class="text-muted-foreground m-0 text-xs break-words">
                    {{
                      'editor.admin.pageDesigns.fixed.safetyColours.reason'
                        | transloco
                    }}
                  </p>
                </div>
                <ng-container
                  *ngTemplateOutlet="
                    issuesTpl;
                    context: { $implicit: issuesOf('colours') }
                  "
                />
              </section>

              <section
                class="bg-card flex min-w-0 flex-col gap-3 rounded-xl border p-4"
                aria-labelledby="pd-fonts"
                data-section="fonts"
              >
                <h2 id="pd-fonts" class="m-0 text-base font-semibold">
                  {{ 'editor.admin.pageDesigns.fonts.title' | transloco }}
                </h2>
                <of-design-fonts
                  [fonts]="d.fonts"
                  [editable]="editable()"
                  [changeSetId]="changeSetId()"
                  (fontsChange)="setFonts($event)"
                />
                @if (d.fonts.body || d.fonts.heading) {
                  <z-switch
                    class="text-sm"
                    data-slot="fonts-licence"
                    [zDisabled]="!editable()"
                    [zChecked]="d.fonts.embeddingAllowed"
                    (zCheckedChange)="setEmbedding($event)"
                    >{{
                      'editor.admin.pageDesigns.fonts.licence' | transloco
                    }}</z-switch
                  >
                }
                <ng-container
                  *ngTemplateOutlet="
                    issuesTpl;
                    context: { $implicit: issuesOf('fonts') }
                  "
                />
              </section>

              <section
                class="bg-card flex min-w-0 flex-col gap-3 rounded-xl border p-4"
                aria-labelledby="pd-fields"
                data-section="fields"
              >
                <div class="flex min-w-0 flex-col gap-1">
                  <h2 id="pd-fields" class="m-0 text-base font-semibold">
                    {{ 'editor.admin.pageDesigns.fields.title' | transloco }}
                  </h2>
                  <p class="text-muted-foreground m-0 text-xs break-words">
                    {{ 'editor.admin.pageDesigns.fields.hint' | transloco }}
                  </p>
                </div>
                <of-sortable-list
                  data-slot="title-fields"
                  [items]="fieldItems()"
                  [readonly]="!editable()"
                  [label]="'editor.admin.pageDesigns.fields.title' | transloco"
                  (itemsChange)="orderFields($any($event))"
                >
                  <ng-template ofSortableRow let-item>
                    <div
                      class="flex min-w-0 flex-1 items-center justify-between gap-2"
                      [attr.data-field]="item.id"
                    >
                      <span
                        class="min-w-0 text-sm break-words"
                        [class.text-muted-foreground]="!item.shown"
                        >{{ item.label }}</span
                      >
                      <z-switch
                        zSize="sm"
                        [zDisabled]="!editable()"
                        [zChecked]="item.shown"
                        [attr.aria-label]="
                          'editor.admin.pageDesigns.fields.show'
                            | transloco: { field: item.label }
                        "
                        (zCheckedChange)="showField(item.id, $event)"
                      />
                    </div>
                  </ng-template>
                </of-sortable-list>
                <ng-container
                  *ngTemplateOutlet="
                    issuesTpl;
                    context: { $implicit: issuesOf('titlePage') }
                  "
                />
              </section>

              <section
                class="bg-card flex min-w-0 flex-col gap-4 rounded-xl border p-4"
                aria-labelledby="pd-regions"
                data-section="regions"
              >
                <div class="flex min-w-0 flex-col gap-1">
                  <h2 id="pd-regions" class="m-0 text-base font-semibold">
                    {{ 'editor.admin.pageDesigns.regions.title' | transloco }}
                  </h2>
                  <p class="text-muted-foreground m-0 text-xs break-words">
                    {{ 'editor.admin.pageDesigns.regions.hint' | transloco }}
                  </p>
                </div>
                @if (languages().length > 0) {
                  <of-region-texts
                    [design]="d"
                    [languages]="languages()"
                    [lang]="lang()"
                    [config]="config()"
                    [issues]="draft.issues()"
                    [editable]="editable()"
                    [changeSetId]="changeSetId()"
                    [apply]="setRegions"
                    (langChange)="langPicked.set($event)"
                  />
                } @else {
                  <z-skeleton class="h-24 w-full rounded-lg" />
                }
              </section>

              <section
                class="bg-card flex min-w-0 flex-col gap-3 rounded-xl border p-4"
                aria-labelledby="pd-back"
                data-section="back-page"
              >
                <div class="flex min-w-0 flex-col gap-1">
                  <h2 id="pd-back" class="m-0 text-base font-semibold">
                    {{ 'editor.admin.pageDesigns.backPage.title' | transloco }}
                  </h2>
                  <p class="text-muted-foreground m-0 text-xs break-words">
                    {{ 'editor.admin.pageDesigns.backPage.hint' | transloco }}
                  </p>
                </div>
                <z-switch
                  class="text-sm"
                  data-slot="back-page"
                  [zDisabled]="!editable()"
                  [zChecked]="d.backPage !== undefined"
                  (zCheckedChange)="setBackPage($event)"
                  >{{
                    'editor.admin.pageDesigns.backPage.on' | transloco
                  }}</z-switch
                >
                <of-collapse [open]="d.backPage !== undefined">
                  @if (d.backPage; as back) {
                    <div class="flex min-w-0 flex-col gap-3 pt-1">
                      <div class="flex min-w-0 flex-col gap-1.5">
                        <span class="text-muted-foreground text-xs">{{
                          'editor.admin.pageDesigns.backPage.position'
                            | transloco
                        }}</span>
                        <of-segmented
                          data-slot="back-page-position"
                          [class.pointer-events-none]="!editable()"
                          [class.opacity-60]="!editable()"
                          [attr.aria-disabled]="!editable() || null"
                          [options]="positionOptions()"
                          [value]="back.position"
                          [label]="
                            'editor.admin.pageDesigns.backPage.position'
                              | transloco
                          "
                          (valueChange)="setBackPosition($event)"
                        />
                        <p
                          class="text-muted-foreground m-0 text-xs break-words"
                        >
                          {{ positionHint(back.position) | transloco }}
                        </p>
                      </div>
                      <z-switch
                        class="text-sm"
                        data-slot="back-page-number"
                        [zDisabled]="!editable()"
                        [zChecked]="back.documentNumber"
                        (zCheckedChange)="
                          setBackPageFacts({ documentNumber: $event })
                        "
                        >{{
                          'editor.admin.pageDesigns.backPage.documentNumber'
                            | transloco
                        }}</z-switch
                      >
                      <z-switch
                        class="text-sm"
                        data-slot="back-page-date"
                        [zDisabled]="!editable()"
                        [zChecked]="back.date"
                        (zCheckedChange)="setBackPageFacts({ date: $event })"
                        >{{
                          'editor.admin.pageDesigns.backPage.date' | transloco
                        }}</z-switch
                      >
                      <div class="flex min-w-0 flex-col gap-1.5">
                        <label
                          class="text-muted-foreground text-xs"
                          for="pd-copyright"
                          >{{
                            'editor.admin.pageDesigns.backPage.copyright'
                              | transloco
                                : { language: languageLabel(copyrightLang()) }
                          }}</label
                        >
                        @if (projectLanguages().length > 1) {
                          <of-segmented
                            data-slot="back-page-copyright-language"
                            [options]="copyrightLanguageOptions()"
                            [value]="copyrightLang()"
                            [label]="
                              'editor.admin.pageDesigns.backPage.copyrightLanguage'
                                | transloco
                            "
                            (valueChange)="copyrightLangPicked.set($event)"
                          />
                        }
                        <input
                          id="pd-copyright"
                          z-input
                          type="text"
                          autocomplete="off"
                          maxlength="500"
                          class="max-w-md"
                          [disabled]="!editable()"
                          [value]="copyrightIn(back.copyright, copyrightLang())"
                          [placeholder]="
                            'editor.admin.pageDesigns.backPage.copyrightPlaceholder'
                              | transloco
                          "
                          (change)="setCopyright($any($event.target).value)"
                          (keydown.enter)="$any($event.target).blur()"
                        />
                      </div>
                      <div
                        class="bg-muted/40 flex min-w-0 flex-col gap-1 rounded-lg border px-3 py-2.5"
                        data-slot="back-page-manufacturer"
                      >
                        <span class="text-xs font-medium">{{
                          'editor.admin.pageDesigns.backPage.manufacturer'
                            | transloco
                        }}</span>
                        @if (config()?.manufacturer; as m) {
                          <span
                            class="text-sm [overflow-wrap:anywhere]"
                            data-slot="manufacturer-name"
                            >{{ m.name }}</span
                          >
                          @for (line of m.address ?? []; track $index) {
                            <span
                              class="text-muted-foreground text-xs [overflow-wrap:anywhere]"
                              >{{ line }}</span
                            >
                          }
                        } @else {
                          <span
                            class="text-muted-foreground text-xs break-words"
                            data-slot="manufacturer-none"
                            >{{
                              'editor.admin.pageDesigns.backPage.noManufacturer'
                                | transloco
                            }}</span
                          >
                        }
                        <a
                          class="text-primary w-fit text-xs underline-offset-4 hover:underline"
                          data-slot="manufacturer-settings"
                          routerLink="/admin/settings/manufacturer"
                          [queryParams]="linkQuery()"
                          >{{
                            'editor.admin.pageDesigns.backPage.editManufacturer'
                              | transloco
                          }}</a
                        >
                      </div>
                    </div>
                  }
                </of-collapse>
                <ng-container
                  *ngTemplateOutlet="
                    issuesTpl;
                    context: { $implicit: issuesOf('backPage') }
                  "
                />
              </section>

              <section
                class="bg-card flex min-w-0 flex-col gap-4 rounded-xl border p-4"
                aria-labelledby="pd-running"
                data-section="running"
              >
                <div class="flex min-w-0 flex-col gap-1">
                  <h2 id="pd-running" class="m-0 text-base font-semibold">
                    {{ 'editor.admin.pageDesigns.running.title' | transloco }}
                  </h2>
                  <p class="text-muted-foreground m-0 text-xs break-words">
                    {{ 'editor.admin.pageDesigns.running.hint' | transloco }}
                  </p>
                </div>
                <div class="flex min-w-0 flex-col gap-2">
                  <h3 class="m-0 text-sm font-medium">
                    {{ 'editor.admin.pageDesigns.running.header' | transloco }}
                  </h3>
                  <of-running-region
                    kind="header"
                    [region]="d.header"
                    [doubleSided]="d.page.doubleSided"
                    [disabled]="!editable()"
                    (regionChange)="setRunning('header', $event)"
                  />
                </div>
                <div class="flex min-w-0 flex-col gap-2 border-t pt-4">
                  <h3 class="m-0 text-sm font-medium">
                    {{ 'editor.admin.pageDesigns.running.footer' | transloco }}
                  </h3>
                  <of-running-region
                    kind="footer"
                    [region]="d.footer"
                    [doubleSided]="d.page.doubleSided"
                    [disabled]="!editable()"
                    (regionChange)="setRunning('footer', $event)"
                  />
                </div>
                <ng-container
                  *ngTemplateOutlet="
                    issuesTpl;
                    context: { $implicit: issuesOf('header', 'footer') }
                  "
                />
              </section>

              <section
                class="bg-card flex min-w-0 flex-col gap-3 rounded-xl border p-4"
                aria-labelledby="pd-headings"
                data-section="headings"
              >
                <h2 id="pd-headings" class="m-0 text-base font-semibold">
                  {{ 'editor.admin.pageDesigns.headings.title' | transloco }}
                </h2>
                <div
                  class="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)] items-center gap-x-3 gap-y-2"
                >
                  <span></span>
                  <span class="text-muted-foreground text-xs">{{
                    'editor.admin.pageDesigns.headings.numbering' | transloco
                  }}</span>
                  <span class="text-muted-foreground text-xs">{{
                    'editor.admin.pageDesigns.headings.size' | transloco
                  }}</span>
                  @for (level of headingLevels(); track $index) {
                    <span class="text-sm tabular-nums">{{
                      'editor.admin.pageDesigns.headings.level'
                        | transloco: { level: $index + 1 }
                    }}</span>
                    <z-select
                      class="w-full min-w-0"
                      zPosition="popper"
                      [attr.data-numbering]="$index + 1"
                      [zDisabled]="!editable()"
                      [zAriaLabel]="
                        'editor.admin.pageDesigns.headings.numberingOf'
                          | transloco: { level: $index + 1 }
                      "
                      [zValue]="level.numbering"
                      (zSelectionChange)="
                        setHeading('numbering', $index, $any($event))
                      "
                    >
                      @for (n of numberings; track n) {
                        <z-select-item [zValue]="n">{{
                          numberingLabels[n] | transloco
                        }}</z-select-item>
                      }
                    </z-select>
                    <z-select
                      class="w-full min-w-0"
                      zPosition="popper"
                      [attr.data-size]="$index + 1"
                      [zDisabled]="!editable()"
                      [zAriaLabel]="
                        'editor.admin.pageDesigns.headings.sizeOf'
                          | transloco: { level: $index + 1 }
                      "
                      [zValue]="level.size"
                      (zSelectionChange)="
                        setHeading('sizes', $index, $any($event))
                      "
                    >
                      @for (s of sizes; track s) {
                        <z-select-item [zValue]="s">{{
                          sizeLabels[s] | transloco
                        }}</z-select-item>
                      }
                    </z-select>
                  }
                </div>
                <p class="text-muted-foreground m-0 text-xs">
                  {{ 'editor.admin.pageDesigns.headings.deeper' | transloco }}
                </p>
                <div class="flex min-w-0 flex-col gap-1.5">
                  <span class="text-muted-foreground text-xs">{{
                    'editor.admin.pageDesigns.headings.colour' | transloco
                  }}</span>
                  <of-segmented
                    data-slot="heading-colour"
                    [options]="roleOptions()"
                    [value]="d.headings.colour"
                    [label]="
                      'editor.admin.pageDesigns.headings.colour' | transloco
                    "
                    (valueChange)="setHeadingColour($event)"
                  />
                </div>
                <z-switch
                  class="text-sm"
                  data-slot="page-break"
                  [zDisabled]="!editable()"
                  [zChecked]="d.headings.pageBreakBeforeLevel1"
                  (zCheckedChange)="setPageBreak($event)"
                  >{{
                    'editor.admin.pageDesigns.headings.pageBreak' | transloco
                  }}</z-switch
                >
                <ng-container
                  *ngTemplateOutlet="
                    issuesTpl;
                    context: { $implicit: issuesOf('headings') }
                  "
                />
              </section>

              <section
                class="bg-card flex min-w-0 flex-col gap-3 rounded-xl border p-4"
                aria-labelledby="pd-body"
                data-section="body"
              >
                <h2 id="pd-body" class="m-0 text-base font-semibold">
                  {{ 'editor.admin.pageDesigns.body.title' | transloco }}
                </h2>
                <div class="grid min-w-0 gap-3 sm:grid-cols-3">
                  @for (key of bodyKeys; track key) {
                    <div class="flex min-w-0 flex-col gap-1.5">
                      <label
                        class="text-muted-foreground text-xs"
                        [for]="'pd-body-' + key"
                        >{{ bodyLabels[key] | transloco }}</label
                      >
                      <input
                        z-input
                        type="number"
                        inputmode="decimal"
                        [id]="'pd-body-' + key"
                        [attr.data-body]="key"
                        [min]="ranges[key].min"
                        [max]="ranges[key].max"
                        [step]="ranges[key].step"
                        [value]="d.body[key]"
                        [attr.aria-invalid]="
                          invalid() === 'body-' + key ? 'true' : null
                        "
                        (change)="
                          setNumber({ kind: 'body', key }, $any($event.target))
                        "
                      />
                    </div>
                  }
                </div>
                @if (
                  invalid()?.startsWith('body-') ||
                  invalid()?.startsWith('margin-')
                ) {
                  <p class="text-destructive m-0 text-xs" role="alert">
                    {{
                      'editor.admin.pageDesigns.numberRange'
                        | transloco: invalidRange()
                    }}
                  </p>
                }
                <div class="flex min-w-0 flex-col gap-1.5">
                  <span class="text-muted-foreground text-xs">{{
                    'editor.admin.pageDesigns.body.columns' | transloco
                  }}</span>
                  <of-segmented
                    data-slot="columns"
                    [options]="columnOptions()"
                    [value]="'' + d.body.columns"
                    [label]="
                      'editor.admin.pageDesigns.body.columns' | transloco
                    "
                    (valueChange)="setColumns($event)"
                  />
                </div>
                <ng-container
                  *ngTemplateOutlet="
                    issuesTpl;
                    context: { $implicit: issuesOf('body') }
                  "
                />
              </section>

              <section
                class="bg-card flex min-w-0 flex-col gap-3 rounded-xl border p-4"
                aria-labelledby="pd-tables"
                data-section="tables"
              >
                <h2 id="pd-tables" class="m-0 text-base font-semibold">
                  {{ 'editor.admin.pageDesigns.tables.title' | transloco }}
                </h2>
                <div class="flex min-w-0 flex-col gap-1.5">
                  <span class="text-muted-foreground text-xs">{{
                    'editor.admin.pageDesigns.tables.borders' | transloco
                  }}</span>
                  <of-segmented
                    data-slot="table-borders"
                    [options]="borderOptions()"
                    [value]="d.tables.borders"
                    [label]="
                      'editor.admin.pageDesigns.tables.borders' | transloco
                    "
                    (valueChange)="setTables({ borders: $any($event) })"
                  />
                </div>
                <z-switch
                  class="text-sm"
                  data-slot="table-tint"
                  [zDisabled]="!editable()"
                  [zChecked]="d.tables.headerTint"
                  (zCheckedChange)="setTables({ headerTint: $event })"
                  >{{
                    'editor.admin.pageDesigns.tables.headerTint' | transloco
                  }}</z-switch
                >
                <z-switch
                  class="text-sm"
                  data-slot="table-zebra"
                  [zDisabled]="!editable()"
                  [zChecked]="d.tables.zebra"
                  (zCheckedChange)="setTables({ zebra: $event })"
                  >{{
                    'editor.admin.pageDesigns.tables.zebra' | transloco
                  }}</z-switch
                >
              </section>

              <section
                class="bg-card flex min-w-0 flex-col gap-3 rounded-xl border p-4"
                aria-labelledby="pd-steps"
                data-section="steps"
              >
                <h2 id="pd-steps" class="m-0 text-base font-semibold">
                  {{ 'editor.admin.pageDesigns.steps.title' | transloco }}
                </h2>
                <div class="flex min-w-0 flex-col gap-1.5">
                  <span class="text-muted-foreground text-xs">{{
                    'editor.admin.pageDesigns.steps.marker' | transloco
                  }}</span>
                  <of-segmented
                    data-slot="step-marker"
                    [options]="markerOptions()"
                    [value]="d.steps.marker"
                    [label]="
                      'editor.admin.pageDesigns.steps.marker' | transloco
                    "
                    (valueChange)="setSteps($event)"
                  />
                </div>
                <div class="flex min-w-0 flex-col gap-1.5">
                  <span class="text-muted-foreground text-xs">{{
                    'editor.admin.pageDesigns.steps.note' | transloco
                  }}</span>
                  <of-segmented
                    data-slot="note-style"
                    [options]="noteOptions()"
                    [value]="d.notes.style"
                    [label]="'editor.admin.pageDesigns.steps.note' | transloco"
                    (valueChange)="setNotes($event)"
                  />
                </div>
              </section>

              <section
                class="bg-card flex min-w-0 flex-col gap-3 rounded-xl border p-4"
                aria-labelledby="pd-safety"
                data-section="safety"
              >
                <div class="flex min-w-0 flex-col gap-1">
                  <h2 id="pd-safety" class="m-0 text-base font-semibold">
                    {{ 'editor.admin.pageDesigns.safety.title' | transloco }}
                  </h2>
                  <p class="text-muted-foreground m-0 text-xs break-words">
                    {{ 'editor.admin.pageDesigns.safety.hint' | transloco }}
                  </p>
                </div>
                <of-segmented
                  data-slot="safety-standard"
                  [options]="standardOptions()"
                  [value]="d.safety.standard"
                  [label]="
                    'editor.admin.pageDesigns.safety.standard' | transloco
                  "
                  (valueChange)="setStandard($event)"
                />
                <p class="text-muted-foreground m-0 text-xs break-words">
                  {{ standardHints[d.safety.standard] | transloco }}
                </p>
                <div
                  class="flex min-w-0 flex-col gap-2 border-t pt-3"
                  data-slot="fixed-settings"
                >
                  <h3 class="m-0 flex items-center gap-1.5 text-sm font-medium">
                    <ng-icon name="lucideLock" size="14" aria-hidden="true" />
                    {{ 'editor.admin.pageDesigns.fixed.title' | transloco }}
                  </h3>
                  <dl class="m-0 flex min-w-0 flex-col gap-2">
                    @for (f of fixed; track f.id) {
                      <div
                        class="flex min-w-0 flex-col gap-0.5"
                        [attr.data-fixed]="f.id"
                      >
                        <dt class="text-sm">{{ f.title | transloco }}</dt>
                        <dd
                          class="text-muted-foreground m-0 text-xs break-words"
                        >
                          {{
                            f.reason
                              | transloco
                                : {
                                    standard:
                                      (standardLabels[d.safety.standard]
                                      | transloco),
                                  }
                          }}
                        </dd>
                      </div>
                    }
                  </dl>
                </div>
              </section>

              @if (otherIssues().length > 0) {
                <section
                  class="bg-card flex min-w-0 flex-col gap-2 rounded-xl border p-4"
                  aria-labelledby="pd-other"
                  data-section="other"
                >
                  <h2 id="pd-other" class="m-0 text-base font-semibold">
                    {{ 'editor.admin.pageDesigns.issues.other' | transloco }}
                  </h2>
                  <ng-container
                    *ngTemplateOutlet="
                      issuesTpl;
                      context: { $implicit: otherIssues() }
                    "
                  />
                </section>
              }
            </fieldset>

            <aside
              class="bg-card flex min-w-0 flex-col gap-3 rounded-xl border p-4 lg:sticky lg:top-4"
              aria-labelledby="pd-preview"
              data-slot="design-preview"
            >
              <h2 id="pd-preview" class="m-0 text-base font-semibold">
                {{ 'editor.admin.pageDesigns.preview.title' | transloco }}
              </h2>
              @if (manuals(); as list) {
                @if (list.length === 0) {
                  <p
                    class="text-muted-foreground m-0 text-sm"
                    data-slot="no-manuals"
                  >
                    {{
                      'editor.admin.pageDesigns.preview.noManuals' | transloco
                    }}
                  </p>
                } @else {
                  <div
                    class="grid min-w-0 gap-2 sm:grid-cols-3 lg:grid-cols-1 2xl:grid-cols-3"
                  >
                    <z-select
                      class="w-full min-w-0"
                      zPosition="popper"
                      data-slot="preview-manual"
                      [zAriaLabel]="
                        'editor.admin.pageDesigns.preview.manual' | transloco
                      "
                      [zValue]="manualId()"
                      (zSelectionChange)="pickManual($any($event))"
                    >
                      @for (m of list; track m.id) {
                        <z-select-item [zValue]="m.id">{{
                          m.title | uiText
                        }}</z-select-item>
                      }
                    </z-select>
                    <z-select
                      class="w-full min-w-0"
                      zPosition="popper"
                      data-slot="preview-variant"
                      [zAriaLabel]="
                        'editor.admin.pageDesigns.preview.variant' | transloco
                      "
                      [zValue]="variant()"
                      (zSelectionChange)="variantPicked.set($any($event))"
                    >
                      @for (v of manual()?.variants ?? []; track v.slug) {
                        <z-select-item [zValue]="v.slug">{{
                          v.label
                        }}</z-select-item>
                      }
                    </z-select>
                    <z-select
                      class="w-full min-w-0"
                      zPosition="popper"
                      data-slot="preview-language"
                      [zAriaLabel]="
                        'editor.admin.pageDesigns.preview.language' | transloco
                      "
                      [zValue]="lang()"
                      (zSelectionChange)="langPicked.set($any($event))"
                    >
                      @for (l of languages(); track l) {
                        <z-select-item [zValue]="l">{{
                          languageLabel(l)
                        }}</z-select-item>
                      }
                    </z-select>
                  </div>
                  <of-design-preview
                    [request]="previewRequest()"
                    [revision]="draft.saves()"
                    [pageSize]="d.page.size"
                  />
                }
              } @else {
                <div class="grid grid-cols-2 gap-3" aria-hidden="true">
                  <z-skeleton class="aspect-[210/297] w-full" />
                  <z-skeleton class="aspect-[210/297] w-full" />
                </div>
              }
            </aside>
          </div>
        }
      }
      @default {
        <div
          ofFadeIn="delayed"
          class="grid gap-5 lg:grid-cols-[minmax(0,1fr)_24rem]"
          aria-hidden="true"
        >
          <div class="flex flex-col gap-4">
            <z-skeleton class="h-32 w-full rounded-xl" />
            <z-skeleton class="h-48 w-full rounded-xl" />
          </div>
          <z-skeleton class="h-96 w-full rounded-xl" />
        </div>
      }
    }

    <ng-template #issuesTpl let-list>
      @if (list.length > 0) {
        <ul
          class="m-0 flex list-none flex-col gap-1 p-0"
          data-slot="design-issues"
        >
          @for (issue of list; track $index) {
            <li
              class="flex min-w-0 gap-1.5 text-xs"
              [class.text-destructive]="issue.severity === 'error'"
              [attr.data-issue]="issue.code"
            >
              <ng-icon
                name="lucideTriangleAlert"
                class="mt-0.5 shrink-0"
                size="13"
                aria-hidden="true"
              />
              <span class="min-w-0 [overflow-wrap:anywhere]">{{
                describe(issue)
              }}</span>
            </li>
          }
        </ul>
      }
    </ng-template>

    <of-insert-image-dialog [changeSetId]="changeSetId()" [pickOnly]="true" />
  `,
})
export class PageDesignEditorPage {
  protected readonly draft = inject(DesignDraft);
  protected readonly changeSets = inject(ChangeSetSession);
  private readonly csLink = inject(ChangeSetUrl);
  private readonly api = inject(ApiClient);
  private readonly texts = inject(UiTexts);
  private readonly route = inject(ActivatedRoute);
  private readonly toast = inject(ToastService);
  private readonly branding = inject(BrandingService);
  private readonly http = inject(HttpClient);
  private readonly apiBase = inject(API_BASE_URL);
  private readonly language = inject(LanguageService);
  private readonly t = injectTranslate();
  private readonly imageDialog = viewChild(InsertImageDialogComponent);

  protected readonly design = this.draft.design;
  protected readonly mode = this.draft.mode;
  protected readonly margins = MARGINS;
  protected readonly marginLabels = MARGIN_LABELS;
  protected readonly ranges = RANGES;
  protected readonly logoSlots: readonly LogoSlot[] = ['light', 'dark'];
  protected readonly colourRoles = COLOUR_ROLES;
  protected readonly colourLabels = COLOUR_LABELS;
  protected readonly colourHints = COLOUR_HINTS;
  protected readonly swatches = SAFETY_SWATCHES;
  protected readonly fixed = FIXED_SETTINGS;
  protected readonly numberings = HEADING_NUMBERINGS;
  protected readonly numberingLabels = NUMBERING_LABELS;
  protected readonly sizes = TYPE_SCALE_STEPS;
  protected readonly sizeLabels = SIZE_LABELS;
  protected readonly standardLabels = STANDARD_LABELS;
  protected readonly standardHints = STANDARD_HINTS;
  protected readonly bodyKeys = [
    'fontSize',
    'lineHeight',
    'paragraphSpacing',
  ] as const;
  protected readonly bodyLabels = {
    fontSize: 'editor.admin.pageDesigns.body.fontSize',
    lineHeight: 'editor.admin.pageDesigns.body.lineHeight',
    paragraphSpacing: 'editor.admin.pageDesigns.body.paragraphSpacing',
  } as const;

  /** The design's ID, from the address. */
  private readonly designId = toSignal(
    this.route.paramMap.pipe(map((p) => p.get('designId') ?? '')),
    { initialValue: this.route.snapshot.paramMap.get('designId') ?? '' },
  );
  /** A field whose typed value was refused (`colour-primary`, `margin-top`, …), shown as such. */
  protected readonly invalid = signal<string | null>(null);
  protected readonly copyingPlatform = signal(false);

  protected readonly editable = computed(
    () => this.mode().kind === 'edit' && this.draft.status() === 'ready',
  );
  protected readonly readReason = computed(() => {
    const m = this.mode();
    return m.kind === 'read' && m.reason
      ? m.reason
      : 'editor.admin.pageDesigns.blocked.readOnly';
  });
  protected readonly linkQuery = computed(() => this.csLink.params());
  protected readonly changeSetId = computed(() =>
    this.mode().kind === 'edit'
      ? (this.changeSets.selected()?.id ?? null)
      : null,
  );
  /** #169's light logo (`sha256:<hash>`), or null when the platform has none of its own. */
  protected readonly platformLogo = computed(
    () => this.branding.resource()?.attributes.logoLight ?? null,
  );
  protected readonly showsCover = computed(() =>
    presetShowsCover(this.design()?.preset ?? ''),
  );

  private readonly changeSet = computed((): DesignChangeSet | null => {
    const chosen = this.changeSets.selected();
    if (!chosen?.branch) return null;
    const option = this.changeSets.options().find((o) => o.id === chosen.id);
    return {
      id: chosen.id,
      branch: chosen.branch,
      state: option?.state ?? 'draft',
      authorId: option?.authorId ?? '',
    };
  });
  private readonly loadKey = computed(() => {
    const cs = this.changeSet();
    return `${this.designId()}\n${cs?.id ?? ''}\n${cs?.state ?? ''}\n${cs?.authorId ?? ''}`;
  });

  // --- The preview's manual, variant and language ---

  private readonly storedManuals = signal<readonly PreviewManual[] | null>(
    null,
  );
  /** The manuals to preview with, their variants by their labels in the interface language (#731). */
  protected readonly manuals = computed((): readonly PreviewManual[] | null => {
    const config = this.storedConfig();
    return (
      this.storedManuals()?.map((m) => ({
        ...m,
        variants: m.variants.map((v) => ({
          ...v,
          label: this.texts.variant(v.values, config, v.label),
        })),
      })) ?? null
    );
  });
  private readonly manualPicked = signal<string | null>(null);
  protected readonly variantPicked = signal<string | null>(null);
  protected readonly langPicked = signal<string | null>(null);
  protected readonly languages = signal<readonly string[]>([]);
  /** The project's configuration: what the regions' editors check text against. */
  /** The configuration as read (`GET /config`). */
  private readonly storedConfig = signal<StoredConfig | null>(null);
  /** The configuration with its labels in the interface language (#731). */
  protected readonly config = labelsInUi(this.storedConfig);
  /** The own templates at the change set's branch (#396); null until read. */
  protected readonly templates = signal<readonly string[] | null>(null);
  protected readonly templatesFailed = signal(false);
  /** The select's value for no own template: no template ID (a slug) looks like it. */
  protected readonly noTemplate = ':layout';
  /** The templates to choose from: the repository's, and the design's own if it is not there. */
  protected readonly templateChoices = computed(() => {
    const listed = this.templates() ?? [];
    const own = this.design()?.template;
    return own !== undefined && !listed.includes(own)
      ? [...listed, own]
      : listed;
  });

  protected readonly manual = computed(() => {
    const list = this.manuals() ?? [];
    return list.find((m) => m.id === this.manualPicked()) ?? list[0] ?? null;
  });
  protected readonly manualId = computed(() => this.manual()?.id ?? '');
  protected readonly variant = computed(() => {
    const variants = this.manual()?.variants ?? [];
    const picked = this.variantPicked();
    return (variants.find((v) => v.slug === picked) ?? variants[0])?.slug ?? '';
  });
  protected readonly lang = computed(() => {
    const langs = this.languages();
    const picked = this.langPicked();
    return picked && langs.includes(picked) ? picked : (langs[0] ?? '');
  });
  protected readonly previewRequest = computed(
    (): DesignPreviewRequest | null => {
      const manualId = this.manualId();
      const variant = this.variant();
      const lang = this.lang();
      const design = this.design();
      if (!manualId || !variant || !lang || !design) return null;
      const branch = this.changeSets.selected()?.branch ?? null;
      return {
        manualId,
        variant,
        lang,
        designId: design.id,
        ref: branch,
        live: this.mode().kind === 'edit' && this.draft.live(),
      };
    },
  );

  // --- Options ---

  protected readonly sizeOptions = computed((): SegmentedOption[] =>
    PAGE_SIZES.map((value) => ({
      value,
      label: this.t(PAGE_SIZE_LABELS[value]),
    })),
  );
  protected readonly roleOptions = computed((): SegmentedOption[] =>
    ['text', 'primary', 'accent'].map((value) => ({
      value,
      label: this.t(ROLE_LABELS[value] as string),
    })),
  );
  protected readonly columnOptions = computed((): SegmentedOption[] => [
    { value: '1', label: this.t('editor.admin.pageDesigns.body.one') },
    { value: '2', label: this.t('editor.admin.pageDesigns.body.two') },
  ]);
  protected readonly borderOptions = computed((): SegmentedOption[] =>
    TABLE_BORDERS.map((value) => ({
      value,
      label: this.t(BORDER_LABELS[value] as string),
    })),
  );
  protected readonly markerOptions = computed((): SegmentedOption[] =>
    STEP_MARKERS.map((value) => ({
      value,
      label: this.t(MARKER_LABELS[value] as string),
    })),
  );
  protected readonly noteOptions = computed((): SegmentedOption[] =>
    NOTE_STYLES.map((value) => ({
      value,
      label: this.t(NOTE_LABELS[value] as string),
    })),
  );
  protected readonly standardOptions = computed((): SegmentedOption[] =>
    SAFETY_STANDARDS.map((value) => ({
      value,
      label: this.t(STANDARD_LABELS[value] as string),
    })),
  );

  protected readonly positionOptions = computed((): SegmentedOption[] =>
    BACK_PAGE_POSITIONS.map((value) => ({
      value,
      label: this.t(POSITION_LABELS[value]),
    })),
  );

  /** The project's languages, the source language first: those a copyright line is written in. */
  protected readonly projectLanguages = computed((): readonly string[] => {
    const c = this.config();
    return c ? [c.languages.source, ...c.languages.targets] : [];
  });
  protected readonly copyrightLangPicked = signal<string | null>(null);
  /** The language the copyright field edits: the one picked, else the source language. */
  protected readonly copyrightLang = computed(() => {
    const langs = this.projectLanguages();
    const picked = this.copyrightLangPicked();
    return picked && langs.includes(picked) ? picked : (langs[0] ?? '');
  });
  protected readonly copyrightLanguageOptions = computed(
    (): SegmentedOption[] =>
      this.projectLanguages().map((value) => ({
        value,
        label: languageName(this.language.locale(), value),
      })),
  );

  protected positionHint(position: BackPagePosition): string {
    return POSITION_HINTS[position];
  }

  /** The copyright line in `lang`, as the PDF prints it there (else the source language's). */
  protected copyrightIn(text: Copyright | undefined, lang: string): string {
    return copyrightIn(text, lang, this.config()?.languages.source ?? lang);
  }

  protected readonly fieldItems = computed(() => {
    // Follows the interface language: the labels are shown as they are.
    this.language.active();
    return fieldRows(this.design()?.titlePage.fields ?? []).map((r) => ({
      ...r,
      label: this.t(FIELD_LABELS[r.id]),
    }));
  });

  protected readonly headingLevels = computed(() => {
    const h = this.design()?.headings;
    if (!h) return [];
    const numbering = levels(h.numbering);
    const sizes = levels(h.sizes);
    return numbering.map((n, i) => ({
      numbering: n,
      size: sizes[i] ?? 'base',
    }));
  });

  protected readonly otherIssues = computed(() =>
    otherIssues(this.draft.issues()),
  );

  constructor() {
    effect(() => {
      this.loadKey();
      // A switch unanswered: nothing of the person before is saved under the next (#716).
      if (this.changeSets.switching()) {
        untracked(() => this.draft.forget());
        return;
      }
      if (this.changeSets.selected()?.branch === null) return;
      untracked(() => void this.draft.load(this.changeSet(), this.designId()));
    });
    effect(() => {
      // The manuals and languages at the change set's branch.
      this.changeSet();
      if (this.changeSets.switching()) return;
      untracked(() => void this.readPreviewChoices());
    });
  }

  /** Leaving the screen (the route guard): what is saved becomes a save point first. */
  async leave(): Promise<boolean> {
    if (this.mode().kind === 'edit') await this.draft.savePoint();
    return true;
  }

  protected reload(): void {
    void this.draft.load(this.changeSet(), this.designId());
  }

  protected issuesOf(...prefixes: string[]): DesignIssue[] {
    return issuesAt(this.draft.issues(), ...prefixes);
  }

  protected describe(issue: DesignIssue): string {
    const text = issueText(issue);
    return this.t(text.key, text.params);
  }

  protected contrastOf(colour: string) {
    return contrastOnWhite(colour);
  }

  protected languageLabel(lang: string): string {
    return `${languageName(this.language.locale(), lang)} (${lang})`;
  }

  protected pickManual(value: string | string[]): void {
    const id = Array.isArray(value) ? value[0] : value;
    if (!id) return;
    this.manualPicked.set(id);
    this.variantPicked.set(null);
  }

  // --- Changes ---

  private change(apply: (d: PageDesign) => PageDesign): void {
    const d = this.design();
    if (!d || !this.editable()) return;
    this.invalid.set(null);
    this.draft.change(apply(d));
  }

  protected setName(value: string): void {
    const name = value.replace(/\s+/g, ' ').trim();
    if (!name) return;
    this.change((d) => ({ ...d, name }));
  }

  protected setPreset(preset: PageDesignPreset): void {
    this.change((d) => ({ ...d, preset }));
  }

  /** An own template from the repository (#396), or none: the layout's. */
  protected setTemplate(value: string): void {
    if (value === (this.design()?.template ?? this.noTemplate)) return;
    this.change((d) => {
      const { template: _, ...rest } = d;
      return value === this.noTemplate ? rest : { ...rest, template: value };
    });
  }

  protected setSize(value: string): void {
    if (!(PAGE_SIZES as readonly string[]).includes(value)) return;
    this.change((d) => ({
      ...d,
      page: { ...d.page, size: value as PageSize },
    }));
  }

  protected setDoubleSided(on: boolean): void {
    this.change((d) => ({ ...d, page: { ...d.page, doubleSided: on } }));
  }

  protected setNumber(what: Numeric, target: HTMLInputElement): void {
    const range = what.kind === 'margin' ? RANGES.margin : RANGES[what.key];
    const key =
      what.kind === 'margin' ? `margin-${what.side}` : `body-${what.key}`;
    const value = Number(target.value);
    if (
      target.value.trim() === '' ||
      !Number.isFinite(value) ||
      value < range.min ||
      value > range.max
    ) {
      this.invalid.set(key);
      this.invalidLimits = range;
      return;
    }
    if (what.kind === 'margin') {
      this.change((d) => ({
        ...d,
        page: { ...d.page, margins: { ...d.page.margins, [what.side]: value } },
      }));
    } else {
      this.change((d) => ({ ...d, body: { ...d.body, [what.key]: value } }));
    }
  }

  private invalidLimits: { min: number; max: number } = RANGES.margin;
  protected invalidRange(): { min: number; max: number } {
    return this.invalidLimits;
  }

  protected setColour(role: ColourRole, typed: string): void {
    const colour = normalColour(typed);
    if (!colour) {
      this.invalid.set(`colour-${role}`);
      return;
    }
    this.change((d) => ({ ...d, colours: { ...d.colours, [role]: colour } }));
  }

  protected setFonts(fonts: PageDesign['fonts']): void {
    this.change((d) => ({ ...d, fonts }));
  }

  protected setEmbedding(on: boolean): void {
    this.change((d) => ({ ...d, fonts: { ...d.fonts, embeddingAllowed: on } }));
  }

  protected orderFields(
    rows: readonly {
      id: PageDesign['titlePage']['fields'][number];
      shown: boolean;
    }[],
  ): void {
    this.change((d) => ({ ...d, titlePage: { fields: shownFields(rows) } }));
  }

  protected showField(
    id: PageDesign['titlePage']['fields'][number],
    on: boolean,
  ): void {
    const rows = this.fieldItems().map((r) =>
      r.id === id ? { ...r, shown: on } : r,
    );
    this.orderFields(rows);
  }

  /** The regions after an edit (`of-region-texts`), also as the screen goes. */
  protected readonly setRegions = (regions: Regions): void =>
    this.change((d) => ({ ...d, regions: asDesignRegions(regions) }));

  /** The back page on (its defaults: last, the document number and the date) or off. */
  protected setBackPage(on: boolean): void {
    this.change((d) => {
      if (on) {
        return d.backPage
          ? d
          : {
              ...d,
              backPage: { position: 'last', documentNumber: true, date: true },
            };
      }
      const next = { ...d };
      delete next.backPage;
      return next;
    });
  }

  protected setBackPosition(value: string): void {
    if (!(BACK_PAGE_POSITIONS as readonly string[]).includes(value)) return;
    this.setBackPageFacts({ position: value as BackPagePosition });
  }

  protected setBackPageFacts(
    patch: Partial<NonNullable<PageDesign['backPage']>>,
  ): void {
    this.change((d) =>
      d.backPage ? { ...d, backPage: { ...d.backPage, ...patch } } : d,
    );
  }

  /** The copyright line in the language picked (#395); empty: that language's is removed. */
  protected setCopyright(value: string): void {
    const lang = this.copyrightLang();
    const source = this.config()?.languages.source;
    if (!lang || !source) return;
    this.change((d) => {
      if (!d.backPage) return d;
      const copyright = withCopyright(
        d.backPage.copyright,
        lang,
        source,
        value,
      );
      const backPage = { ...d.backPage };
      if (copyright === undefined) delete backPage.copyright;
      else backPage.copyright = copyright;
      return { ...d, backPage };
    });
  }

  protected setRunning(kind: 'header' | 'footer', region: RunningRegion): void {
    this.change((d) => ({ ...d, [kind]: region }));
  }

  protected setHeading(
    list: 'numbering' | 'sizes',
    level: number,
    value: string | string[],
  ): void {
    const v = Array.isArray(value) ? value[0] : value;
    if (!v) return;
    this.change((d) => ({
      ...d,
      headings: {
        ...d.headings,
        [list]: withLevel(d.headings[list] as string[], level, v),
      },
    }));
  }

  protected setHeadingColour(value: string): void {
    if (!['text', 'primary', 'accent'].includes(value)) return;
    this.change((d) => ({
      ...d,
      headings: {
        ...d.headings,
        colour: value as PageDesign['headings']['colour'],
      },
    }));
  }

  protected setPageBreak(on: boolean): void {
    this.change((d) => ({
      ...d,
      headings: { ...d.headings, pageBreakBeforeLevel1: on },
    }));
  }

  protected setColumns(value: string): void {
    const columns = value === '2' ? 2 : 1;
    this.change((d) => ({ ...d, body: { ...d.body, columns } }));
  }

  protected setTables(patch: Partial<PageDesign['tables']>): void {
    this.change((d) => ({ ...d, tables: { ...d.tables, ...patch } }));
  }

  protected setSteps(value: string): void {
    if (!(STEP_MARKERS as readonly string[]).includes(value)) return;
    this.change((d) => ({
      ...d,
      steps: { marker: value as PageDesign['steps']['marker'] },
    }));
  }

  protected setNotes(value: string): void {
    if (!(NOTE_STYLES as readonly string[]).includes(value)) return;
    this.change((d) => ({
      ...d,
      notes: { style: value as PageDesign['notes']['style'] },
    }));
  }

  protected setStandard(value: string): void {
    if (!(SAFETY_STANDARDS as readonly string[]).includes(value)) return;
    this.change((d) => ({
      ...d,
      safety: { standard: value as PageDesign['safety']['standard'] },
    }));
  }

  // --- Logo ---

  protected logoOf(slot: LogoSlot): string | null {
    return this.design()?.logo?.[slot] ?? null;
  }

  protected async pickLogo(slot: LogoSlot): Promise<void> {
    const dialog = this.imageDialog();
    if (!dialog || !this.editable()) return;
    const current = this.logoOf(slot);
    const choice = await dialog.open(
      current ? { asset: current, alt: '', caption: '', width: null } : null,
    );
    if (!choice) return;
    this.setLogo(slot, choice.asset);
  }

  private setLogo(slot: LogoSlot, asset: string): void {
    this.change((d) => {
      if (slot === 'light') return { ...d, logo: { ...d.logo, light: asset } };
      if (!d.logo) return d;
      return { ...d, logo: { ...d.logo, dark: asset } };
    });
  }

  protected removeLogo(slot: LogoSlot): void {
    this.change((d) => {
      if (!d.logo) return d;
      if (slot === 'dark') {
        const logo = { ...d.logo };
        delete logo.dark;
        return { ...d, logo };
      }
      // The dark logo stands in for the light one only beside it: without one, neither.
      const next = { ...d };
      delete next.logo;
      return next;
    });
  }

  /** "Use the platform logo": #169's light logo, uploaded into the change set as the design's. */
  protected async usePlatformLogo(): Promise<void> {
    const reference = this.platformLogo();
    const changeSetId = this.changeSetId();
    if (!reference || !changeSetId || this.copyingPlatform()) return;
    this.copyingPlatform.set(true);
    try {
      const file = await platformLogoFile(this.http, this.apiBase, reference);
      const asset = await uploadLogo(this.api, changeSetId, file);
      this.setLogo('light', asset);
      this.toast.success(
        translated('editor.admin.pageDesigns.logo.platformDone'),
      );
    } catch (error) {
      const why = apiErrorText(toApiError(error));
      this.toast.error(
        translated('editor.admin.pageDesigns.logo.platformFailed', {
          why: this.t(why.key, why.params),
        }),
      );
    } finally {
      this.copyingPlatform.set(false);
    }
  }

  // --- Preview choices ---

  /** The own templates at the change set's branch (#396): one page holds every one there is. */
  private async readTemplates(read: number): Promise<void> {
    this.templatesFailed.set(false);
    try {
      const listed = await firstValueFrom(
        this.api.get('/page-design-templates', {
          query: pageQuery({ number: 1, size: 100 }),
        }),
      );
      if (read === this.previewReads) {
        this.templates.set(listed.data.map((t) => t.id));
      }
    } catch {
      if (read === this.previewReads) {
        this.templates.set([]);
        this.templatesFailed.set(true);
      }
    }
  }

  private previewReads = 0;

  private async readPreviewChoices(): Promise<void> {
    const read = ++this.previewReads;
    void this.readTemplates(read);
    try {
      const [manuals, config] = await Promise.all([
        firstValueFrom(
          this.api.get('/manuals', {
            query: pageQuery({ number: 1, size: 100 }),
          }),
        ).catch(() => null),
        firstValueFrom(this.api.get('/config')),
      ]);
      if (read !== this.previewReads) return;
      const { source, targets } = config.data.attributes.languages;
      this.languages.set([source, ...targets]);
      this.storedConfig.set(config.data.attributes);
      // The preview is a help: without manuals it says there are none.
      if (!manuals) {
        this.storedManuals.set([]);
        return;
      }
      this.storedManuals.set(
        manuals.data.flatMap((m): PreviewManual[] =>
          'attributes' in m && 'variants' in m.meta
            ? [
                {
                  id: m.id,
                  title: m.attributes.title,
                  variants: m.meta.variants.map((v) => ({
                    slug: v.slug,
                    label: v.label,
                    values: v.values,
                  })),
                },
              ]
            : [],
        ),
      );
    } catch {
      // The preview is a help: without manuals it says there are none.
      if (read === this.previewReads) {
        this.storedManuals.set([]);
      }
    }
  }
}
