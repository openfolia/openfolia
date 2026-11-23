import { ApplicationRef, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, vi } from 'vitest';

import {
  SidePanelComponent,
  SidePanelContentDirective,
} from './side-panel.component';

interface Item {
  id: string;
  name: string;
}

@Component({
  imports: [SidePanelComponent, SidePanelContentDirective],
  template: `
    <button type="button" id="opener">Open</button>
    <of-side-panel class="[--of-side-panel-gap:1rem]">
      <ng-template [ofSidePanelContent]="item()" let-item>
        <aside aria-label="Details" class="detail">
          <span class="name">{{ item.name }}</span>
          <button type="button" class="close">Close</button>
        </aside>
      </ng-template>
    </of-side-panel>
  `,
})
class HostComponent {
  readonly item = signal<Item | null>(null);
}

const A: Item = { id: 'a', name: 'Pump' };
const B: Item = { id: 'b', name: 'Valve' };

async function setup(initial: Item | null = null) {
  const fixture = TestBed.createComponent(HostComponent);
  fixture.componentInstance.item.set(initial);
  await render(fixture);
  const root = fixture.nativeElement as HTMLElement;
  const panel = root.querySelector('of-side-panel') as HTMLElement;
  const opener = root.querySelector('#opener') as HTMLButtonElement;
  /** Shows `item`; `byPerson` (default): right after a click on the opener, as a person does. */
  const set = async (item: Item | null, byPerson = true) => {
    if (byPerson) {
      opener.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    }
    fixture.componentInstance.item.set(item);
    await render(fixture);
  };
  const names = () =>
    [...panel.querySelectorAll('.name')].map((n) => n.textContent);
  return { fixture, panel, set, names, opener };
}

async function render(fixture: { detectChanges(): void }) {
  fixture.detectChanges();
  await TestBed.inject(ApplicationRef).whenStable();
  fixture.detectChanges();
}

function endWidth(panel: HTMLElement, target: HTMLElement = panel) {
  const event = new Event('transitionend', { bubbles: true });
  Object.defineProperty(event, 'propertyName', { value: 'width' });
  target.dispatchEvent(event);
}

function reduceMotion() {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: query.includes('reduce'),
        media: query,
      }) as MediaQueryList,
  );
}

describe('SidePanelComponent', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('is gone while closed: nothing rendered, no space taken', async () => {
    const { panel } = await setup();
    expect(panel.getAttribute('data-state')).toBe('closed');
    expect(panel.classList).toContain('hidden');
    expect(panel.querySelector('aside')).toBeNull();
  });

  it('is open at once when created open, focus left where it is', async () => {
    const { panel, names } = await setup(A);
    expect(panel.getAttribute('data-state')).toBe('open');
    expect(panel.classList).not.toContain('hidden');
    expect(panel.style.width).toBe('var(--of-side-panel-width, 20rem)');
    expect(names()).toEqual(['Pump']);
    expect(document.activeElement).toBe(document.body);
  });

  it('opens by growing from no width, and moves focus into the panel', async () => {
    const { panel, set, opener } = await setup();
    opener.focus();
    await set(A);
    expect(panel.getAttribute('data-state')).toBe('open');
    expect(panel.style.width).toBe('var(--of-side-panel-width, 20rem)');
    expect(panel.style.marginInlineStart).toBe('');
    expect(panel.classList).toContain('transition-[width,margin-inline-start]');
    expect(panel.classList).toContain('motion-reduce:transition-none');
    const aside = panel.querySelector('aside')!;
    expect(document.activeElement).toBe(aside);
    expect(aside.getAttribute('tabindex')).toBe('-1');
  });

  it("opens at once and leaves focus alone when the item comes without the person (a deep link's data)", async () => {
    const { panel, set, opener } = await setup();
    opener.focus();
    await set(A, false);
    expect(panel.getAttribute('data-state')).toBe('open');
    expect(panel.style.width).toBe('var(--of-side-panel-width, 20rem)');
    expect(document.activeElement).toBe(opener);
  });

  it('never takes focus from a text field, even right after a key press', async () => {
    const { panel, set, fixture } = await setup();
    const field = document.createElement('input');
    (fixture.nativeElement as HTMLElement).appendChild(field);
    field.focus();
    field.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
    await set(A, false);
    expect(panel.getAttribute('data-state')).toBe('open');
    expect(document.activeElement).toBe(field);
  });

  it('gives focus back to the clicked control when the browser did not focus it on click', async () => {
    const { panel, set, opener } = await setup();
    // Safari: the click focuses nothing; the pointerdown on the opener is all there is.
    await set(A);
    expect(document.activeElement).toBe(panel.querySelector('aside'));
    await set(null);
    expect(document.activeElement).toBe(opener);
  });

  it('keeps the opener across a reopen while closing', async () => {
    const { panel, set, opener } = await setup();
    opener.focus();
    await set(A);
    await set(null, false);
    expect(panel.getAttribute('data-state')).toBe('closing');
    await set(A);
    (panel.querySelector('.close') as HTMLElement).focus();
    await set(null, false);
    expect(document.activeElement).toBe(opener);
  });

  it('keeps the item on screen, inert, until the width has shrunk, then is gone; focus goes back', async () => {
    const { panel, set, names, opener } = await setup();
    opener.focus();
    await set(A);
    (panel.querySelector('.close') as HTMLElement).focus();

    await set(null);
    expect(panel.getAttribute('data-state')).toBe('closing');
    expect(names()).toEqual(['Pump']);
    expect(panel.style.width).toBe('var(--of-side-panel-closed-width, 0px)');
    expect(panel.style.marginInlineStart).toBe(
      'calc(-1 * var(--of-side-panel-gap, 0px))',
    );
    expect(panel.querySelector('[data-layer]')!.hasAttribute('inert')).toBe(
      true,
    );
    expect(document.activeElement).toBe(opener);

    // A transition inside the content is not the panel's.
    endWidth(panel, panel.querySelector('aside')!);
    await render({ detectChanges: () => undefined });
    expect(names()).toEqual(['Pump']);

    endWidth(panel);
    await set(null);
    expect(panel.getAttribute('data-state')).toBe('closed');
    expect(panel.querySelector('aside')).toBeNull();
    expect(panel.classList).toContain('hidden');
  });

  it('leaves focus alone on close when it is elsewhere', async () => {
    const { panel, set, opener, fixture } = await setup();
    opener.focus();
    await set(A);
    const other = document.createElement('input');
    (fixture.nativeElement as HTMLElement).appendChild(other);
    other.focus();
    await set(null);
    expect(document.activeElement).toBe(other);
    expect(panel.getAttribute('data-state')).toBe('closing');
  });

  it('is gone after a while when the closing transition never ends', async () => {
    const { panel, set } = await setup();
    await set(A);
    vi.useFakeTimers();
    await set(null);
    vi.advanceTimersByTime(300);
    await set(null);
    expect(panel.querySelector('aside')).not.toBeNull();
    vi.advanceTimersByTime(200);
    await set(null);
    expect(panel.querySelector('aside')).toBeNull();
  });

  it('grows back with the same content when reopened while closing', async () => {
    const { panel, set, names } = await setup();
    await set(A);
    await set(null);
    await set(A);
    expect(panel.getAttribute('data-state')).toBe('open');
    expect(names()).toEqual(['Pump']);
    endWidth(panel);
    await set(A);
    expect(names()).toEqual(['Pump']);
    expect(panel.querySelector('[data-layer]')!.hasAttribute('inert')).toBe(
      false,
    );
  });

  it('swaps another item in place with a crossfade, without closing', async () => {
    const { panel, set, names } = await setup();
    await set(A);
    vi.useFakeTimers();
    await set(B);
    expect(panel.getAttribute('data-state')).toBe('open');
    expect(panel.style.width).toBe('var(--of-side-panel-width, 20rem)');
    expect(names()).toEqual(['Pump', 'Valve']);
    const [out, inn] = [...panel.querySelectorAll<HTMLElement>('[data-layer]')];
    expect(out!.getAttribute('aria-hidden')).toBe('true');
    expect(out!.hasAttribute('inert')).toBe(true);
    expect(out!.classList).toContain('absolute');
    expect(out!.classList).toContain('fade-out-0');
    expect(inn!.classList).toContain('fade-in-0');
    expect(inn!.hasAttribute('inert')).toBe(false);

    vi.advanceTimersByTime(250);
    await set(B);
    expect(names()).toEqual(['Valve']);
  });

  it('only updates the content when the same item comes again', async () => {
    const { panel, set, names } = await setup();
    await set(A);
    const layer = panel.querySelector('[data-layer]');
    await set({ ...A, name: 'Pump 2' });
    expect(names()).toEqual(['Pump 2']);
    expect(panel.querySelector('[data-layer]')).toBe(layer);
  });

  it('opens, swaps and closes at once under reduced motion', async () => {
    reduceMotion();
    const { panel, set, names, opener } = await setup();
    opener.focus();
    await set(A);
    expect(panel.style.width).toBe('var(--of-side-panel-width, 20rem)');
    expect(document.activeElement).toBe(panel.querySelector('aside'));

    await set(B);
    expect(names()).toEqual(['Valve']);
    expect(panel.querySelector('[data-layer]')!.className).toBe('');

    await set(null);
    expect(panel.getAttribute('data-state')).toBe('closed');
    expect(panel.querySelector('aside')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
