import {
  computed,
  inject,
  Injectable,
  Pipe,
  type PipeTransform,
  type Signal,
} from '@angular/core';
import {
  type ConfigLabelsIn,
  type LabelledConfig,
  labelsIn,
  type LocalizedText,
  type ProjectConfig,
  textIn,
  variantLabel,
} from '@openfolia/content-model/core';
import { LanguageService } from '@openfolia/ui/i18n';

/**
 * A configuration as a screen shows it (#731, `labelsInUi`): every configured label one text, in
 * the interface language.
 */
export type ShownConfig = ConfigLabelsIn<ProjectConfig>;

/** The project's languages, as a configuration names them. */
export interface ProjectLanguages {
  readonly source: string;
  readonly targets: readonly string[];
}

/**
 * The content language whose texts an interface in `ui` shows (#731): `ui` itself when the
 * project has it, else a project language of the same base language (`de-AT` for `de`), else
 * `ui` (whose texts then fall back to the source language's).
 */
export function labelLanguage(
  languages: ProjectLanguages | null | undefined,
  ui: string,
): string {
  if (!languages) return ui;
  const all = [languages.source, ...(languages.targets ?? [])];
  if (all.includes(ui)) return ui;
  const base = ui.split('-')[0];
  return all.find((l) => l.split('-')[0] === base) ?? ui;
}

/**
 * The texts the project writes per language (#731: a manual's or a group's title, a configured
 * label), shown in the interface language: its own version there, else the source language's.
 * Everything it gives reads the interface language, so a `computed` or a template that calls it
 * follows a language switch without a reload.
 */
@Injectable({ providedIn: 'root' })
export class UiTexts {
  private readonly language = inject(LanguageService);

  /** The interface language (the pseudo-locale counts as English). */
  readonly ui = this.language.locale;

  /**
   * The project's languages as the last configuration shown here named them: the source language
   * for a text shown where no configuration is at hand (a list of manuals). Not a signal: the
   * source language does not change while the editor is open, and reading it must not write one.
   */
  private known: ProjectLanguages | null = null;

  /**
   * `text` in the interface language, falling back to `source` (the project's source language).
   * Without `languages`, the ones of the last configuration shown (`labels`); before any, a text
   * written per language shows its version in the interface language, else its first version.
   */
  text(
    text: LocalizedText | null | undefined,
    languages?: ProjectLanguages | string | null,
  ): string {
    if (text === null || text === undefined) return '';
    if (typeof text === 'string') return text;
    const known =
      typeof languages === 'string'
        ? { source: languages, targets: [] }
        : (languages ?? this.known);
    const lang = labelLanguage(known, this.ui());
    return textIn(text, lang, known?.source ?? lang);
  }

  /**
   * A variant as people name it, in the interface language (#731, `variantLabel`): `fallback` (the
   * API's label, in the source language) while the configuration is not at hand.
   */
  variant(
    values: Readonly<Record<string, string>>,
    config:
      Pick<ProjectConfig, 'variantAttributes' | 'languages'> | null | undefined,
    fallback = '',
  ): string {
    if (!config) return fallback;
    return (
      variantLabel(
        values,
        config,
        labelLanguage(config.languages, this.ui()),
      ) || fallback
    );
  }

  /** `config` with every configured label in the interface language (`labelsIn`). */
  labels<C extends LabelledConfig & { languages: ProjectLanguages }>(
    config: C,
  ): ConfigLabelsIn<C> {
    // A configuration always names its languages; one that does not (a partial one) is shown
    // as it is.
    if (!config.languages?.source)
      return config as unknown as ConfigLabelsIn<C>;
    this.known = config.languages;
    return labelsIn(config, labelLanguage(config.languages, this.ui()));
  }
}

/**
 * A configuration read as it is stored (`raw`), shown with its labels in the interface language:
 * the screens that show labels and never edit them keep the read in `raw` and read this one.
 * Call it in an injection context.
 */
export function labelsInUi<
  C extends LabelledConfig & { languages: ProjectLanguages },
>(raw: Signal<C | null>): Signal<ConfigLabelsIn<C> | null>;
export function labelsInUi<
  C extends LabelledConfig & { languages: ProjectLanguages },
>(raw: Signal<C | null | undefined>): Signal<ConfigLabelsIn<C> | null>;
export function labelsInUi<
  C extends LabelledConfig & { languages: ProjectLanguages },
>(raw: Signal<C | null | undefined>): Signal<ConfigLabelsIn<C> | null> {
  const texts = inject(UiTexts);
  return computed(() => {
    const config = raw();
    return config ? texts.labels(config) : null;
  });
}

/**
 * `{{ manual.title | uiText }}`: a text written per language in the interface language (`UiTexts`);
 * one text as it is. Impure, so a language switch re-renders it.
 */
@Pipe({ name: 'uiText', pure: false })
export class UiTextPipe implements PipeTransform {
  private readonly texts = inject(UiTexts);

  transform(
    text: LocalizedText | null | undefined,
    languages?: ProjectLanguages | string | null,
  ): string {
    return this.texts.text(text, languages);
  }
}
