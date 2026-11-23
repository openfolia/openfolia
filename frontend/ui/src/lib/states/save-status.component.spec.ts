import { TestBed } from '@angular/core/testing';

import { SaveStatusComponent } from './save-status.component';

describe('SaveStatusComponent', () => {
  it.each([
    ['saved', 'Saved'],
    ['saving', 'Saving'],
    ['draft', 'Draft'],
    ['not-saved', 'Not saved'],
  ] as const)('says %s in words', (status, text) => {
    const fixture = TestBed.createComponent(SaveStatusComponent);
    fixture.componentRef.setInput('status', status);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain(text);
    expect(el.getAttribute('role')).toBe('status');
  });

  it('shows a draft calmly: muted, never in the destructive colour (#793)', () => {
    const fixture = TestBed.createComponent(SaveStatusComponent);
    fixture.componentRef.setInput('status', 'draft');
    fixture.componentRef.setInput('detail', 'finish the block to save');
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'Draft · finish the block to save',
    );
    expect(el.classList).toContain('text-muted-foreground');
    expect(el.classList).not.toContain('text-destructive');
    expect(el.dataset['status']).toBe('draft');
  });

  it('keeps the destructive colour for a real failure', () => {
    const fixture = TestBed.createComponent(SaveStatusComponent);
    fixture.componentRef.setInput('status', 'not-saved');
    fixture.componentRef.setInput('detail', 'offline');
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.classList).toContain('text-destructive');
    expect(el.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'Not saved · offline',
    );
  });
});
