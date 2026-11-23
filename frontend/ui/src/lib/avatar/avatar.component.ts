import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';

/** The initials of a name, at most two: "Alex Brandt" → "AB", "alex" → "A", "" → "". */
export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => [...part][0]?.toUpperCase() ?? '')
    .join('');
}

const SIZES = {
  sm: 'size-5 text-[9px]',
  md: 'size-7 text-[10px]',
  lg: 'size-8 text-[11px]',
} as const;

/**
 * A person as round initials (`<of-avatar name="Alex Brandt" />`), in the foreground colour on
 * the background's, in both themes. It is decoration: the name it stands for is shown next to
 * it, so it is hidden from screen readers. `size` `sm` (20 px), `md` (28 px, the default) or `lg`
 * (32 px).
 */
@Component({
  selector: 'of-avatar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    'data-slot': 'avatar',
    'aria-hidden': 'true',
    class:
      'bg-foreground text-background inline-flex shrink-0 items-center justify-center rounded-full font-semibold select-none',
    '[class]': 'sizeClass()',
  },
  template: `{{ initials() }}`,
})
export class AvatarComponent {
  /** The person's name (or, when no name is known, their ID). */
  readonly name = input('');
  readonly size = input<'sm' | 'md' | 'lg'>('md');

  protected readonly initials = computed(() => initialsOf(this.name()));
  protected readonly sizeClass = computed(() => SIZES[this.size()]);
}
