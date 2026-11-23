import { TestBed } from '@angular/core/testing';

import {
  CalloutOverlayComponent,
  type CalloutOverlayMarker,
  type CalloutOverlayMove,
} from './callout-overlay.component';

const MARKERS: CalloutOverlayMarker[] = [
  {
    id: 'a',
    number: 1,
    anchor: { x: 0.2, y: 0.4 },
    label: null,
    legend: 'Inlet',
  },
  {
    id: 'b',
    number: 2,
    anchor: { x: 0.5, y: 0.5 },
    label: { x: 0.8, y: 0.2 },
    legend: 'Outlet',
  },
  {
    id: 'c',
    number: null,
    anchor: { x: 0.1, y: 0.9 },
    label: null,
    legend: '',
  },
];

function mount(editable = true, adding = false) {
  const f = TestBed.createComponent(CalloutOverlayComponent);
  f.componentRef.setInput('markers', MARKERS);
  f.componentRef.setInput('editable', editable);
  f.componentRef.setInput('adding', adding);
  f.detectChanges();
  const el = f.nativeElement as HTMLElement;
  // jsdom lays nothing out: the overlay is 200 × 100 pixels at the origin.
  el.getBoundingClientRect = () => new DOMRect(0, 0, 200, 100);
  const moves: CalloutOverlayMove[] = [];
  const removed: string[] = [];
  const selected: string[] = [];
  const added: { x: number; y: number }[] = [];
  f.componentInstance.move.subscribe((m) => moves.push(m));
  f.componentInstance.remove.subscribe((id) => removed.push(id));
  f.componentInstance.selectedChange.subscribe((id) => selected.push(id));
  f.componentInstance.add.subscribe((p) => added.push(p));
  const markers = () => [
    ...el.querySelectorAll<HTMLButtonElement>('[data-slot="callout-marker"]'),
  ];
  return { f, el, moves, removed, selected, added, markers };
}

const pointer = (type: string, x: number, y: number) => {
  const event = new MouseEvent(type, {
    bubbles: true,
    clientX: x,
    clientY: y,
    button: 0,
  }) as MouseEvent & { pointerId: number };
  Object.defineProperty(event, 'pointerId', { value: 1 });
  return event;
};

describe('callout overlay', () => {
  it('draws each marker with its number at its label or anchor, a line to the anchor, and names it', () => {
    const { el, markers } = mount();
    expect(markers().map((b) => b.textContent?.trim())).toEqual([
      '1',
      '2',
      '–',
    ]);
    expect(markers()[0]?.style.left).toBe('20%');
    expect(markers()[1]?.style.left).toBe('80%');
    expect(el.querySelectorAll('line')).toHaveLength(1);
    expect(el.querySelectorAll('[data-slot="callout-anchor"]')).toHaveLength(1);
    expect(markers()[0]?.getAttribute('aria-label')).toBe('Callout 1: Inlet');
    expect(markers()[1]?.getAttribute('aria-label')).toBe(
      'Callout 2, label: Outlet',
    );
    expect(markers()[2]?.getAttribute('aria-label')).toBe(
      'Callout –, hidden in this variant',
    );
    expect(el.getAttribute('role')).toBe('group');
  });

  it('read-only, it is decoration: hidden from screen readers, out of the tab order', () => {
    const { el, markers } = mount(false);
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(markers()[0]?.tabIndex).toBe(-1);
    expect(el.classList).toContain('pointer-events-none');
  });

  it('nudges with the arrow keys, further with Shift, and removes with Delete', () => {
    const { moves, removed, markers } = mount();
    const key = (target: HTMLElement, key: string, shiftKey = false) =>
      target.dispatchEvent(
        new KeyboardEvent('keydown', { key, shiftKey, bubbles: true }),
      );
    key(markers()[0]!, 'ArrowRight');
    key(markers()[1]!, 'ArrowUp', true);
    key(markers()[0]!, 'Delete');
    expect(moves).toEqual([
      { id: 'a', which: 'anchor', point: { x: 0.21, y: 0.4 } },
      { id: 'b', which: 'label', point: { x: 0.8, y: 0.15 } },
    ]);
    expect(removed).toEqual(['a']);
  });

  it('goes on from the last nudge when keys come before the host hands the callout back', () => {
    const { moves, markers } = mount();
    const key = (k: string) =>
      markers()[0]!.dispatchEvent(
        new KeyboardEvent('keydown', { key: k, bubbles: true }),
      );
    key('ArrowRight');
    key('ArrowDown');
    expect(moves.at(-1)).toEqual({
      id: 'a',
      which: 'anchor',
      point: { x: 0.21, y: 0.41 },
    });
  });

  it('selects a callout when it gets the focus', () => {
    const { selected, markers } = mount();
    markers()[1]!.dispatchEvent(new FocusEvent('focus'));
    expect(selected).toEqual(['b']);
  });

  it('drags a marker: it follows the pointer, and the move is emitted once, on release', () => {
    const { f, moves, markers } = mount();
    const marker = markers()[0]!;
    marker.dispatchEvent(pointer('pointerdown', 40, 40));
    marker.dispatchEvent(pointer('pointermove', 100, 50));
    f.detectChanges();
    expect(markers()[0]?.style.left).toBe('50%');
    expect(moves).toEqual([]);
    marker.dispatchEvent(pointer('pointerup', 100, 50));
    expect(moves).toEqual([
      { id: 'a', which: 'anchor', point: { x: 0.5, y: 0.5 } },
    ]);
  });

  it('adds a callout where the picture is clicked, only while adding', () => {
    const { el, added } = mount(true, true);
    const area = el.querySelector<HTMLElement>(
      '[data-slot="callout-add-area"]',
    )!;
    area.dispatchEvent(pointer('pointerdown', 50, 25));
    area.dispatchEvent(pointer('pointerup', 50, 25));
    expect(added).toEqual([{ x: 0.25, y: 0.25 }]);
    expect(
      mount(true, false).el.querySelector('[data-slot="callout-add-area"]'),
    ).toBeNull();
  });

  it('names the callout hovered or focused, and null once it leaves (#549)', () => {
    const { f, el, markers } = mount(true);
    const hovered: (string | null)[] = [];
    f.componentInstance.hoverChange.subscribe((id) => hovered.push(id));
    markers()[1]!.dispatchEvent(new PointerEvent('pointerenter'));
    markers()[1]!.dispatchEvent(new PointerEvent('pointerleave'));
    el.querySelector('[data-slot="callout-anchor"]')!.dispatchEvent(
      new FocusEvent('focus'),
    );
    el.querySelector('[data-slot="callout-anchor"]')!.dispatchEvent(
      new FocusEvent('blur'),
    );
    expect(hovered).toEqual(['b', null, 'b', null]);
  });

  it('read-only, lets the pointer through to the picture and finds the marker under it by its box', async () => {
    const { f, el } = mount(false);
    const picture = document.body;
    expect(el.classList).toContain('pointer-events-none');
    // jsdom lays nothing out: the second marker is at 150–170 × 10–30.
    const marker = el.querySelectorAll<HTMLElement>(
      '[data-slot="callout-marker"]',
    )[1]!;
    marker.getBoundingClientRect = () => new DOMRect(150, 10, 20, 20);
    const hovered: (string | null)[] = [];
    f.componentInstance.hoverChange.subscribe((id) => hovered.push(id));
    const move = (x: number, y: number) =>
      picture.dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          clientX: x,
          clientY: y,
        }),
      );
    move(160, 20);
    move(162, 22);
    move(10, 90);
    move(160, 20);
    // Far off the picture, then out of the window.
    move(900, 900);
    move(160, 20);
    picture.dispatchEvent(new PointerEvent('pointerout', { bubbles: true }));
    expect(hovered).toEqual(['b', null, 'b', null, 'b', null]);
  });

  it('draws the highlighted callout larger, with a ring, its line thicker', () => {
    const { f, el, markers } = mount(false);
    f.componentRef.setInput('highlighted', 'b');
    f.detectChanges();
    const [a, b] = markers();
    expect(b!.hasAttribute('data-highlighted')).toBe(true);
    expect([...b!.classList]).toEqual(
      expect.arrayContaining(['ring-2', 'ring-ring', 'scale-125']),
    );
    expect(a!.hasAttribute('data-highlighted')).toBe(false);
    expect(a!.classList).not.toContain('ring-2');
    const line = el.querySelector('line')!;
    expect(line.getAttribute('stroke-width')).toBe('3');
    expect(line.classList).toContain('stroke-ring');
  });
});
