import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';

import { highlightSegments, type TextRange } from './highlight';

/**
 * Plain text with the stretches that matched a search marked (`<mark>`): bold and underlined
 * as well as tinted, so a match never shows by colour alone. The text is always bound as text,
 * never as HTML, so markup in it shows as written.
 */
@Component({
  selector: 'of-highlighted-text',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'break-words' },
  template: `@for (segment of segments(); track $index) {
    @if (segment.match) {
      <mark
        class="bg-accent text-foreground rounded-xs font-semibold underline decoration-1 underline-offset-2"
        >{{ segment.text }}</mark
      >
    } @else {
      <span>{{ segment.text }}</span>
    }
  }`,
})
export class HighlightedTextComponent {
  readonly text = input.required<string>();
  /** UTF-16 offsets into `text`; out of range or overlapping ones are tolerated. */
  readonly matches = input<readonly TextRange[]>([]);

  protected readonly segments = computed(() =>
    highlightSegments(this.text(), this.matches()),
  );
}
