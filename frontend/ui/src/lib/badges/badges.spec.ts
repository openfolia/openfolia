import { TestBed } from '@angular/core/testing';

import {
  LanguageBadgeComponent,
  translationStates,
} from './language-badge.component';
import {
  contentStatuses,
  StatusBadgeComponent,
} from './status-badge.component';

describe('badges', () => {
  it.each(contentStatuses)('status %s has a word', (status) => {
    const fixture = TestBed.createComponent(StatusBadgeComponent);
    fixture.componentRef.setInput('status', status);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent?.trim().length).toBeGreaterThan(3);
  });

  it('shows the words the spec names', () => {
    const words = contentStatuses.map((status) => {
      const f = TestBed.createComponent(StatusBadgeComponent);
      f.componentRef.setInput('status', status);
      f.detectChanges();
      return (f.nativeElement as HTMLElement).textContent?.trim();
    });
    expect(words).toEqual([
      'Draft',
      'In review',
      'Approved',
      'Released',
      'Deprecated',
    ]);
  });

  it.each(translationStates)(
    'language state %s has a dot and a word',
    (state) => {
      const fixture = TestBed.createComponent(LanguageBadgeComponent);
      fixture.componentRef.setInput('state', state);
      fixture.componentRef.setInput('language', 'de');
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      expect(el.querySelector('[aria-hidden=true]')).not.toBeNull();
      expect(el.textContent).toContain('de');
      expect(el.textContent?.length).toBeGreaterThan(6);
    },
  );

  it('keeps the state word for a screen reader in the chip display', () => {
    const f = TestBed.createComponent(LanguageBadgeComponent);
    f.componentRef.setInput('state', 'outdated');
    f.componentRef.setInput('language', 'de');
    f.componentRef.setInput('display', 'chip');
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect(el.getAttribute('title')).toBe('Outdated');
    expect(el.querySelector('.sr-only')?.textContent).toBe('Outdated');
  });

  it('gives each state a differently shaped mark in the chip, not only a colour', () => {
    const shapes = translationStates.map((state) => {
      const f = TestBed.createComponent(LanguageBadgeComponent);
      f.componentRef.setInput('state', state);
      f.componentRef.setInput('language', 'de');
      f.componentRef.setInput('display', 'chip');
      f.detectChanges();
      const mark = (f.nativeElement as HTMLElement).querySelector(
        'span[aria-hidden=true]',
      );
      return [...(mark?.classList ?? [])]
        .filter((c) => c.startsWith('bg-') || c.startsWith('border'))
        .sort()
        .join(' ');
    });
    expect(new Set(shapes).size).toBe(translationStates.length);
  });

  it('takes a replacement label', () => {
    const fixture = TestBed.createComponent(StatusBadgeComponent);
    fixture.componentRef.setInput('status', 'draft');
    fixture.componentRef.setInput('label', 'Entwurf');
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Entwurf');
  });
});
