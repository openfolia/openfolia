import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { LogoComponent } from './logo.component';

@Component({
  imports: [LogoComponent],
  template: `<of-logo
    [variant]="variant"
    productName="Docs"
    small="s.svg"
    [smallDark]="smallDark"
    [full]="full"
    [fullDark]="fullDark"
  />`,
})
class Host {
  variant: 'small' | 'full' = 'small';
  full: string | undefined = 'f.svg';
  smallDark: string | undefined = undefined;
  fullDark: string | undefined = undefined;
}

function render(
  variant: 'small' | 'full',
  full: string | undefined,
  dark: { small?: string; full?: string } = {},
) {
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.variant = variant;
  fixture.componentInstance.full = full;
  fixture.componentInstance.smallDark = dark.small;
  fixture.componentInstance.fullDark = dark.full;
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('LogoComponent', () => {
  it('shows the small mark with the product name as its alt text', () => {
    const el = render('small', 'f.svg');
    const img = el.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('s.svg');
    expect(img.alt).toBe('Docs');
    expect(el.querySelector('span')).toBeNull();
  });

  it('shows the full logo when configured', () => {
    const el = render('full', 'f.svg');
    expect(el.querySelector('img')!.getAttribute('src')).toBe('f.svg');
    expect(el.querySelector('img')!.alt).toBe('Docs');
    expect(el.querySelector('span')).toBeNull();
  });

  it('falls back to the small mark next to the product name when there is no full logo', () => {
    const el = render('full', undefined);
    const img = el.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('s.svg');
    expect(img.alt).toBe('');
    expect(el.querySelector('span')!.textContent?.trim()).toBe('Docs');
  });

  it('shows only one image when no dark version is configured', () => {
    const imgs = render('full', 'f.svg').querySelectorAll('img');
    expect(imgs.length).toBe(1);
    expect(imgs[0]!.className).not.toContain('dark:hidden');
  });

  it('swaps in the dark version of the full logo on a dark page', () => {
    const imgs = [
      ...render('full', 'f.svg', {
        small: 's-d.svg',
        full: 'f-d.svg',
      }).querySelectorAll('img'),
    ];
    expect(imgs.map((i) => i.getAttribute('src'))).toEqual([
      'f.svg',
      'f-d.svg',
    ]);
    expect(imgs[0]!.className).toContain('dark:hidden');
    expect(imgs[1]!.className).toContain('hidden');
    expect(imgs[1]!.className).toContain('dark:block');
    expect(imgs.map((i) => i.alt)).toEqual(['Docs', 'Docs']);
  });

  it('swaps in the dark mark, also beside the product name', () => {
    const el = render('full', undefined, { small: 's-d.svg' });
    const imgs = [...el.querySelectorAll('img')];
    expect(imgs.map((i) => i.getAttribute('src'))).toEqual([
      's.svg',
      's-d.svg',
    ]);
    expect(imgs.map((i) => i.alt)).toEqual(['', '']);
    expect(el.querySelector('span')!.textContent?.trim()).toBe('Docs');
  });
});
