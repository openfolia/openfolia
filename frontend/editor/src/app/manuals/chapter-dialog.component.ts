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
import {
  type LocalizedText,
  ownTextIn,
  withTextIn,
} from '@openfolia/content-model/core';
import { TranslocoPipe } from '@jsverse/transloco';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { ZardDialogImports } from '@openfolia/ui/dialog';
import { ZardInputComponent } from '@openfolia/ui/input';

import type { ProjectLanguages } from '../i18n';
import {
  LocalizedTextFieldsComponent,
  tidyText,
  typedTextIn,
} from '../shared/localized-text-fields.component';
import { headingText } from './manual-outline';

/** A chapter title: one line, as the manifest stores it. */
export const CHAPTER_TITLE_MAX = 200;

/**
 * Asks for a chapter's title: to put a row into a new chapter (`wrap`) or to rename one
 * (`rename`). The title is trimmed, one line, 1 to 200 characters, required in the source
 * language; with target languages, each may have its own (#731), an empty one falling back to the
 * source language's.
 */
@Component({
  selector: 'of-chapter-dialog',
  imports: [
    TranslocoPipe,
    ZardButtonComponent,
    ZardDialogImports,
    ZardInputComponent,
    LocalizedTextFieldsComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <z-dialog [(zVisible)]="open" class="sm:max-w-[28rem]">
      <z-dialog-header>
        <z-dialog-title>{{
          (mode() === 'rename'
            ? 'editor.manuals.chapter.renameTitle'
            : 'editor.manuals.chapter.wrapTitle'
          ) | transloco
        }}</z-dialog-title>
        <z-dialog-description>{{
          (mode() === 'rename'
            ? 'editor.manuals.chapter.renameDescription'
            : 'editor.manuals.chapter.wrapDescription'
          ) | transloco
        }}</z-dialog-description>
      </z-dialog-header>
      @if (open()) {
        <form
          id="chapter-form"
          class="flex flex-col gap-1.5"
          novalidate
          (submit)="submit($event)"
        >
          <label class="text-sm" for="chapter-title">{{
            'editor.manuals.chapter.field' | transloco
          }}</label>
          <input
            id="chapter-title"
            z-input
            autocomplete="off"
            required
            [attr.maxlength]="max"
            [attr.aria-invalid]="showError() ? 'true' : null"
            aria-describedby="chapter-title-hint"
            [attr.lang]="languages()?.source ?? null"
            [value]="title()"
            (input)="setTitle($any($event.target).value)"
          />
          <p
            id="chapter-title-hint"
            class="m-0 text-xs text-muted-foreground"
            [class.text-destructive]="showError()"
            aria-live="polite"
          >
            {{
              (showError()
                ? 'editor.manuals.chapter.required'
                : 'editor.manuals.chapter.hint'
              ) | transloco
            }}
          </p>
          @if (languages(); as langs) {
            <of-localized-text-fields
              idPrefix="chapter-title"
              mode="input"
              [text]="text()"
              [languages]="langs"
              [name]="'editor.manuals.chapter.field' | transloco"
              [showSource]="false"
              [maxlength]="max"
              (changed)="text.set($event)"
            />
          }
        </form>
      }
      <z-dialog-footer>
        <button z-button zType="ghost" type="button" z-dialog-close>
          {{ 'editor.manuals.chapter.cancel' | transloco }}
        </button>
        <button z-button type="submit" form="chapter-form">
          {{
            (mode() === 'rename'
              ? 'editor.manuals.chapter.rename'
              : 'editor.manuals.chapter.create'
            ) | transloco
          }}
        </button>
      </z-dialog-footer>
    </z-dialog>
  `,
})
export class ChapterDialogComponent {
  readonly open = model(false);
  readonly mode = input<'wrap' | 'rename'>('wrap');
  /** The title the fields start with: one text, or one per language. */
  readonly initial = input<LocalizedText>('');
  /** The project's languages: the title may be given in each (#731). Null: one text. */
  readonly languages = input<ProjectLanguages | null>(null);
  readonly save = output<LocalizedText>();

  protected readonly max = CHAPTER_TITLE_MAX;
  /** The title as typed, every language's. */
  protected readonly text = signal<LocalizedText>('');
  /** The source language's title as typed. */
  protected readonly title = computed(() =>
    headingText(this.text(), this.languages()?.source),
  );
  private readonly tried = signal(false);
  private readonly clean = computed(() =>
    this.title().replace(/\s+/g, ' ').trim(),
  );
  protected readonly showError = computed(
    () => this.tried() && this.clean() === '',
  );

  constructor() {
    effect(() => {
      if (!this.open()) return;
      const initial = this.initial();
      untracked(() => {
        this.text.set(initial);
        this.tried.set(false);
      });
    });
  }

  protected submit(event: Event): void {
    event.preventDefault();
    this.tried.set(true);
    const title = this.clean().slice(0, CHAPTER_TITLE_MAX);
    if (!title) return;
    this.save.emit(this.tidied(title));
    this.open.set(false);
  }

  protected setTitle(value: string): void {
    const langs = this.languages();
    this.text.set(
      langs
        ? typedTextIn(this.text(), langs.source, langs.source, value)
        : value,
    );
  }

  /** The title with each language's text tidied, an empty one left out. */
  private tidied(source: string): LocalizedText {
    const langs = this.languages();
    let title: LocalizedText = source;
    if (!langs) return title;
    for (const lang of langs.targets) {
      if (lang === langs.source) continue;
      const own = ownTextIn(this.text(), lang, langs.source);
      if (own && tidyText(own))
        title = withTextIn(
          title,
          lang,
          langs.source,
          tidyText(own).slice(0, CHAPTER_TITLE_MAX),
        );
    }
    return title;
  }
}
