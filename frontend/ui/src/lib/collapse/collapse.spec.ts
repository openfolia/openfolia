import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, vi } from 'vitest';

import { CollapseComponent } from './collapse.component';

@Component({
  imports: [CollapseComponent],
  template: `<of-collapse [open]="open()"
    ><button type="button">Child</button></of-collapse
  >`,
})
class HostComponent {
  readonly open = signal(false);
}

function setup() {
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  const host = fixture.nativeElement.querySelector(
    'of-collapse',
  ) as HTMLElement;
  const inner = host.firstElementChild as HTMLElement;
  return { fixture, host, inner };
}

function endTransition(host: HTMLElement, propertyName: string) {
  const event = new Event('transitionend', {
    bubbles: true,
  }) as TransitionEvent;
  Object.defineProperty(event, 'propertyName', { value: propertyName });
  host.dispatchEvent(event);
}

describe('CollapseComponent', () => {
  afterEach(() => vi.useRealTimers());

  it('is settled at once when created open (no transition runs then)', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.componentInstance.open.set(true);
    fixture.detectChanges();
    const host = fixture.nativeElement.querySelector(
      'of-collapse',
    ) as HTMLElement;
    expect((host.firstElementChild as HTMLElement).style.overflow).toBe(
      'visible',
    );
  });

  it('settles after a while when the opening transition never ends (hidden while it ran)', () => {
    vi.useFakeTimers();
    const { fixture, inner } = setup();
    fixture.componentInstance.open.set(true);
    fixture.detectChanges();
    expect(inner.style.overflow).toBe('hidden');
    // Not mid-grow: the transition takes 200 ms.
    vi.advanceTimersByTime(250);
    fixture.detectChanges();
    expect(inner.style.overflow).toBe('hidden');
    vi.advanceTimersByTime(400);
    fixture.detectChanges();
    expect(inner.style.overflow).toBe('visible');
  });

  it('drops the fallback when it closes first', () => {
    vi.useFakeTimers();
    const { fixture, inner } = setup();
    fixture.componentInstance.open.set(true);
    fixture.detectChanges();
    fixture.componentInstance.open.set(false);
    fixture.detectChanges();
    vi.advanceTimersByTime(1000);
    fixture.detectChanges();
    expect(inner.style.overflow).toBe('hidden');
  });

  it('stays clipped when reopened while closing (the closing transition is cancelled)', () => {
    const { fixture, host, inner } = setup();
    fixture.componentInstance.open.set(true);
    fixture.detectChanges();
    fixture.componentInstance.open.set(false);
    fixture.detectChanges();
    fixture.componentInstance.open.set(true);
    fixture.detectChanges();
    const event = new Event('transitioncancel') as TransitionEvent;
    Object.defineProperty(event, 'propertyName', {
      value: 'grid-template-rows',
    });
    host.dispatchEvent(event);
    fixture.detectChanges();
    expect(inner.style.overflow).toBe('hidden');
  });

  it('keeps closed content in the page but inert, hidden and clipped', () => {
    const { host, inner } = setup();
    expect(host.getAttribute('data-state')).toBe('closed');
    expect(host.style.gridTemplateRows).toBe('0fr');
    expect(host.hasAttribute('inert')).toBe(true);
    expect(host.getAttribute('aria-hidden')).toBe('true');
    expect(inner.style.overflow).toBe('hidden');
    expect(host.querySelector('button')).not.toBeNull();
  });

  it('opens: grows the row, drops inert, and stops clipping once the row has grown', () => {
    const { fixture, host, inner } = setup();
    fixture.componentInstance.open.set(true);
    fixture.detectChanges();
    expect(host.getAttribute('data-state')).toBe('open');
    expect(host.style.gridTemplateRows).toBe('1fr');
    expect(host.hasAttribute('inert')).toBe(false);
    expect(host.hasAttribute('aria-hidden')).toBe(false);
    expect(inner.style.overflow).toBe('hidden');

    endTransition(host, 'opacity');
    fixture.detectChanges();
    expect(inner.style.overflow).toBe('hidden');

    endTransition(host, 'grid-template-rows');
    fixture.detectChanges();
    expect(inner.style.overflow).toBe('visible');
  });

  it('clips again at once when it closes', () => {
    const { fixture, host, inner } = setup();
    fixture.componentInstance.open.set(true);
    fixture.detectChanges();
    endTransition(host, 'grid-template-rows');
    fixture.detectChanges();

    fixture.componentInstance.open.set(false);
    fixture.detectChanges();
    expect(inner.style.overflow).toBe('hidden');
    expect(host.hasAttribute('inert')).toBe(true);
  });

  it('ignores a transition that ends inside the content', () => {
    const { fixture, host, inner } = setup();
    fixture.componentInstance.open.set(true);
    fixture.detectChanges();
    endTransition(
      host.querySelector('button') as HTMLElement,
      'grid-template-rows',
    );
    fixture.detectChanges();
    expect(inner.style.overflow).toBe('hidden');
  });
});
