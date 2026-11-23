import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCheck, lucideChevronDown } from '@ng-icons/lucide';
import { CodeBlockComponent } from '@openfolia/ui/blocks';
import { ZardButtonComponent } from '@openfolia/ui/button';
import { ZardCommandImports } from '@openfolia/ui/command';
import {
  ZardPopoverDirective,
  ZardPopoverImports,
} from '@openfolia/ui/popover';

import {
  codeLanguages,
  languageName,
  MAX_LANGUAGE,
  parseLanguage,
} from './code-languages';
import { DOC_BLOCKS, NODE_VIEW } from './doc-blocks-context';

export { parseLanguage } from './code-languages';

/**
 * The code block's node view (the content model's `literal`): monospace text that keeps every
 * space and line break, edited in place as plain text (no formatting; Tab inserts spaces), and its
 * optional language picked in the header: a searchable list of common languages (and the
 * project's `codeLanguages`), or a word typed in ("Use 'xyz'"). A word the model would refuse
 * (spaces, punctuation) is not offered: the picker says so.
 */
@Component({
  selector: 'of-literal-node',
  imports: [
    CodeBlockComponent,
    NgIcon,
    TranslocoPipe,
    ZardButtonComponent,
    ...ZardCommandImports,
    ...ZardPopoverImports,
  ],
  viewProviders: [provideIcons({ lucideCheck, lucideChevronDown })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <of-code-block
      [label]="'editor.docEditor.literal.label' | transloco"
      [language]="editable() ? '' : displayed()"
    >
      @if (editable()) {
        <span header class="ms-auto flex min-w-0 items-center gap-1.5">
          <span class="text-muted-foreground text-xs" [id]="labelId">{{
            'editor.docEditor.literal.language' | transloco
          }}</span>
          <button
            z-button
            zType="outline"
            zSize="sm"
            zPopover
            #trigger="zPopover"
            [zContent]="picker"
            zPlacement="bottom"
            zAlign="end"
            data-testid="code-language"
            class="h-6 max-w-44 gap-1 px-1.5 text-xs font-normal"
            [attr.aria-labelledby]="labelId + ' ' + valueId"
            (zVisibleChange)="pickerOpen($event)"
          >
            <span class="truncate" [id]="valueId">{{
              language()
                ? displayed()
                : ('editor.docEditor.literal.plain' | transloco)
            }}</span>
            <ng-icon name="lucideChevronDown" aria-hidden="true" />
          </button>
        </span>
      }
      <ng-content />
    </of-code-block>
    <ng-template #picker>
      <z-popover class="w-64 max-w-[calc(100vw-2rem)] p-0">
        <z-command
          class="rounded-none border-0 shadow-none"
          (zCommandSelected)="choose($event.value)"
        >
          <z-command-input
            data-autofocus
            [attr.maxlength]="maxLength"
            [placeholder]="'editor.docEditor.literal.search' | transloco"
            (valueChange)="query.set($event)"
          />
          <z-command-list>
            <!-- Always there (an option made while filtering would be read before its label):
                 shown and enabled only for a valid word not in the list. -->
            <z-command-option
              [zValue]="typed() ?? ''"
              [zLabel]="
                'editor.docEditor.literal.use'
                  | transloco: { word: query().trim() }
              "
              [zDisabled]="!typed()"
              [class.hidden]="!typed()"
              data-use
            />
            @if (refused()) {
              <p class="text-destructive px-2 py-1.5 text-xs" role="alert">
                {{ 'editor.docEditor.literal.invalid' | transloco }}
              </p>
            }
            <z-command-option
              [zValue]="''"
              [zLabel]="'editor.docEditor.literal.plain' | transloco"
            >
              <ng-icon
                data-slot="command-option-trailing"
                name="lucideCheck"
                aria-hidden="true"
                class="ms-auto"
                [class.invisible]="language() !== ''"
              />
            </z-command-option>
            @for (l of languages(); track l.id) {
              <z-command-option
                [zValue]="l.id"
                [zLabel]="l.label"
                [zCommand]="l.id"
              >
                <ng-icon
                  data-slot="command-option-trailing"
                  name="lucideCheck"
                  aria-hidden="true"
                  class="ms-auto"
                  [class.invisible]="!same(l.id)"
                />
              </z-command-option>
            }
          </z-command-list>
        </z-command>
      </z-popover>
    </ng-template>
  `,
})
export class LiteralNodeComponent {
  private readonly blocks = inject(DOC_BLOCKS);
  private readonly view = inject(NODE_VIEW);
  private readonly trigger = viewChild('trigger', {
    read: ZardPopoverDirective,
  });

  protected readonly editable = this.blocks.editable;
  protected readonly maxLength = MAX_LANGUAGE;
  private readonly uid = Math.random().toString(36).slice(2);
  protected readonly labelId = `literal-language-${this.uid}`;
  protected readonly valueId = `literal-language-value-${this.uid}`;
  /** What is typed in the picker's search. */
  protected readonly query = signal('');
  protected readonly language = computed(() => {
    const value = this.view.node().attrs['language'];
    return typeof value === 'string' ? value : '';
  });
  protected readonly languages = computed(() =>
    codeLanguages(this.blocks.settings().config),
  );
  protected readonly displayed = computed(() =>
    languageName(this.language(), this.languages()),
  );
  /** The typed word, offered as is when it is valid and not already in the list. */
  protected readonly typed = computed(() => {
    const word = parseLanguage(this.query());
    if (!word) return null;
    const known = this.languages().some(
      (l) => l.id.toLowerCase() === word.toLowerCase(),
    );
    return known ? null : word;
  });
  /** The typed text is no language the model takes. */
  protected readonly refused = computed(
    () => parseLanguage(this.query()) === null,
  );

  protected same(id: string): boolean {
    return id.toLowerCase() === this.language().toLowerCase();
  }

  protected pickerOpen(open: boolean): void {
    if (!open) return;
    this.query.set('');
    setTimeout(() =>
      document
        .querySelector<HTMLElement>(
          '[data-slot="popover-content"] [data-autofocus] input',
        )
        ?.focus(),
    );
  }

  protected choose(value: unknown): void {
    this.trigger()?.hide();
    if (typeof value !== 'string') return;
    // The "Use" entry with nothing valid typed is hidden and disabled; it chooses nothing.
    if (value === '' && this.query().trim() && !this.typed()) return;
    const next = parseLanguage(value);
    if (next === null) return;
    if (next !== this.language())
      this.view.setAttrs({ language: next || null });
  }
}
