import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { provideZard } from '@openfolia/ui/core';

import {
  OptionListComponent,
  type OptionListChange,
  type OptionRow,
} from './option-list.component';

@Component({
  imports: [OptionListComponent],
  template: `<of-option-list
    [items]="items()"
    [editable]="editable()"
    flags="moduleType"
    [min]="1"
    usageKind="moduleType"
    [counts]="counts"
    (changed)="changes.push($event)"
    (remove)="removed.push($event)"
  />`,
})
class Host {
  readonly items = signal<readonly OptionRow[]>([
    { id: 'concept', label: 'Concept', restricted: false, snippet: false },
    { id: 'task', label: 'Task', restricted: true, snippet: false },
  ]);
  readonly editable = signal(true);
  readonly counts = new Map([['moduleType/task', { modules: 3, manuals: 0 }]]);
  readonly changes: OptionListChange[] = [];
  readonly removed: OptionRow[] = [];
}

async function render() {
  TestBed.configureTestingModule({
    providers: [provideRouter([]), provideZard()],
  });
  const fixture = TestBed.createComponent(Host);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  return { fixture, el, host: fixture.componentInstance };
}

describe('OptionListComponent', () => {
  it('lists the options with their IDs and usage, the used one linking to the content list', async () => {
    const { el } = await render();
    const rows = [...el.querySelectorAll('[data-option]')];
    expect(rows.map((r) => r.getAttribute('data-option'))).toEqual([
      'concept',
      'task',
    ]);
    const used = el.querySelector('[data-option=task] a');
    expect(used?.textContent).toContain('3 modules');
    expect(used?.getAttribute('href')).toBe('/content?type=task');
  });

  const menu = async (
    el: HTMLElement,
    fixture: { whenStable(): Promise<unknown> },
    id: string,
  ) => {
    el.querySelector<HTMLButtonElement>(
      `[data-option=${id}] [data-slot=option-menu]`,
    )?.click();
    await fixture.whenStable();
    return (slot: string) =>
      document.querySelector<HTMLElement>(`[data-action=${slot}]`);
  };

  afterEach(() =>
    document
      .querySelectorAll('[data-slot=dropdown-menu-content]')
      .forEach((m) => m.remove()),
  );

  it('reads first: labels as text, no fields, flags as badges', async () => {
    const { el } = await render();
    expect(el.querySelector('input')).toBeNull();
    expect(el.querySelector('form')).toBeNull();
    expect(
      el.querySelector('[data-option=task] [data-flag=restricted]'),
    ).not.toBeNull();
    expect(
      el.querySelector('[data-option=concept] [data-flag=restricted]'),
    ).toBeNull();
  });

  it('renames in place: a click opens the field, Enter keeps it, Escape does not', async () => {
    const { el, host, fixture } = await render();
    el.querySelector<HTMLButtonElement>(
      '[data-option=concept] [data-slot=inline-label]',
    )?.click();
    await fixture.whenStable();
    const field = el.querySelector<HTMLInputElement>(
      '[data-option=concept] [data-field=inline-label]',
    );
    if (!field) throw new Error('no field');
    field.value = '  Overview ';
    field.dispatchEvent(new Event('blur'));
    await fixture.whenStable();
    expect(host.changes[0]?.items[0]?.label).toBe('Overview');

    el.querySelector<HTMLButtonElement>(
      '[data-option=task] [data-slot=inline-label]',
    )?.click();
    await fixture.whenStable();
    const again = el.querySelector<HTMLInputElement>(
      '[data-option=task] [data-field=inline-label]',
    );
    if (!again) throw new Error('no field');
    again.value = 'Ignored';
    again.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await fixture.whenStable();
    expect(host.changes).toHaveLength(1);
    expect(
      el.querySelector('[data-option=task] [data-field=inline-label]'),
    ).toBeNull();
  });

  it('sets the flags from the row menu', async () => {
    const { el, host, fixture } = await render();
    const item = await menu(el, fixture, 'concept');
    item('option-snippet')?.click();
    await fixture.whenStable();
    expect(host.changes[0]?.items[0]).toEqual({
      id: 'concept',
      label: 'Concept',
      restricted: false,
      snippet: true,
    });
    expect(host.changes[0]?.what).toEqual(
      expect.objectContaining({ key: 'editor.admin.settings.changes.snippet' }),
    );
  });

  it('marks a module type as safety content from the row menu (#669)', async () => {
    const { el, host, fixture } = await render();
    const item = await menu(el, fixture, 'concept');
    item('option-safety')?.click();
    await fixture.whenStable();
    expect(host.changes[0]?.items[0]).toEqual({
      id: 'concept',
      label: 'Concept',
      restricted: false,
      snippet: false,
      safety: true,
    });
    expect(host.changes[0]?.what).toEqual(
      expect.objectContaining({ key: 'editor.admin.settings.changes.safety' }),
    );
  });

  it('asks before deleting from the row menu', async () => {
    const { el, host, fixture } = await render();
    (await menu(el, fixture, 'task'))('option-delete')?.click();
    expect(host.removed.map((r) => r.id)).toEqual(['task']);
  });

  it('keeps the last one when the list needs it', async () => {
    const { el, host, fixture } = await render();
    host.items.set([
      { id: 'concept', label: 'Concept', restricted: false, snippet: false },
    ]);
    await fixture.whenStable();
    const last = (await menu(el, fixture, 'concept'))('option-delete');
    expect(last?.getAttribute('aria-disabled')).toBe('true');
    last?.click();
    expect(host.removed).toHaveLength(0);
  });

  it('has no menu and no grips when it cannot be edited', async () => {
    const { el, host, fixture } = await render();
    host.editable.set(false);
    await fixture.whenStable();
    expect(el.textContent).toContain('Concept');
    expect(el.querySelector('[data-slot=option-menu]')).toBeNull();
    expect(el.querySelector('[data-slot=sortable-grip]')).toBeNull();
    expect(el.querySelector('button[data-slot=inline-label]')).toBeNull();
  });
});
