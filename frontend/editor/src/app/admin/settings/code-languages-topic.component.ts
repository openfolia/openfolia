import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';

import { translated, type TranslatedText } from '@openfolia/ui/i18n';
import { ToastService } from '@openfolia/ui/toast';

import {
  builtInLanguage,
  DEFAULT_CODE_LANGUAGES,
} from '../../doc-editor/blocks/code-languages';
import {
  builtInLanguages,
  ownLanguages,
  withBuiltInName,
  withOwnLanguages,
} from './code-languages-model';
import {
  optionsOf,
  setOptions,
  type ConfigOption,
  type ProjectConfig,
} from './config-model';
import {
  OptionListComponent,
  type OptionListChange,
  type OptionRow,
} from './option-list.component';
import {
  OptionNewDialogComponent,
  type NewOption,
} from './option-new-dialog.component';
import { SettingsContext } from './settings-context';
import type { SettingsTopicPage } from './settings-topics';

const KEY = 'codeLanguages' as const;
const SHIPPED: ReadonlyMap<string, string> = new Map(
  DEFAULT_CODE_LANGUAGES.map((l) => [l.id, l.label]),
);

/**
 * Settings › Code languages: the project's own languages (put in order, renamed, deleted), then
 * the built-in ones in the picker's order, each with a "Built-in" badge, in one list that scrolls
 * inside its card. Renaming a built-in one writes an entry with its ID (how the configuration
 * renames it), "Reset to …" takes that entry out again; an added language with a built-in ID is
 * that same rename. The built-in list itself is never written into the configuration.
 */
@Component({
  selector: 'of-settings-code-languages',
  imports: [TranslocoPipe, OptionListComponent, OptionNewDialogComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block max-w-4xl min-w-0' },
  template: `
    <div
      class="border-border bg-card relative max-h-[max(12rem,calc(100dvh_-_34rem_-_var(--of-sandbox-h,0px)))] min-h-0 min-w-0 overflow-y-auto rounded-xl border px-2 py-1.5 md:max-h-[max(12rem,calc(100dvh_-_24rem_-_var(--of-sandbox-h,0px)))]"
      data-slot="code-language-rows"
    >
      @if (own().length > 0) {
        <of-option-list
          data-slot="own-languages"
          maxHeight="none"
          [framed]="false"
          [items]="own()"
          [label]="
            ('editor.admin.settings.codeLanguages.own' | transloco) ?? ''
          "
          [editable]="ctx.editable()"
          (changed)="applyOwn($event)"
          (remove)="remove($event)"
        />
        <div
          class="border-border mx-1 my-1.5 border-t"
          aria-hidden="true"
        ></div>
      }
      <of-option-list
        data-slot="built-in-languages"
        maxHeight="none"
        [framed]="false"
        [sortable]="false"
        [items]="builtIn()"
        [defaults]="shipped"
        [badge]="
          ('editor.admin.settings.codeLanguages.builtIn' | transloco) ?? ''
        "
        [label]="
          ('editor.admin.settings.codeLanguages.builtInList' | transloco) ?? ''
        "
        [editable]="ctx.editable()"
        (changed)="applyBuiltIn($event)"
        (resetLabel)="reset($event)"
      />
    </div>
    <of-option-new-dialog
      rule="codeLanguages"
      [open]="adding()"
      [title]="('editor.admin.settings.add.codeLanguage' | transloco) ?? ''"
      [taken]="taken()"
      (add)="add($event)"
      (closed)="adding.set(false)"
    />
  `,
})
export class CodeLanguagesTopicPage implements SettingsTopicPage {
  protected readonly ctx = inject(SettingsContext);
  private readonly toast = inject(ToastService);

  protected readonly shipped = SHIPPED;
  private readonly configured = computed((): readonly ConfigOption[] => {
    const c = this.ctx.config();
    return c ? optionsOf(c, KEY) : [];
  });
  protected readonly own = computed((): readonly OptionRow[] =>
    ownLanguages(this.configured()),
  );
  protected readonly builtIn = computed((): readonly OptionRow[] =>
    builtInLanguages(this.configured()),
  );
  /** A configured ID is taken; a built-in one only once renamed (adding it renames it). */
  protected readonly taken = computed(() => this.configured().map((l) => l.id));
  protected readonly adding = signal(false);

  openAdd(): void {
    this.adding.set(true);
  }

  protected applyOwn(change: OptionListChange): void {
    const c = this.ctx.config();
    if (c)
      this.write(
        c,
        withOwnLanguages(optionsOf(c, KEY), change.items),
        change.what,
      );
  }

  /** A built-in one renamed in place: the one whose label changed. */
  protected applyBuiltIn(change: OptionListChange): void {
    const c = this.ctx.config();
    if (!c) return;
    const before = builtInLanguages(optionsOf(c, KEY));
    const next = change.items.reduce(
      (list, row) =>
        before.find((b) => b.id === row.id)?.label === row.label
          ? list
          : // Code languages are named in one text (the list is given no languages).
            withBuiltInName(list, row.id, row.label as string),
      optionsOf(c, KEY) as readonly ConfigOption[],
    );
    this.write(c, next, change.what);
  }

  protected reset(row: OptionRow): void {
    const c = this.ctx.config();
    const shipped = builtInLanguage(row.id);
    if (!c || !shipped) return;
    this.write(
      c,
      withBuiltInName(optionsOf(c, KEY), row.id, null),
      translated('editor.admin.settings.codeLanguages.changes.reset', {
        label: shipped.label,
      }),
      translated('editor.admin.settings.codeLanguages.done.reset', {
        label: shipped.label,
      }),
    );
  }

  protected add(given: NewOption): void {
    // Code languages are named in one text (the dialog is given no languages).
    const option = { ...given, label: given.label as string };
    const c = this.ctx.config();
    this.adding.set(false);
    if (!c) return;
    const configured = optionsOf(c, KEY);
    const shipped = builtInLanguage(option.id);
    if (!shipped) {
      this.write(
        c,
        [...configured, { id: option.id, label: option.label }],
        translated('editor.admin.settings.changes.add', {
          label: option.label,
        }),
        translated('editor.admin.settings.done.add', { label: option.label }),
      );
      return;
    }
    // A built-in ID: the same as renaming that one.
    if (option.label === shipped.label) {
      this.toast.show(
        translated('editor.admin.settings.codeLanguages.alreadyBuiltIn', {
          label: shipped.label,
        }),
        { kind: 'info' },
      );
      return;
    }
    this.write(
      c,
      withBuiltInName(configured, shipped.id, option.label),
      translated('editor.admin.settings.changes.rename', {
        label: option.label,
      }),
      translated('editor.admin.settings.codeLanguages.done.renamed', {
        builtIn: shipped.label,
        label: option.label,
      }),
    );
  }

  protected remove(row: OptionRow): void {
    this.ctx.remove(null, row.label, KEY, (c) =>
      setOptions(
        c,
        KEY,
        optionsOf(c, KEY).filter((l) => l.id !== row.id),
      ),
    );
  }

  /** Saves the list; with `done`, a toast with Undo. */
  private write(
    config: ProjectConfig,
    list: readonly ConfigOption[],
    what: TranslatedText,
    done?: TranslatedText,
  ): void {
    this.ctx.save(
      setOptions(config, KEY, list),
      what,
      done ? { part: KEY, done } : undefined,
    );
  }
}
