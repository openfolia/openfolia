import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import {
  moveItem,
  SortableListComponent,
  SortableRowDirective,
  type SortableItem,
} from './sortable-list.component';

@Component({
  imports: [SortableListComponent, SortableRowDirective],
  template: `<of-sortable-list
    label="Things"
    [items]="items()"
    [readonly]="readonly()"
    (itemsChange)="items.set($event)"
  >
    <ng-template ofSortableRow let-item let-index="index">
      <span data-row>{{ index }}:{{ item.label }}</span>
      <input [attr.aria-label]="item.label" />
    </ng-template>
  </of-sortable-list>`,
})
class Host {
  readonly readonly = signal(false);
  readonly items = signal<readonly SortableItem[]>([
    { id: 'a', label: 'Alpha' },
    { id: 'b', label: 'Beta' },
    { id: 'c', label: 'Gamma' },
  ]);
}

function setup() {
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const grips = () =>
    Array.from(
      el.querySelectorAll<HTMLButtonElement>('[data-slot=sortable-grip]'),
    );
  const press = async (target: HTMLElement, init: KeyboardEventInit) => {
    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      ...init,
    });
    target.dispatchEvent(event);
    await fixture.whenStable();
    fixture.detectChanges();
    return event;
  };
  const order = () =>
    fixture.componentInstance
      .items()
      .map((i) => i.id)
      .join('');
  return { fixture, el, grips, press, order };
}

describe('moveItem', () => {
  it('moves one item, leaving the list given unchanged', () => {
    const list = ['a', 'b', 'c'];
    expect(moveItem(list, 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveItem(list, 2, 0)).toEqual(['c', 'a', 'b']);
    expect(list).toEqual(['a', 'b', 'c']);
  });
});

describe('SortableListComponent', () => {
  it('renders each row from the template, with a named grip', () => {
    const { el, grips } = setup();
    expect(
      Array.from(el.querySelectorAll('[data-row]')).map((r) => r.textContent),
    ).toEqual(['0:Alpha', '1:Beta', '2:Gamma']);
    expect(grips().map((g) => g.getAttribute('aria-label'))).toEqual([
      'Move Alpha',
      'Move Beta',
      'Move Gamma',
    ]);
    expect(el.querySelector('ul')?.getAttribute('aria-label')).toBe('Things');
  });

  it('moves a row with Alt+Arrow keys on its grip and says where it is', async () => {
    const { el, grips, press, order } = setup();
    const down = await press(grips()[0]!, { key: 'ArrowDown', altKey: true });
    expect(down.defaultPrevented).toBe(true);
    expect(order()).toBe('bac');
    expect(el.querySelector('[role=status]')?.textContent).toBe(
      'Alpha: position 2 of 3',
    );
    await press(grips()[0]!, { key: 'ArrowUp', altKey: true });
    expect(order()).toBe('bac');
    await press(grips()[2]!, { key: 'ArrowDown', altKey: true });
    expect(order()).toBe('bac');
  });

  it('leaves other keys and the rows’ own fields alone', async () => {
    const { el, grips, press, order } = setup();
    const plain = await press(grips()[1]!, { key: 'ArrowDown' });
    expect(plain.defaultPrevented).toBe(false);
    await press(el.querySelector('input')!, { key: 'ArrowDown', altKey: true });
    expect(order()).toBe('abc');
  });

  it('shows no grips when read-only', () => {
    const { fixture, grips } = setup();
    fixture.componentInstance.readonly.set(true);
    fixture.detectChanges();
    expect(grips()).toEqual([]);
  });
});
