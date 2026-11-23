import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { ZardButtonComponent } from './button.component';

@Component({
  imports: [ZardButtonComponent],
  template: `<button
    z-button
    [zType]="type"
    [zDisabled]="disabled"
    class="extra"
  >
    Save
  </button>`,
})
class Host {
  type: 'default' | 'destructive' = 'default';
  disabled = false;
}

@Component({
  imports: [ZardButtonComponent],
  template: `<a z-button href="/x">Go</a>`,
})
class LinkHost {}

@Component({
  imports: [ZardButtonComponent],
  template: `<button z-button zLoading>Save</button>`,
})
class LoadingHost {}

describe('ZardButtonComponent', () => {
  it('renders its label and the theme-backed variant classes', async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const button = fixture.nativeElement.querySelector(
      'button',
    ) as HTMLButtonElement;
    expect(button.textContent?.trim()).toBe('Save');
    expect(button.dataset['variant']).toBe('default');
    expect(button.className).toContain('bg-primary');
    expect(button.className).toContain('extra');
  });

  it('switches variant and marks itself disabled', async () => {
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.type = 'destructive';
    fixture.componentInstance.disabled = true;
    await fixture.whenStable();
    const button = fixture.nativeElement.querySelector(
      'button',
    ) as HTMLButtonElement;
    expect(button.dataset['variant']).toBe('destructive');
    expect(button.className).toContain('text-destructive');
    expect(button.dataset['disabled']).not.toBeUndefined();
    expect(button.hasAttribute('disabled')).toBe(true);
  });

  it('keeps native role and tabindex on a link host', async () => {
    const fixture = TestBed.createComponent(LinkHost);
    await fixture.whenStable();
    const link = fixture.nativeElement.querySelector('a') as HTMLAnchorElement;
    expect(link.hasAttribute('role')).toBe(false);
    expect(link.hasAttribute('tabindex')).toBe(false);
  });

  it('marks itself busy while loading', async () => {
    const fixture = TestBed.createComponent(LoadingHost);
    await fixture.whenStable();
    const button = fixture.nativeElement.querySelector(
      'button',
    ) as HTMLButtonElement;
    expect(button.getAttribute('aria-busy')).toBe('true');
  });
});
