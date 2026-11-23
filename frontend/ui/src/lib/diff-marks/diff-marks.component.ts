import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideMessageSquare } from '@ng-icons/lucide';

/**
 * Inserted text, for a review or a history view. Besides the tint it is underlined and a
 * screen reader hears "inserted", so it never relies on colour alone. Use on `<ins>`.
 */
@Component({
  selector: 'ins[of-diff-inserted]',
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class:
      'rounded-xs bg-success-muted text-success underline decoration-2 underline-offset-2',
  },
  template: `<span class="sr-only"
      >{{ label() || ('ui.diff.inserted' | transloco) }}: </span
    ><ng-content />`,
})
export class DiffInsertedComponent {
  /** Default: "Inserted", translated. */
  readonly label = input('');
}

/** Deleted text: tinted, struck through, and announced as "deleted". Use on `<del>`. */
@Component({
  selector: 'del[of-diff-deleted]',
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'rounded-xs bg-destructive-muted text-destructive line-through',
  },
  template: `<span class="sr-only"
      >{{ label() || ('ui.diff.deleted' | transloco) }}: </span
    ><ng-content />`,
})
export class DiffDeletedComponent {
  /** Default: "Deleted", translated. */
  readonly label = input('');
}

/**
 * The text a comment is anchored to: a dotted underline, a tint and a small comment icon with
 * the number of comments. Put it on a `<button>` to make it focusable and clickable.
 */
@Component({
  selector: 'button[of-comment-anchor], span[of-comment-anchor]',
  imports: [TranslocoPipe, NgIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideMessageSquare })],
  host: {
    class:
      'inline cursor-pointer rounded-xs bg-warning-muted text-foreground underline decoration-warning decoration-dotted decoration-2 underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring',
    '[class.ring-2]': 'active()',
    '[class.ring-ring]': 'active()',
  },
  template: `<ng-content /><ng-icon
      name="lucideMessageSquare"
      class="ms-0.5 align-text-top text-xs"
      aria-hidden="true"
    />
    <span class="text-xs">{{ count() }}</span><span class="sr-only">
      {{
        label() || ('ui.diff.comments' | transloco: { count: count() })
      }}</span
    >`,
})
export class CommentAnchorComponent {
  readonly count = input(1);
  /** Default: "comments" (plural by `count`), translated. */
  readonly label = input('');
  /** The comment thread this anchor belongs to is open. */
  readonly active = input(false);
}
