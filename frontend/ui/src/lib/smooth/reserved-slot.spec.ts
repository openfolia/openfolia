import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { ReservedSlotDirective } from './reserved-slot.directive';

@Component({
  imports: [ReservedSlotDirective],
  template: `
    <div role="group">
      <button type="button" class="chip">Type</button>
      <button
        type="button"
        class="reset"
        [ofReservedSlot]="filtered()"
        (click)="filtered.set(false)"
      >
        Reset filters
      </button>
      <input type="search" />
    </div>
  `,
})
class Host {
  readonly filtered = signal(false);
}

function setup() {
  const fixture = TestBed.createComponent(Host);
  document.body.appendChild(fixture.nativeElement);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const reset = el.querySelector<HTMLButtonElement>('.reset')!;
  return { fixture, el, reset };
}

describe('ReservedSlotDirective', () => {
  it('keeps its space while hidden: invisible, inert and not read, never removed', () => {
    const { fixture, reset } = setup();
    expect(reset.isConnected).toBe(true);
    expect(reset.classList).toContain('invisible');
    expect(reset.classList).toContain('opacity-0');
    expect(reset.hasAttribute('inert')).toBe(true);
    expect(reset.getAttribute('aria-hidden')).toBe('true');
    expect(reset.className).toContain('motion-reduce:transition-none');

    fixture.componentInstance.filtered.set(true);
    fixture.detectChanges();
    expect(reset.classList).not.toContain('invisible');
    expect(reset.classList).not.toContain('opacity-0');
    expect(reset.hasAttribute('inert')).toBe(false);
    expect(reset.hasAttribute('aria-hidden')).toBe(false);
  });

  it('hidden while focused, moves focus to the element before it, not to the page', () => {
    const { fixture, el, reset } = setup();
    fixture.componentInstance.filtered.set(true);
    fixture.detectChanges();
    reset.focus();
    reset.click();
    fixture.detectChanges();
    expect(document.activeElement).toBe(el.querySelector('.chip'));
    el.remove();
  });
});
