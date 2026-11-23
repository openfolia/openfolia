import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideChevronDown } from '@ng-icons/lucide';
import { TranslocoPipe } from '@jsverse/transloco';
import type { SafetySeverity } from '@openfolia/content-model/core';
import {
  SafetyNoticeComponent,
  SafetySymbolComponent,
  type SafetySymbolState,
} from '@openfolia/ui/blocks';
import { ZardDropdownImports } from '@openfolia/ui/dropdown-menu';
import { injectTranslate } from '@openfolia/ui/i18n';

import {
  DOC_BLOCKS,
  NODE_VIEW,
  SAFETY_LEVELS,
  safetyLevel,
  signalWords,
  symbolLabel,
} from './doc-blocks-context';

/** Each level's colour, as a swatch beside its word in the menu (the word says it too). */
const SWATCHES: Record<SafetySeverity, string> = {
  danger: 'bg-safety-danger',
  warning: 'bg-safety-warning',
  caution: 'bg-safety-caution',
  notice: 'bg-safety-notice',
};

/**
 * The safety notice's node view: the signal word of its level on the level's fixed safety colour
 * (configured words, in the document's language), its symbols, and the hazard with the blocks
 * that follow it (the consequence, then the measures), edited in place. One menu in the header
 * changes the level and the symbols (the configured ones). Each symbol shows its artwork beside
 * the signal word (read through the page, `symbolSource`, #208), its label as the text
 * alternative; one without artwork shows its label, marked so. The menu shows each configured
 * symbol's artwork beside its label, read as the menu's button is first approached.
 */
@Component({
  selector: 'of-safety-node',
  imports: [
    SafetyNoticeComponent,
    SafetySymbolComponent,
    NgIcon,
    TranslocoPipe,
    ...ZardDropdownImports,
  ],
  viewProviders: [provideIcons({ lucideChevronDown })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'block',
    '[style.--safety-hazard-label]': 'fieldLabels().hazard',
    '[style.--safety-consequence-label]': 'fieldLabels().consequence',
    '[style.--safety-measure-label]': 'fieldLabels().measure',
  },
  template: `
    <of-safety-notice [level]="level()" [signalWord]="word()" [body]="true">
      <span header class="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        @for (symbol of symbols(); track symbol.id) {
          <of-safety-symbol
            data-symbol
            [attr.data-symbol-id]="symbol.id"
            [label]="symbol.label"
            [state]="symbol.state"
            [src]="symbol.src"
          />
        }
        @if (editable()) {
          <button
            type="button"
            z-dropdown
            [zDropdownMenu]="menu"
            (focus)="menuNear.set(true)"
            (pointerenter)="menuNear.set(true)"
            class="ms-auto inline-flex size-6 items-center justify-center rounded-md outline-none hover:bg-current/15 focus-visible:ring-2 focus-visible:ring-current"
            [attr.aria-label]="'editor.docEditor.safety.settings' | transloco"
          >
            <ng-icon name="lucideChevronDown" aria-hidden="true" />
          </button>
          <z-dropdown-menu-content #menu class="w-60">
            <z-dropdown-menu-label>{{
              'editor.docEditor.safety.level' | transloco
            }}</z-dropdown-menu-label>
            <z-dropdown-menu-radio-group
              [zValue]="level()"
              (zValueChange)="setLevel($event)"
            >
              @for (option of levels(); track option.id) {
                <z-dropdown-menu-radio-item [zValue]="option.id">
                  <span
                    class="size-2.5 shrink-0 rounded-full"
                    [class]="option.swatch"
                    aria-hidden="true"
                  ></span>
                  {{ option.word }}
                </z-dropdown-menu-radio-item>
              }
            </z-dropdown-menu-radio-group>
            @if (configuredSymbols().length) {
              <z-dropdown-menu-separator />
              <z-dropdown-menu-label>{{
                'editor.docEditor.safety.symbols' | transloco
              }}</z-dropdown-menu-label>
              @for (symbol of configuredSymbols(); track symbol.id) {
                <z-dropdown-menu-checkbox-item
                  [zChecked]="symbolIds().includes(symbol.id)"
                  (zCheckedChange)="toggleSymbol(symbol.id, $event)"
                >
                  <of-safety-symbol
                    [compact]="true"
                    [label]="symbol.label"
                    [state]="symbol.state"
                    [src]="symbol.src"
                  />
                  {{ symbol.label }}
                </z-dropdown-menu-checkbox-item>
              }
            }
          </z-dropdown-menu-content>
        }
      </span>
      <ng-content />
    </of-safety-notice>
  `,
})
export class SafetyNodeComponent {
  private readonly blocks = inject(DOC_BLOCKS);
  private readonly view = inject(NODE_VIEW);
  private readonly t = injectTranslate();

  protected readonly editable = this.blocks.editable;
  protected readonly level = computed(() =>
    safetyLevel(this.view.node().attrs['severity']),
  );
  private readonly words = computed(() => signalWords(this.blocks.settings()));
  protected readonly word = computed(() => this.words()[this.level()]);

  protected readonly levels = computed(() =>
    SAFETY_LEVELS.map((id) => ({
      id,
      word: this.words()[id],
      swatch: SWATCHES[id],
    })),
  );

  protected readonly symbolIds = computed<string[]>(() => {
    const value = this.view.node().attrs['symbols'];
    return Array.isArray(value)
      ? value.filter((s): s is string => typeof s === 'string')
      : [];
  });
  protected readonly symbols = computed(() =>
    this.symbolIds().map((id) => this.shown(id)),
  );
  protected readonly configuredSymbols = computed(() =>
    (this.blocks.settings().config?.safetySymbols ?? []).map(({ id }) =>
      this.shown(id),
    ),
  );

  /**
   * Set once the menu's button is pointed at or focused, before it opens: from then on the
   * configured symbols' artwork is read too, so the menu shows it as it opens.
   */
  protected readonly menuNear = signal(false);
  /** Each symbol's artwork read so far: its address, or null for none. */
  private readonly artwork = signal<ReadonlyMap<string, string | null>>(
    new Map(),
  );
  private readonly requested = new Set<string>();

  constructor() {
    // Each symbol is read once (the page keeps its address); a symbol added later is read then,
    // and the ones shown keep their artwork meanwhile.
    effect(() => {
      const wanted = new Set(this.symbolIds());
      if (this.menuNear()) {
        for (const { id } of this.blocks.settings().config?.safetySymbols ??
          []) {
          wanted.add(id);
        }
      }
      const read = untracked(this.blocks.settings).symbolSource;
      for (const id of wanted) {
        if (this.requested.has(id)) continue;
        this.requested.add(id);
        const done = (src: string | null) =>
          this.artwork.update((m) => new Map(m).set(id, src));
        if (!read) done(null);
        // One that could not be read shows like one without artwork.
        else read(id).then(done, () => done(null));
      }
    });
  }

  private shown(id: string): {
    id: string;
    label: string;
    state: SafetySymbolState;
    src: string;
  } {
    const artwork = this.artwork();
    const src = artwork.get(id);
    return {
      id,
      label: symbolLabel(this.blocks.settings(), id),
      state: !artwork.has(id) ? 'loading' : src ? 'shown' : 'missing',
      src: src ?? '',
    };
  }

  /** The fields' names as CSS strings: the content shows them beside its first three blocks. */
  protected readonly fieldLabels = computed(() => ({
    hazard: JSON.stringify(this.t('ui.blocks.safety.hazard')),
    consequence: JSON.stringify(this.t('ui.blocks.safety.consequence')),
    measure: JSON.stringify(this.t('ui.blocks.safety.measure')),
  }));

  protected setLevel(value: string | undefined): void {
    const level = safetyLevel(value);
    if (level !== this.level()) this.view.setAttrs({ severity: level });
  }

  protected toggleSymbol(id: string, on: boolean): void {
    const current = this.symbolIds();
    const next = on
      ? current.includes(id)
        ? current
        : [...current, id]
      : current.filter((s) => s !== id);
    if (next !== current) this.view.setAttrs({ symbols: next });
  }
}
