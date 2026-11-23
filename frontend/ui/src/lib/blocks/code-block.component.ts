import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCodeXml } from '@ng-icons/lucide';

/**
 * Preformatted text (console output, configuration, code): a muted box in the monospace font that
 * keeps every space and line break. The header shows `label` (the block's name) and the
 * language, when there is one; controls projected with the `header` attribute sit at its end.
 * The text is the projected content: `<pre>` text, or an editor's editable content.
 */
@Component({
  selector: 'of-code-block',
  imports: [NgIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideCodeXml })],
  host: {
    role: 'group',
    '[attr.aria-label]': 'label()',
    class: 'block overflow-hidden rounded-md border border-border bg-muted',
  },
  template: `
    <div
      class="flex min-w-0 flex-wrap items-center gap-1.5 border-b border-border px-3 py-1 text-xs text-muted-foreground"
    >
      <ng-icon name="lucideCodeXml" class="shrink-0" aria-hidden="true" />
      <span class="font-medium">{{ label() }}</span>
      @if (language()) {
        <span class="font-mono break-all" data-language>{{ language() }}</span>
      }
      <ng-content select="[header]" />
    </div>
    <div
      class="overflow-x-auto px-3 py-2 font-mono text-[0.8125rem] leading-5 whitespace-pre-wrap text-foreground [overflow-wrap:anywhere] [tab-size:2]"
    >
      <ng-content />
    </div>
  `,
})
export class CodeBlockComponent {
  /** The block's name ("Code"). */
  readonly label = input.required<string>();
  /** The source language ("yaml"), or empty for none. */
  readonly language = input('');
}
