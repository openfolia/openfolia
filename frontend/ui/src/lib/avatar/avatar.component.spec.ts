import { TestBed } from '@angular/core/testing';

import { AvatarComponent, initialsOf } from './avatar.component';

describe('AvatarComponent', () => {
  it('takes at most two initials, upper case', () => {
    expect(initialsOf('Alex Brandt')).toBe('AB');
    expect(initialsOf('  alex   maria brandt ')).toBe('AM');
    expect(initialsOf('alex')).toBe('A');
    expect(initialsOf('')).toBe('');
    expect(initialsOf('Émile Zola')).toBe('ÉZ');
  });

  it('shows them, hidden from screen readers, in the size asked for', () => {
    const fixture = TestBed.createComponent(AvatarComponent);
    fixture.componentRef.setInput('name', 'Alex Brandt');
    fixture.componentRef.setInput('size', 'lg');
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent?.trim()).toBe('AB');
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(el.classList).toContain('size-8');
    expect(el.classList).not.toContain('size-7');
  });
});
