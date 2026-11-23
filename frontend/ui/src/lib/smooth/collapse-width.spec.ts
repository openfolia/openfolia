import { ApplicationRef, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, vi } from 'vitest';

import { CollapseWidthDirective } from './collapse-width.directive';
import {
  SidePanelComponent,
  SidePanelContentDirective,
} from './side-panel.component';

/** A preview opening in the place of a details column, as in the module editor. */
@Component({
  imports: [
    CollapseWidthDirective,
    SidePanelComponent,
    SidePanelContentDirective,
  ],
  template: `
    <button type="button" id="toggle">Preview</button>
    <of-side-panel #panel fill [takeFocus]="false">
      <ng-template [ofSidePanelContent]="open() ? 'preview' : null">
        <section class="preview"><button type="button">Close</button></section>
      </ng-template>
    </of-side-panel>
    <div
      class="w-80 [--of-collapse-gap:1rem]"
      [ofCollapseWidth]="panel.opened()"
      [ofCollapseWidthInstant]="!panel.animates()"
    >
      <aside class="details"><input class="field" /></aside>
    </div>
  `,
})
class HostComponent {
  readonly open = signal(false);
}

async function render(fixture: { detectChanges(): void }) {
  fixture.detectChanges();
  await TestBed.inject(ApplicationRef).whenStable();
  fixture.detectChanges();
}

async function setup(initial = false) {
  const fixture = TestBed.createComponent(HostComponent);
  fixture.componentInstance.open.set(initial);
  await render(fixture);
  const root = fixture.nativeElement as HTMLElement;
  const panel = root.querySelector('of-side-panel') as HTMLElement;
  const column = root.querySelector(
    '[data-slot="collapse-width"]',
  ) as HTMLElement;
  const toggle = root.querySelector('#toggle') as HTMLButtonElement;
  /** Opens or closes; `byPerson` (default): right after a click on the toggle. */
  const set = async (open: boolean, byPerson = true) => {
    if (byPerson) {
      toggle.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    }
    fixture.componentInstance.open.set(open);
    await render(fixture);
  };
  return { panel, column, toggle, set, root };
}

function endWidth(panel: HTMLElement) {
  const event = new Event('transitionend', { bubbles: true });
  Object.defineProperty(event, 'propertyName', { value: 'width' });
  panel.dispatchEvent(event);
}

describe('CollapseWidthDirective beside a side panel', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is open and moves smoothly when nothing replaces it', async () => {
    const { column } = await setup();
    expect(column.getAttribute('data-state')).toBe('open');
    expect(column.style.width).toBe('');
    expect(column.hasAttribute('inert')).toBe(false);
    expect(column.classList).not.toContain('invisible');
    expect(column.classList).toContain(
      'transition-[width,margin-inline-start,opacity,visibility]',
    );
    expect(column.classList).toContain('motion-reduce:transition-none');
  });

  it('collapses while the panel grows, keeping its content; focus stays on the toggle', async () => {
    const { panel, column, toggle, set, root } = await setup();
    const details = root.querySelector('.details');
    toggle.focus();
    await set(true);
    expect(panel.getAttribute('data-state')).toBe('open');
    expect(column.getAttribute('data-state')).toBe('collapsed');
    expect(column.style.width).toBe('0px');
    expect(column.style.marginInlineStart).toBe(
      'calc(-1 * var(--of-collapse-gap, 0px))',
    );
    // Animated, both: no inline override of the transition.
    expect(column.style.transition).toBe('');
    expect(column.hasAttribute('inert')).toBe(true);
    expect(column.classList).toContain('invisible');
    expect(column.classList).toContain('opacity-0');
    // The same details, still rendered.
    expect(root.querySelector('.details')).toBe(details);
    expect(document.activeElement).toBe(toggle);
    // The content fills the panel's height.
    expect(panel.querySelector('[data-layer]')!.classList).toContain('h-full');
  });

  it('grows back as the panel shrinks; the panel stays until it has shrunk', async () => {
    const { panel, column, set, root } = await setup();
    const details = root.querySelector('.details');
    await set(true);
    await set(false);
    expect(panel.getAttribute('data-state')).toBe('closing');
    expect(panel.querySelector('.preview')).not.toBeNull();
    expect(column.getAttribute('data-state')).toBe('open');
    expect(column.style.width).toBe('');
    expect(column.style.transition).toBe('');
    expect(column.hasAttribute('inert')).toBe(false);
    endWidth(panel);
    await set(false, false);
    expect(panel.querySelector('.preview')).toBeNull();
    expect(root.querySelector('.details')).toBe(details);
  });

  it('gives focus back to the toggle when the panel closes with focus in it', async () => {
    const { panel, toggle, set } = await setup();
    toggle.focus();
    await set(true);
    panel.querySelector<HTMLButtonElement>('.preview button')!.focus();
    await set(false);
    expect(document.activeElement).toBe(toggle);
  });

  it('collapses at once when the panel opens at once (created open, not the person)', async () => {
    const { column, set } = await setup(true);
    expect(column.getAttribute('data-state')).toBe('collapsed');
    expect(column.style.transition).toBe('none');
    await set(false, false);
    // A closing is always animated unless motion is reduced.
    expect(column.getAttribute('data-state')).toBe('open');
    expect(column.style.transition).toBe('');
  });

  it('switches at once under reduced motion', async () => {
    vi.stubGlobal(
      'matchMedia',
      (query: string) =>
        ({ matches: query.includes('reduce'), media: query }) as MediaQueryList,
    );
    const { panel, column, set } = await setup();
    await set(true);
    expect(column.getAttribute('data-state')).toBe('collapsed');
    expect(column.style.transition).toBe('none');
    await set(false);
    expect(column.getAttribute('data-state')).toBe('open');
    expect(column.style.transition).toBe('none');
    expect(panel.getAttribute('data-state')).toBe('closed');
  });
});
