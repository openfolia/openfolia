import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import {
  DEFAULT_OUTPUT_LABELS,
  type OutputLabelKey,
} from '@openfolia/content-model/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideRotateCcw } from '@ng-icons/lucide';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { LanguageService, translated } from '@openfolia/ui/i18n';
import { ZardInputComponent } from '@openfolia/ui/input';
import { ZardSelectImports } from '@openfolia/ui/select';

import { languageName } from '../../content/browser-model';
import { idParam, injectQueryState } from '../../view-state';
import { LANGUAGE_TAG, setOutputLabel } from './config-model';
import { SettingsContext } from './settings-context';

/** What each output label is (a key per label). */
const LABEL_TEXTS: Readonly<Record<OutputLabelKey, string>> = {
  danger: 'editor.admin.settings.outputLabels.keys.danger',
  warning: 'editor.admin.settings.outputLabels.keys.warning',
  caution: 'editor.admin.settings.outputLabels.keys.caution',
  notice: 'editor.admin.settings.outputLabels.keys.notice',
  note: 'editor.admin.settings.outputLabels.keys.note',
  tip: 'editor.admin.settings.outputLabels.keys.tip',
  important: 'editor.admin.settings.outputLabels.keys.important',
  contents: 'editor.admin.settings.outputLabels.keys.contents',
  figure: 'editor.admin.settings.outputLabels.keys.figure',
  table: 'editor.admin.settings.outputLabels.keys.table',
  unconverted: 'editor.admin.settings.outputLabels.keys.unconverted',
  attachment: 'editor.admin.settings.outputLabels.keys.attachment',
  attachmentNote: 'editor.admin.settings.outputLabels.keys.attachmentNote',
  glossary: 'editor.admin.settings.outputLabels.keys.glossary',
  updateVersion: 'editor.admin.settings.outputLabels.keys.updateVersion',
  updateBefore: 'editor.admin.settings.outputLabels.keys.updateBefore',
  updateDuring: 'editor.admin.settings.outputLabels.keys.updateDuring',
  updateAfter: 'editor.admin.settings.outputLabels.keys.updateAfter',
};

/** The output labels in groups, each a heading over its fields. */
const GROUPS: readonly {
  readonly title: string;
  readonly keys: readonly OutputLabelKey[];
}[] = [
  {
    title: 'editor.admin.settings.outputLabels.groups.signalWords',
    keys: ['danger', 'warning', 'caution', 'notice'],
  },
  {
    title: 'editor.admin.settings.outputLabels.groups.notes',
    keys: ['note', 'tip', 'important'],
  },
  {
    title: 'editor.admin.settings.outputLabels.groups.captions',
    keys: ['figure', 'table', 'contents', 'glossary'],
  },
  {
    title: 'editor.admin.settings.outputLabels.groups.updateGuides',
    keys: ['updateVersion', 'updateBefore', 'updateDuring', 'updateAfter'],
  },
  {
    title: 'editor.admin.settings.outputLabels.groups.other',
    keys: ['unconverted', 'attachment', 'attachmentNote'],
  },
];

/**
 * Settings › Output labels: the fixed texts an output prints, per manual language (the language
 * picker on top, kept in the address as `labels`), grouped as signal words, notes, captions and
 * other. An empty field shows the built-in text as its placeholder; a text typed there replaces it
 * for that language (saved when the field is left), and "Reset to built-in" empties it again.
 */
@Component({
  selector: 'of-settings-output-labels',
  imports: [
    TranslocoPipe,
    NgIcon,
    ZardButtonComponent,
    ZardInputComponent,
    ZardSelectImports,
  ],
  viewProviders: [provideIcons({ lucideRotateCcw })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex max-w-4xl min-w-0 flex-col gap-6' },
  template: `
    @if (ctx.config()) {
      <div class="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
        <span class="text-muted-foreground text-sm">{{
          'editor.admin.settings.outputLabels.language' | transloco
        }}</span>
        <z-select
          class="w-full sm:w-64"
          zPosition="popper"
          data-slot="output-labels-language"
          [zAriaLabel]="
            'editor.admin.settings.outputLabels.language' | transloco
          "
          [zValue]="lang()"
          (zSelectionChange)="choose($any($event))"
        >
          @for (l of languages(); track l) {
            <z-select-item [zValue]="l">{{ name(l) }} ({{ l }})</z-select-item>
          }
        </z-select>
      </div>

      @for (g of groups; track g.title) {
        <fieldset
          class="@container m-0 flex min-w-0 flex-col gap-3 border-0 p-0"
          [attr.data-group]="g.title"
        >
          <legend class="m-0 mb-3 p-0 text-sm font-medium">
            {{ g.title | transloco }}
          </legend>
          <div class="grid min-w-0 gap-x-5 gap-y-4 @xl:grid-cols-2">
            @for (key of g.keys; track key) {
              <div
                class="flex min-w-0 flex-col gap-1.5"
                [attr.data-label]="key"
              >
                <div class="flex min-h-6 min-w-0 items-center gap-2">
                  <label
                    class="text-muted-foreground min-w-0 flex-1 text-sm break-words"
                    [for]="'output-label-' + key"
                    >{{ labelText(key) | transloco }}</label
                  >
                  @if (ctx.editable() && valueOf(key) !== '') {
                    <button
                      z-button
                      zType="ghost"
                      zSize="xs"
                      type="button"
                      class="text-muted-foreground shrink-0"
                      data-slot="output-label-reset"
                      [attr.aria-label]="
                        'editor.admin.settings.outputLabels.resetOf'
                          | transloco: { label: (labelText(key) | transloco) }
                      "
                      (click)="set(key, '')"
                    >
                      <ng-icon
                        name="lucideRotateCcw"
                        data-icon="inline-start"
                        aria-hidden="true"
                      />
                      {{
                        'editor.admin.settings.outputLabels.reset' | transloco
                      }}
                    </button>
                  }
                </div>
                <input
                  z-input
                  autocomplete="off"
                  maxlength="500"
                  [id]="'output-label-' + key"
                  [attr.lang]="lang()"
                  [disabled]="!ctx.editable()"
                  [placeholder]="defaultOf(key)"
                  [value]="valueOf(key)"
                  (change)="set(key, $any($event.target).value)"
                  (keydown.enter)="$any($event.target).blur()"
                />
              </div>
            }
          </div>
        </fieldset>
      }
    }
  `,
})
export class OutputLabelsTopicPage {
  protected readonly ctx = inject(SettingsContext);
  private readonly language = inject(LanguageService);
  private readonly view = injectQueryState({ labels: idParam(LANGUAGE_TAG) });

  protected readonly groups = GROUPS;
  protected readonly languages = computed(() => {
    const c = this.ctx.config();
    return c ? [c.languages.source, ...c.languages.targets] : [];
  });
  /** The language shown: the one chosen while it is configured, else the source language. */
  protected readonly lang = computed(() => {
    const chosen = this.view.get('labels')();
    return chosen !== undefined && this.languages().includes(chosen)
      ? chosen
      : (this.ctx.config()?.languages.source ?? 'en');
  });

  protected name(tag: string): string {
    return languageName(this.language.locale(), tag);
  }

  protected choose(tag: string): void {
    this.view.set({ labels: tag }, { replace: true });
  }

  protected labelText(key: OutputLabelKey): string {
    return LABEL_TEXTS[key];
  }

  protected defaultOf(key: OutputLabelKey): string {
    const lang = this.lang();
    const base = lang.split('-')[0] ?? lang;
    return (
      DEFAULT_OUTPUT_LABELS[lang]?.[key] ??
      DEFAULT_OUTPUT_LABELS[base]?.[key] ??
      DEFAULT_OUTPUT_LABELS.en[key]
    );
  }

  protected valueOf(key: OutputLabelKey): string {
    return this.ctx.config()?.outputLabels[this.lang()]?.[key] ?? '';
  }

  protected set(key: OutputLabelKey, value: string): void {
    const c = this.ctx.config();
    if (!c || value.trim() === this.valueOf(key)) return;
    this.ctx.save(
      setOutputLabel(c, this.lang(), key, value),
      translated('editor.admin.settings.changes.outputLabel', {
        language: this.name(this.lang()),
      }),
    );
  }
}
