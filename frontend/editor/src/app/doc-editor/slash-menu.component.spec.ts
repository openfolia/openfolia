import { TestBed } from '@angular/core/testing';
import { provideZard } from '@openfolia/ui/core';

import { SlashMenuComponent } from './slash-menu.component';
import type { SlashMenuState } from './slash/slash-command';
import type { SlashItem } from './slash/slash-items';

const item = (id: string): SlashItem => ({
  id,
  label: 'editor.docEditor.slash.paragraph',
  hint: 'editor.docEditor.slash.paragraphHint',
  icon: 'lucidePilcrow',
  terms: [],
  run: () => undefined,
});

const [one, two, three] = [item('one'), item('two'), item('three')];

async function render() {
  TestBed.configureTestingModule({ providers: [provideZard()] });
  const fixture = TestBed.createComponent(SlashMenuComponent);
  await fixture.whenStable();
  const menu = fixture.componentInstance;
  const chosen: string[] = [];
  const state = (query: string, items: SlashItem[]): SlashMenuState => ({
    items,
    reasons: new Map(),
    query,
    choose: (it) => chosen.push(it.id),
    mount: () => () => undefined,
  });
  const rows = () => [
    ...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>(
      '[role="option"]',
    ),
  ];
  const enter = () =>
    menu.keyDown(new KeyboardEvent('keydown', { key: 'Enter' }));
  return { fixture, menu, state, rows, chosen, enter };
}

describe('the slash menu', () => {
  it('Enter puts in the row the pointer is on', async () => {
    const { fixture, menu, state, rows, chosen, enter } = await render();
    menu.open(state('', [one, two, three]));
    await fixture.whenStable();
    rows()[1]!.dispatchEvent(new MouseEvent('mouseenter'));
    expect(enter()).toBe(true);
    expect(chosen).toEqual(['two']);
  });

  // #578: the pointer resting over the menu while the list narrows; the browser reports it
  // entering a row of the list before, still on screen, whose place the new list has not.
  it('a row of the list before, entered after the list changed, moves nothing', async () => {
    const { fixture, menu, state, rows, chosen, enter } = await render();
    menu.open(state('', [one, two, three]));
    await fixture.whenStable();
    const stale = rows()[2]!;
    menu.update(state('t', [two]));
    stale.dispatchEvent(new MouseEvent('mouseenter'));
    expect(enter()).toBe(true);
    expect(chosen).toEqual(['two']);
  });

  it('a row of the list before that the new one still has takes its new place', async () => {
    const { fixture, menu, state, rows, chosen, enter } = await render();
    menu.open(state('', [one, two, three]));
    await fixture.whenStable();
    const stale = rows()[2]!;
    menu.update(state('t', [two, three]));
    stale.dispatchEvent(new MouseEvent('mouseenter'));
    expect(enter()).toBe(true);
    expect(chosen).toEqual(['three']);
  });

  it('the highlight stays on a row when the list shortens under it', async () => {
    const { fixture, menu, state, rows, chosen, enter } = await render();
    menu.open(state('', [one, two, three]));
    await fixture.whenStable();
    rows()[2]!.dispatchEvent(new MouseEvent('mouseenter'));
    // The same query, fewer rows (an item no longer available at the caret).
    menu.update(state('', [one, two]));
    await fixture.whenStable();
    expect(rows().map((r) => r.getAttribute('aria-selected'))).toEqual([
      'false',
      'true',
    ]);
    expect(enter()).toBe(true);
    expect(chosen).toEqual(['two']);
  });
});
