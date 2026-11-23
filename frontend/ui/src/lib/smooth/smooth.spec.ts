import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, RouterOutlet } from '@angular/router';

import { SkeletonRowsComponent } from '../states/skeleton-rows.component';
import { FadeInDirective } from './fade-in.directive';
import { RefreshingDirective } from './refreshing.directive';
import { RouteFadeDirective } from './route-fade.directive';

@Component({
  imports: [
    RouterOutlet,
    FadeInDirective,
    RefreshingDirective,
    RouteFadeDirective,
    SkeletonRowsComponent,
  ],
  template: `
    <ul id="fade" class="own" ofFadeIn></ul>
    <div id="delayed" [class]="bound()" ofFadeIn="delayed"></div>
    <ul id="region" class="m-0" [ofRefreshing]="refreshing()">
      <li><button type="button">Row</button></li>
    </ul>
    <router-outlet id="outlet" ofRouteFade />
    <of-skeleton-rows class="px-2" [count]="2" />
  `,
})
class HostComponent {
  readonly refreshing = signal(false);
  readonly bound = signal('size-10 flex');
}

function setup() {
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const byId = (id: string) => el.querySelector(`#${id}`) as HTMLElement;
  return { fixture, el, byId };
}

const classes = (e: Element) => Array.from(e.classList);

describe('smooth UI defaults', () => {
  it('fades new content in at once, keeping its own classes, and not under reduced motion', () => {
    const { byId } = setup();
    expect(classes(byId('fade'))).toEqual(
      expect.arrayContaining([
        'own',
        'animate-in',
        'fade-in-0',
        'duration-300',
        'motion-reduce:animate-none',
      ]),
    );
    expect(byId('fade').classList).not.toContain('delay-150');
  });

  it('delays a placeholder by 150 ms, merged with a bound [class], still delayed under reduced motion', () => {
    const { fixture, byId } = setup();
    const el = byId('delayed');
    expect(classes(el)).toEqual(
      expect.arrayContaining([
        'size-10',
        'flex',
        'animate-in',
        'fade-in-0',
        'delay-150',
        'fill-mode-both',
        'motion-reduce:duration-0',
      ]),
    );
    // Without a fade, but not at once: it never flashes.
    expect(el.classList).not.toContain('motion-reduce:animate-none');
    fixture.componentInstance.bound.set('h-8');
    fixture.detectChanges();
    expect(el.classList).toContain('h-8');
    expect(el.classList).not.toContain('size-10');
    expect(el.classList).toContain('delay-150');
  });

  it('gives skeleton rows the delayed fade by default, next to the caller’s classes', () => {
    const { el } = setup();
    const skeleton = el.querySelector('of-skeleton-rows') as HTMLElement;
    expect(classes(skeleton)).toEqual(
      expect.arrayContaining(['block', 'px-2', 'delay-150', 'fill-mode-both']),
    );
  });

  it('keeps a reloading region on screen, dimmed, inert and busy, and lets it go after', () => {
    const { fixture, byId } = setup();
    const region = byId('region');
    expect(region.classList).toContain('transition-opacity');
    expect(region.classList).toContain('motion-reduce:transition-none');
    expect(region.classList).not.toContain('opacity-60');
    expect(region.hasAttribute('inert')).toBe(false);
    expect(region.hasAttribute('aria-busy')).toBe(false);

    fixture.componentInstance.refreshing.set(true);
    fixture.detectChanges();
    expect(region.classList).toContain('m-0');
    expect(region.classList).toContain('opacity-60');
    expect(region.classList).toContain('pointer-events-none');
    expect(region.hasAttribute('inert')).toBe(true);
    expect(region.getAttribute('aria-busy')).toBe('true');
    expect(region.querySelector('button')).not.toBeNull();

    fixture.componentInstance.refreshing.set(false);
    fixture.detectChanges();
    expect(region.classList).not.toContain('opacity-60');
    expect(region.hasAttribute('inert')).toBe(false);
    expect(region.hasAttribute('aria-busy')).toBe(false);
  });

  it('marks a router outlet so the page after it fades in (the rule is in ui.css)', () => {
    const { byId } = setup();
    expect(byId('outlet').classList).toContain('of-route-fade');
  });
});
