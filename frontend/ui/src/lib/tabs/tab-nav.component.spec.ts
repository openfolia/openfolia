import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  provideRouter,
  Router,
  RouterLink,
  RouterLinkActive,
} from '@angular/router';

import { ZardTabLinkComponent, ZardTabNavComponent } from './tab-nav.component';

@Component({
  imports: [RouterLink, ZardTabNavComponent, ZardTabLinkComponent],
  template: `
    <nav z-tab-nav aria-label="Sections">
      <a z-tab-link routerLink="/a" [zActive]="current() === 'a'">A</a>
      <a
        z-tab-link
        routerLink="/a"
        [queryParams]="{ tab: 'b' }"
        [zActive]="current() === 'b'"
        >B</a
      >
    </nav>
  `,
})
class TabsHost {
  readonly current = signal<'a' | 'b'>('a');
}

@Component({
  imports: [
    RouterLink,
    RouterLinkActive,
    ZardTabNavComponent,
    ZardTabLinkComponent,
  ],
  template: `
    <nav z-tab-nav aria-label="Sections">
      <a z-tab-link routerLink="/" routerLinkActive [zActive]="active()"
        >Home</a
      >
    </nav>
  `,
})
class PrecedenceHost {
  readonly active = signal<boolean | undefined>(false);
}

describe('z-tab-link', () => {
  it('lets zActive win over a matching routerLinkActive, and follows the router without it', async () => {
    TestBed.configureTestingModule({
      providers: [provideRouter([{ path: '', children: [] }])],
    });
    const fixture = TestBed.createComponent(PrecedenceHost);
    await TestBed.inject(Router).navigateByUrl('/');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const link = () =>
      (fixture.nativeElement as HTMLElement).querySelector('a') as HTMLElement;
    // The route matches, but the page says no.
    expect(link().hasAttribute('data-active')).toBe(false);
    expect(link().getAttribute('aria-current')).toBeNull();
    fixture.componentInstance.active.set(undefined);
    fixture.detectChanges();
    expect(link().hasAttribute('data-active')).toBe(true);
  });

  it('is marked current by zActive when the page decides, without routerLinkActive', () => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const fixture = TestBed.createComponent(TabsHost);
    fixture.detectChanges();
    const active = () =>
      [...(fixture.nativeElement as HTMLElement).querySelectorAll('a')].map(
        (a) => a.hasAttribute('data-active'),
      );
    expect(active()).toEqual([true, false]);
    const current = () =>
      [...(fixture.nativeElement as HTMLElement).querySelectorAll('a')].map(
        (a) => a.getAttribute('aria-current'),
      );
    expect(current()).toEqual(['page', null]);
    fixture.componentInstance.current.set('b');
    fixture.detectChanges();
    expect(active()).toEqual([false, true]);
  });
});
