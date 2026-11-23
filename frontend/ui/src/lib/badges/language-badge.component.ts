import { injectTranslate } from '../i18n/text.pipe';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';

import { ZardBadgeComponent } from '../badge/badge.component';
import { type ZardBadgeTypeVariants } from '../badge/badge.variants';

/**
 * A translation's state. `translated`: there is one, its state not known to the reader (a list
 * shown to someone who may not read the translation status says only that much).
 */
export type TranslationState =
  'up-to-date' | 'outdated' | 'at-agency' | 'not-translated' | 'translated';

export const translationStates: readonly TranslationState[] = [
  'up-to-date',
  'outdated',
  'at-agency',
  'not-translated',
  'translated',
];

const labels: Record<TranslationState, string> = {
  'up-to-date': 'ui.badges.translation.upToDate',
  outdated: 'ui.badges.translation.outdated',
  'at-agency': 'ui.badges.translation.atAgency',
  'not-translated': 'ui.badges.translation.notTranslated',
  translated: 'ui.badges.translation.translated',
};
const types: Record<TranslationState, ZardBadgeTypeVariants> = {
  'up-to-date': 'success',
  outdated: 'warning',
  'at-agency': 'info',
  'not-translated': 'outline',
  translated: 'secondary',
};
/** The dot's colour in the plain legend, where there is no badge around it. */
const dotColours: Record<TranslationState, string> = {
  'up-to-date': 'text-success',
  outdated: 'text-warning',
  'at-agency': 'text-info',
  'not-translated': 'text-muted-foreground',
  translated: 'text-muted-foreground',
};
/** The dot's shape differs per state too: filled, ring, half, empty dashed, thin ring. */
const dots: Record<TranslationState, string> = {
  'up-to-date': 'bg-current',
  outdated: 'border-2 border-current',
  'at-agency': 'border-2 border-current bg-current/40',
  'not-translated': 'border border-dashed border-current',
  translated: 'border border-current',
};

/** The state of one translation: a dot and a word. The word carries the meaning, the colour only helps. */
@Component({
  selector: 'of-language-badge',
  imports: [ZardBadgeComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[attr.data-state]': 'state()',
    '[attr.title]': "display() === 'chip' ? text() : null",
    class: 'inline-flex',
  },
  template: `
    @if (display() === 'legend') {
      <span class="text-muted-foreground inline-flex items-center gap-1.5">
        <span
          [class]="
            'size-2 inline-block shrink-0 rounded-full ' +
            dotColour() +
            ' ' +
            dot()
          "
          aria-hidden="true"
        ></span>
        <span>{{ text() }}</span>
      </span>
    } @else {
      <span z-badge [zType]="type()">
        <span
          [class]="
            (display() === 'chip' ? 'size-1.5 ' : 'size-2 ') +
            'inline-block shrink-0 rounded-full ' +
            dot()
          "
          aria-hidden="true"
        ></span>
        @if (language()) {
          <span class="font-semibold uppercase">{{ language() }}</span>
        }
        <span [class.sr-only]="display() === 'chip'">{{ text() }}</span>
      </span>
    }
  `,
})
export class LanguageBadgeComponent {
  readonly state = input.required<TranslationState>();
  /** An optional language code shown before the state, e.g. "de". */
  readonly language = input('');
  readonly label = input('');
  /**
   * `dot`: a dot before the word (lists of translations); `chip`: the compact chip with the
   * language code, where the word is for screen readers and the title. Both show the dot, whose
   * shape (filled, ring, half, dashed) names the state without relying on colour. `legend`: a
   * coloured dot and the word in plain muted text, no badge (a key under a table).
   */
  readonly display = input<'dot' | 'chip' | 'legend'>('dot');
  private readonly t = injectTranslate();
  protected readonly text = computed(
    () => this.label() || this.t(labels[this.state()]),
  );
  protected readonly type = computed(() => types[this.state()]);
  protected readonly dot = computed(() => dots[this.state()]);
  protected readonly dotColour = computed(() => dotColours[this.state()]);
}
