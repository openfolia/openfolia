import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  ViewEncapsulation,
} from '@angular/core';

import type { ClassValue } from 'clsx';

import { ZardCommand } from './command.tokens';
import { commandListVariants } from '../command/command.variants';
import { mergeClasses } from '../ui/merge-classes';

@Component({
  selector: 'z-command-list',
  template: `
    <div
      [class]="classes()"
      role="listbox"
      [id]="command?.uid + '-list'"
      data-slot="command-list"
    >
      <ng-content />
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  exportAs: 'zCommandList',
})
export class ZardCommandListComponent {
  protected readonly command = inject(ZardCommand, { optional: true });

  readonly class = input<ClassValue>('');

  protected readonly classes = computed(() =>
    mergeClasses(commandListVariants(), this.class()),
  );
}
