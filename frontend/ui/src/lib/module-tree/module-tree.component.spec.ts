import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { ModuleTreeComponent } from './module-tree.component';
import type { ModuleTreeItem } from './module-tree.logic';

@Component({
  imports: [ModuleTreeComponent],
  template: `<of-module-tree
    [items]="items()"
    [readonly]="readonly()"
    [(selected)]="selected"
    (itemsChange)="items.set($event)"
    (activate)="opened.push($event)"
  />`,
})
class Host {
  readonly readonly = signal(false);
  readonly selected = signal<string | null>(null);
  readonly opened: string[] = [];
  readonly items = signal<readonly ModuleTreeItem[]>([
    { id: 'a', title: 'Alpha', level: 0 },
    { id: 'b', title: 'Beta', level: 0 },
    { id: 'c', title: 'Gamma', level: 1 },
  ]);
}

function setup() {
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const rows = () =>
    Array.from(el.querySelectorAll<HTMLElement>('[role=treeitem]'));
  const row = (i: number): HTMLElement => rows()[i]!;
  const press = async (row: HTMLElement, init: KeyboardEventInit) => {
    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      ...init,
    });
    row.dispatchEvent(event);
    await fixture.whenStable();
    fixture.detectChanges();
    return event;
  };
  const shape = () =>
    fixture.componentInstance
      .items()
      .map((i) => `${i.id}${i.level}`)
      .join(' ');
  return { fixture, el, rows, row, press, shape };
}

describe('ModuleTreeComponent', () => {
  it('shows numbering and levels, with one tab stop', () => {
    const { rows } = setup();
    expect(
      rows().map((r) => r.textContent?.replace(/\s+/g, ' ').trim()),
    ).toEqual(['1Alpha', '2Beta', '2.1Gamma']);
    expect(rows().map((r) => r.getAttribute('aria-level'))).toEqual([
      '1',
      '1',
      '2',
    ]);
    expect(rows().map((r) => r.tabIndex)).toEqual([0, -1, -1]);
  });

  it('indents with Tab and outdents with Shift+Tab', async () => {
    const { rows, row, press, shape } = setup();
    const event = await press(row(1), { key: 'Tab' });
    expect(event.defaultPrevented).toBe(true);
    expect(shape()).toBe('a0 b1 c2');
    await press(row(1), { key: 'Tab', shiftKey: true });
    expect(shape()).toBe('a0 b0 c1');
  });

  it('lets Tab leave the tree when the level cannot change', async () => {
    const { rows, row, press, shape } = setup();
    const first = await press(row(0), { key: 'Tab' });
    expect(first.defaultPrevented).toBe(false);
    const back = await press(row(0), { key: 'Tab', shiftKey: true });
    expect(back.defaultPrevented).toBe(false);
    expect(shape()).toBe('a0 b0 c1');
  });

  it('moves focus with the arrow keys and keeps it on a row that moves', async () => {
    const { rows, row, press, shape, fixture } = setup();
    document.body.appendChild(fixture.nativeElement);
    row(0).focus();
    await press(row(0), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(row(1));
    await press(row(1), { key: 'ArrowUp', altKey: true });
    expect(shape()).toBe('b0 c1 a0');
    expect(document.activeElement?.getAttribute('data-id')).toBe('b');
    fixture.nativeElement.remove();
  });

  it('announces the new place', async () => {
    const { rows, row, press, el } = setup();
    await press(row(1), { key: 'Tab' });
    expect(el.querySelector('[role=status]')?.textContent).toContain('1.1');
  });

  it('selects the focused row and opens it with Enter or a click on its title', async () => {
    const { row, press, fixture } = setup();
    row(1).dispatchEvent(new FocusEvent('focus'));
    fixture.detectChanges();
    expect(fixture.componentInstance.selected()).toBe('b');
    expect(row(1).getAttribute('aria-selected')).toBe('true');
    expect(row(1).tabIndex).toBe(0);
    await press(row(1), { key: 'Enter' });
    (row(2).querySelector('.cursor-pointer') as HTMLElement).click();
    expect(fixture.componentInstance.opened).toEqual(['b', 'c']);
  });

  it('follows a selection made outside', () => {
    const { row, fixture } = setup();
    fixture.componentInstance.selected.set('c');
    fixture.detectChanges();
    expect(row(2).tabIndex).toBe(0);
    expect(row(0).tabIndex).toBe(-1);
  });

  it('changes nothing while read-only, and lets Tab leave', async () => {
    const { row, press, shape, fixture, el } = setup();
    fixture.componentInstance.readonly.set(true);
    fixture.detectChanges();
    expect(el.querySelector('[cdkDragHandle]')).toBeNull();
    const tab = await press(row(1), { key: 'Tab' });
    expect(tab.defaultPrevented).toBe(false);
    await press(row(1), { key: 'ArrowUp', altKey: true });
    expect(shape()).toBe('a0 b0 c1');
  });

  it('moves the focus to a row once it is rendered', async () => {
    const { row, fixture, el } = setup();
    const tree = fixture.debugElement.children[0]!
      .componentInstance as ModuleTreeComponent;
    fixture.componentInstance.items.update((items) => [
      ...items,
      { id: 'd', title: 'Delta', level: 0 },
    ]);
    tree.focusItem('d');
    fixture.detectChanges();
    await fixture.whenStable();
    expect(el.ownerDocument.activeElement).toBe(row(3));
    expect(fixture.componentInstance.selected()).toBe('d');
  });
});
