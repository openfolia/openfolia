import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';

import { type Named, PeopleStates } from '../api';

/**
 * A person's name, where a screen shows who wrote, approved or said something, with a quiet
 * "(deactivated)" after it while the API says they are (`PeopleStates`, #928). Text, so it is read
 * out and never colour alone; a long name wraps and the marker stays in one piece. It ends without
 * a space, so a separator after it (`/>&nbsp;·`) never starts a line. In a sentence
 * from the translations, `injectPersonText()` says the same.
 */
@Component({
  selector: 'of-person-name',
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'min-w-0 break-words', 'data-slot': 'person' },
  template: `<span>{{ name() }}</span>
    @if (deactivated()) {
      &ngsp;<span
        class="text-muted-foreground text-xs font-normal whitespace-nowrap"
        data-slot="person-deactivated"
        >({{ 'editor.person.deactivated' | transloco }})</span
      >
    }`,
})
export class PersonNameComponent {
  private readonly people = inject(PeopleStates);

  /** Who it is, as the API names them. */
  readonly who = input.required<Named>();
  /** The name to show (`injectPersonName()`). */
  readonly name = input.required<string>();

  protected readonly deactivated = computed(() =>
    this.people.isDeactivated(this.who()),
  );
}
