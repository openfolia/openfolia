import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';

import { ZardBadgeComponent } from '@openfolia/ui/badge';
import {
  DiffDeletedComponent,
  DiffInsertedComponent,
} from '@openfolia/ui/diff-marks';
import { injectTranslate } from '@openfolia/ui/i18n';
import {
  SegmentedComponent,
  type SegmentedOption,
} from '@openfolia/ui/segmented';
import { languageDirection } from '@openfolia/content-model/core';

import { KIND_KEYS } from '../review/diff-nodes.component';
import { TranslationsSource } from './translations-source';
import {
  reasonText,
  sourceSides,
  UNIT_STATE_BADGE,
  UNIT_STATE_TEXT,
  type Decision,
  type ReportUnit,
} from './import-model';

/**
 * One unit of a translation import's report: its state (a word on a badge, never colour alone),
 * what it is, and why it is refused. A `source-changed` unit shows the source as it was sent and
 * as it is now side by side, with the review's diff marks, the translation under them, and the
 * decision: import it (it stays outdated) or skip it.
 */
@Component({
  selector: 'of-import-unit',
  imports: [
    TranslocoPipe,
    DiffDeletedComponent,
    DiffInsertedComponent,
    SegmentedComponent,
    ZardBadgeComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'flex min-w-0 flex-col gap-2',
    '[attr.data-state]': 'unit().state',
    '[attr.data-block]': 'unit().blockId',
  },
  template: `
    @let u = unit();
    <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <z-badge [zType]="badge()" data-slot="unit-state">{{
        stateText() | transloco
      }}</z-badge>
      <span class="min-w-0 text-sm font-medium break-words">{{
        kindText()
      }}</span>
      <code
        class="text-muted-foreground min-w-0 font-mono text-xs [overflow-wrap:anywhere]"
        >{{ u.blockId }}</code
      >
    </div>

    @if (reason(); as key) {
      <p
        class="text-muted-foreground m-0 text-sm break-words"
        data-slot="reason"
      >
        {{ key | transloco }}
        @if (u.state === 'broken-markup') {
          {{ 'editor.translations.importScreen.reason.resend' | transloco }}
        }
      </p>
    }

    @if (u.state === 'source-changed') {
      <p class="text-muted-foreground m-0 text-sm break-words">
        {{
          'editor.translations.importScreen.changed.explain'
            | transloco: { language: sourceLanguage() }
        }}
      </p>
      @if (sides(); as s) {
        <div class="grid min-w-0 gap-2 md:grid-cols-2" data-slot="sources">
          <figure
            class="border-border bg-muted/40 m-0 min-w-0 rounded-md border px-3 py-2"
          >
            <figcaption class="text-muted-foreground mb-1 text-xs font-medium">
              {{
                'editor.translations.importScreen.changed.before' | transloco
              }}
            </figcaption>
            <p
              class="m-0 text-sm whitespace-pre-line break-words [overflow-wrap:anywhere]"
              [attr.lang]="sourceLang()"
              [attr.dir]="sourceDir()"
              data-slot="before"
            >
              @for (seg of s.before; track $index) {
                @if (seg.op === 'del') {
                  <del of-diff-deleted>{{ seg.text }}</del>
                } @else {
                  <span>{{ seg.text }}</span>
                }
              }
            </p>
          </figure>
          <figure
            class="border-border bg-muted/40 m-0 min-w-0 rounded-md border px-3 py-2"
          >
            <figcaption class="text-muted-foreground mb-1 text-xs font-medium">
              {{ 'editor.translations.importScreen.changed.after' | transloco }}
            </figcaption>
            <p
              class="m-0 text-sm whitespace-pre-line break-words [overflow-wrap:anywhere]"
              [attr.lang]="sourceLang()"
              [attr.dir]="sourceDir()"
              data-slot="after"
            >
              @if (s.after.length === 0) {
                <span class="text-muted-foreground">{{
                  'editor.translations.importScreen.changed.noText' | transloco
                }}</span>
              }
              @for (seg of s.after; track $index) {
                @if (seg.op === 'ins') {
                  <ins of-diff-inserted>{{ seg.text }}</ins>
                } @else {
                  <span>{{ seg.text }}</span>
                }
              }
            </p>
          </figure>
          <figure
            class="border-border m-0 min-w-0 rounded-md border px-3 py-2 md:col-span-2"
          >
            <figcaption class="text-muted-foreground mb-1 text-xs font-medium">
              {{
                'editor.translations.importScreen.changed.translation'
                  | transloco: { language: targetLanguage() }
              }}
            </figcaption>
            <p
              class="m-0 text-sm whitespace-pre-line break-words [overflow-wrap:anywhere]"
              [attr.lang]="lang()"
              [attr.dir]="targetDir()"
              data-slot="target"
            >
              {{ u.texts?.target }}
            </p>
          </figure>
        </div>
        @if (u.texts?.truncated) {
          <p class="text-muted-foreground m-0 text-xs">
            {{
              'editor.translations.importScreen.changed.truncated' | transloco
            }}
          </p>
        }
      } @else {
        <p class="text-muted-foreground m-0 text-xs" data-slot="no-texts">
          {{ 'editor.translations.importScreen.changed.noTexts' | transloco }}
        </p>
      }
      <of-segmented
        class="self-start"
        data-slot="decision"
        [options]="options()"
        [value]="decision()"
        (valueChange)="choose($event)"
        [label]="
          'editor.translations.importScreen.changed.decisionLabel'
            | transloco: { block: u.blockId }
        "
      />
    }
  `,
})
export class ImportUnitComponent {
  readonly unit = input.required<ReportUnit>();
  /** The report row's target language. */
  readonly lang = input.required<string>();
  readonly sourceLang = input('');
  /** The configuration, where the page has it (the import's), for each side's direction. */
  private readonly source = inject(TranslationsSource, { optional: true });
  /** Each text's direction (#458): the source's and the translation's, in their own. */
  protected readonly sourceDir = computed(() =>
    this.sourceLang()
      ? languageDirection(this.sourceLang(), this.source?.config())
      : null,
  );
  protected readonly targetDir = computed(() =>
    languageDirection(this.lang(), this.source?.config()),
  );
  /** The languages' names in the UI language. */
  readonly sourceLanguage = input('');
  readonly targetLanguage = input('');
  readonly decision = input<Decision>('keep');
  readonly decide = output<Decision>();

  private readonly t = injectTranslate();

  protected readonly badge = computed(
    () => UNIT_STATE_BADGE[this.unit().state],
  );
  protected readonly stateText = computed(
    () => UNIT_STATE_TEXT[this.unit().state],
  );
  protected readonly reason = computed(() => reasonText(this.unit()));
  protected readonly kindText = computed(() => {
    const kind = this.unit().kind;
    const key = kind === undefined ? undefined : KIND_KEYS[kind];
    return key
      ? this.t(key)
      : this.t('editor.translations.importScreen.unit.unknownKind');
  });
  protected readonly sides = computed(() => {
    const texts = this.unit().texts;
    return texts ? sourceSides(texts.exported, texts.current) : null;
  });
  protected readonly options = computed((): SegmentedOption[] => [
    {
      value: 'keep',
      label: this.t('editor.translations.importScreen.changed.keep'),
    },
    {
      value: 'skip',
      label: this.t('editor.translations.importScreen.changed.skip'),
    },
  ]);

  protected choose(value: string): void {
    if ((value === 'keep' || value === 'skip') && value !== this.decision()) {
      this.decide.emit(value);
    }
  }
}
