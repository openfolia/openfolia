import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCircleAlert,
  lucidePencilLine,
  lucideTriangleAlert,
} from '@ng-icons/lucide';

import { ZardSkeletonComponent } from '@openfolia/ui/skeleton';
import { FadeInDirective } from '@openfolia/ui/smooth';

import type { OutlineEntry } from './module-model';

/** The mark each block type shows in the outline, and its name (a translation key). */
const TYPES: Readonly<Record<string, { mark: string; name: string }>> = {
  // A section shows its heading level: H1, H2, … (`rows`).
  section: { mark: 'H', name: 'editor.moduleEditor.outline.types.heading' },
  paragraph: { mark: 'T', name: 'editor.moduleEditor.outline.types.paragraph' },
  list: { mark: '•', name: 'editor.moduleEditor.outline.types.list' },
  procedure: {
    mark: '1.',
    name: 'editor.moduleEditor.outline.types.procedure',
  },
  table: { mark: '▦', name: 'editor.moduleEditor.outline.types.table' },
  image: { mark: '▣', name: 'editor.moduleEditor.outline.types.image' },
  attachment: {
    mark: '⎘',
    name: 'editor.moduleEditor.outline.types.attachment',
  },
  safety: { mark: '!', name: 'editor.moduleEditor.outline.types.safety' },
  admonition: {
    mark: 'i',
    name: 'editor.moduleEditor.outline.types.admonition',
  },
  faq: { mark: '?', name: 'editor.moduleEditor.outline.types.faq' },
  variant: { mark: 'V', name: 'editor.moduleEditor.outline.types.variant' },
  moduleRef: { mark: '↳', name: 'editor.moduleEditor.outline.types.moduleRef' },
  literal: { mark: '<>', name: 'editor.moduleEditor.outline.types.literal' },
  passthrough: {
    mark: '{}',
    name: 'editor.moduleEditor.outline.types.passthrough',
  },
  pageBreak: {
    mark: '⤓',
    name: 'editor.moduleEditor.outline.types.pageBreak',
  },
};

const OTHER = { mark: '·', name: 'editor.moduleEditor.outline.types.other' };

/** A problem in the outline: at a block of it, or of the module as a whole. */
export interface OutlineProblem {
  readonly at: string | null;
  /** `draft`: a block not finished yet, a normal step of writing: muted, never red (#796). */
  readonly severity: 'error' | 'warning' | 'draft';
  readonly text: string;
}

/** The icon of each severity: never colour alone. */
const ICONS: Readonly<Record<OutlineProblem['severity'], string>> = {
  error: 'lucideCircleAlert',
  warning: 'lucideTriangleAlert',
  draft: 'lucidePencilLine',
};
/** Which problem a block shows when it has several: the worst. */
const RANK: Readonly<Record<OutlineProblem['severity'], number>> = {
  error: 2,
  warning: 1,
  draft: 0,
};

/**
 * Screen 2's outline: the module's blocks, each a button that puts the caret in it. A block with
 * a problem says so (an icon and the problem's text for a screen reader); problems of the module
 * as a whole are listed above.
 */
@Component({
  selector: 'of-module-outline',
  imports: [TranslocoPipe, NgIcon, ZardSkeletonComponent, FadeInDirective],
  viewProviders: [
    provideIcons({ lucideCircleAlert, lucidePencilLine, lucideTriangleAlert }),
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'bg-muted flex flex-col gap-0.5 rounded-2xl p-3',
  },
  template: `
    <h2
      class="text-muted-foreground m-0 px-2 pt-1 pb-2 text-xs font-normal tracking-[0.08em] uppercase"
    >
      {{ 'editor.moduleEditor.outline.title' | transloco }}
    </h2>
    @for (problem of moduleProblems(); track $index) {
      <p
        class="m-0 flex items-start gap-1.5 px-2 py-1 text-xs break-words"
        [class.text-destructive]="problem.severity === 'error'"
        [class.text-warning]="problem.severity === 'warning'"
        [class.text-muted-foreground]="problem.severity === 'draft'"
        [attr.data-problem]="problem.severity"
      >
        <ng-icon
          [name]="icons[problem.severity]"
          class="mt-0.5 shrink-0"
          size="14"
          aria-hidden="true"
        />
        <span>{{ problem.text }}</span>
      </p>
    }
    @if (loading()) {
      <div
        role="status"
        aria-busy="true"
        ofFadeIn="delayed"
        class="flex flex-col gap-0.5"
      >
        <span class="sr-only">{{ 'ui.states.loading' | transloco }}</span>
        @for (row of [1, 2, 3, 4, 5]; track row) {
          <div class="flex h-[1.875rem] items-center gap-2 px-2">
            <z-skeleton class="bg-background size-3 shrink-0" />
            <z-skeleton class="bg-background h-3.5 flex-1" />
          </div>
        }
      </div>
    } @else if (entries().length === 0) {
      <p class="text-muted-foreground m-0 px-2 py-1 text-sm">
        {{ 'editor.moduleEditor.outline.empty' | transloco }}
      </p>
    } @else {
      <ul ofFadeIn class="m-0 flex list-none flex-col gap-0.5 p-0">
        @for (entry of rows(); track entry.id) {
          <li>
            <button
              type="button"
              class="text-foreground hover:bg-background focus-visible:ring-ring flex h-[1.875rem] w-full items-center gap-1.5 rounded-md px-2 text-start text-sm outline-none focus-visible:ring-2"
              [class.bg-background]="entry.id === active()"
              [style.padding-inline-start.rem]="0.5 + entry.depth * 0.75"
              [attr.aria-current]="entry.id === active() ? 'true' : null"
              (click)="go.emit(entry.id)"
            >
              <span
                class="text-muted-foreground w-[1.125rem] shrink-0 font-mono text-[0.6875rem]"
                aria-hidden="true"
                >{{ entry.mark }}</span
              >
              <span class="sr-only"
                >{{ entry.name | transloco: entry.params }}:</span
              >
              <!-- The content's text in its own direction (issue 458), cut off at its end. -->
              <span
                class="min-w-0 flex-1 truncate"
                [attr.dir]="entry.label ? 'auto' : null"
                >{{
                  entry.label || (entry.name | transloco: entry.params)
                }}</span
              >
              @if (entry.problem; as problem) {
                <ng-icon
                  [name]="icons[problem.severity]"
                  class="shrink-0"
                  [class.text-destructive]="problem.severity === 'error'"
                  [class.text-warning]="problem.severity === 'warning'"
                  [class.text-muted-foreground]="problem.severity === 'draft'"
                  [attr.data-problem]="problem.severity"
                  size="14"
                  aria-hidden="true"
                />
                <span class="sr-only">{{ problem.text }}</span>
              }
            </button>
          </li>
        }
      </ul>
    }
  `,
})
export class ModuleOutlineComponent {
  readonly entries = input<readonly OutlineEntry[]>([]);
  readonly problems = input<readonly OutlineProblem[]>([]);
  readonly loading = input(false);
  /** The block the caret is in, or null. */
  readonly active = input<string | null>(null);
  /** Go to the block with this ID. */
  readonly go = output<string>();

  protected readonly icons = ICONS;

  /** Problems of the module itself, and of blocks the outline does not list (a list item). */
  protected readonly moduleProblems = computed(() => {
    const listed = new Set(this.entries().map((e) => e.id));
    return this.problems().filter((p) => p.at === null || !listed.has(p.at));
  });

  protected readonly rows = computed(() => {
    const byBlock = new Map<string, OutlineProblem>();
    for (const p of this.problems()) {
      if (p.at === null) continue;
      const known = byBlock.get(p.at);
      // An error outranks a warning, a warning a draft, on the same block.
      if (!known || RANK[p.severity] > RANK[known.severity]) {
        byBlock.set(p.at, p);
      }
    }
    return this.entries().map((entry) => {
      const type = TYPES[entry.type] ?? OTHER;
      // Sections nest only in sections, so a section's depth here is its heading level less one.
      const level = entry.depth + 1;
      const heading = entry.type === 'section';
      return {
        ...entry,
        mark: heading ? `${type.mark}${level}` : type.mark,
        name: type.name,
        params: { level },
        problem: byBlock.get(entry.id) ?? null,
      };
    });
  });
}
