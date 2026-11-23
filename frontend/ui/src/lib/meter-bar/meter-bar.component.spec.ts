import { TestBed } from '@angular/core/testing';

import { MeterBarComponent } from './meter-bar.component';

describe('MeterBarComponent', () => {
  const render = (value: number, label = '', valueText = '') => {
    const fixture = TestBed.createComponent(MeterBarComponent);
    fixture.componentRef.setInput('value', value);
    fixture.componentRef.setInput('label', label);
    fixture.componentRef.setInput('valueText', valueText);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  };

  it('is a meter with its value, name and text', () => {
    const el = render(75, 'Share', '75 %');
    expect(el.getAttribute('role')).toBe('meter');
    expect(el.getAttribute('aria-valuenow')).toBe('75');
    expect(el.getAttribute('aria-valuemin')).toBe('0');
    expect(el.getAttribute('aria-valuemax')).toBe('100');
    expect(el.getAttribute('aria-label')).toBe('Share');
    expect(el.getAttribute('aria-valuetext')).toBe('75 %');
    const fill = el.querySelector<HTMLElement>('[data-slot="meter-bar-fill"]');
    expect(fill?.style.width).toBe('75%');
  });

  it('keeps the value between 0 and 100', () => {
    expect(render(140).getAttribute('aria-valuenow')).toBe('100');
    expect(render(-3).getAttribute('aria-valuenow')).toBe('0');
    expect(render(Number.NaN).getAttribute('aria-valuenow')).toBe('0');
    expect(render(12).hasAttribute('aria-label')).toBe(false);
  });

  it('colours the fill by its tone, success by default', () => {
    const fill = (el: HTMLElement) =>
      el.querySelector<HTMLElement>('[data-slot="meter-bar-fill"]');
    expect(fill(render(10))?.classList).toContain('bg-success');
    const fixture = TestBed.createComponent(MeterBarComponent);
    fixture.componentRef.setInput('value', 90);
    fixture.componentRef.setInput('tone', 'warning');
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(fill(el)?.classList).toContain('bg-warning');
    expect(fill(el)?.classList).not.toContain('bg-success');
  });
});
