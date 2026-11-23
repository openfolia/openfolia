import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { provideZard } from '@openfolia/ui/core';

import type { ShownVariantAttribute as VariantAttribute } from '../settings/config-model';
import type { VariantSelection } from './variant-edits';
import { VariantTreeComponent } from './variant-tree.component';

@Component({
  imports: [VariantTreeComponent],
  template: `<of-variant-tree
    [attributes]="attributes"
    [selection]="selection()"
    [editable]="editable()"
    [counts]="counts"
    (choose)="chosen.push($event)"
    (reorderValues)="reordered.push($event)"
    (newAttribute)="added = added + 1"
  />`,
})
class Host {
  readonly attributes: readonly VariantAttribute[] = [
    {
      id: 'model',
      label: 'Model',
      kind: 'enum',
      values: [
        { id: 'small', label: 'Small' },
        { id: 'large', label: 'Large', archived: true },
      ],
    },
    { id: 'firmware', label: 'Firmware', kind: 'version' },
  ];
  readonly selection = signal<VariantSelection | null>({
    attribute: 'model',
    value: 'small',
  });
  readonly editable = signal(true);
  readonly counts = new Map([
    ['variantValue/model/small', { modules: 2, manuals: 1 }],
  ]);
  readonly chosen: VariantSelection[] = [];
  readonly reordered: { attribute: string; ids: readonly string[] }[] = [];
  added = 0;
}

async function render() {
  TestBed.configureTestingModule({ providers: [provideZard()] });
  const fixture = TestBed.createComponent(Host);
  await fixture.whenStable();
  return {
    fixture,
    host: fixture.componentInstance,
    el: fixture.nativeElement as HTMLElement,
  };
}

describe('VariantTreeComponent', () => {
  it('lists the attributes with their values, the archived one marked, the chosen one current', async () => {
    const { el } = await render();
    const attributes = [...el.querySelectorAll('[data-attribute]')].map((a) =>
      a.getAttribute('data-attribute'),
    );
    expect(attributes).toEqual(['model', 'firmware']);
    const small = el.querySelector('[data-value=small]');
    expect(small?.getAttribute('aria-current')).toBe('true');
    expect(small?.textContent).toContain('3');
    expect(el.querySelector('[data-value=large]')?.textContent).toContain(
      'Archived',
    );
    expect(
      el.querySelector('[data-attribute=firmware]')?.textContent,
    ).toContain('Version');
  });

  it('chooses an attribute or a value', async () => {
    const { el, host } = await render();
    el.querySelector<HTMLButtonElement>('[data-value=large]')?.click();
    el.querySelector<HTMLButtonElement>(
      '[data-attribute=firmware] button:not([data-slot])',
    )?.click();
    expect(host.chosen).toEqual([
      { attribute: 'model', value: 'large' },
      { attribute: 'firmware' },
    ]);
  });

  it('moves a value with Alt+Arrow keys on its grip', async () => {
    const { el, host } = await render();
    const grip = el.querySelector<HTMLButtonElement>(
      '[data-attribute=model] li[data-id=small] [data-slot=sortable-grip]',
    );
    grip?.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        altKey: true,
        bubbles: true,
      }),
    );
    expect(host.reordered).toEqual([
      { attribute: 'model', ids: ['large', 'small'] },
    ]);
  });

  it('offers no grips and no new attribute where it cannot be edited', async () => {
    const { el, fixture, host } = await render();
    el.querySelector<HTMLButtonElement>('[data-slot=new-attribute]')?.click();
    expect(host.added).toBe(1);
    host.editable.set(false);
    await fixture.whenStable();
    expect(el.querySelector('[data-slot=sortable-grip]')).toBeNull();
    expect(el.querySelector('[data-slot=new-attribute]')).toBeNull();
  });
});
