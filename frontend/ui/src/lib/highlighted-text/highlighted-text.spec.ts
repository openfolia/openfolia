import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { highlightSegments } from './highlight';
import { HighlightedTextComponent } from './highlighted-text.component';

describe('highlightSegments', () => {
  it('cuts the text at the matches, keeping every character once', () => {
    expect(
      highlightSegments('Charging station', [{ start: 9, end: 16 }]),
    ).toEqual([
      { text: 'Charging ', match: false },
      { text: 'station', match: true },
    ]);
  });

  it('tolerates offsets out of range, unsorted, empty and overlapping', () => {
    const segments = highlightSegments('abcdef', [
      { start: 4, end: 99 },
      { start: 1, end: 3 },
      { start: 2, end: 5 },
      { start: 3, end: 3 },
      { start: -5, end: 0 },
    ]);
    expect(segments.map((s) => s.text).join('')).toBe('abcdef');
    expect(segments).toEqual([
      { text: 'a', match: false },
      { text: 'bc', match: true },
      { text: 'de', match: true },
      { text: 'f', match: true },
    ]);
  });

  it('gives the whole text when nothing matched', () => {
    expect(highlightSegments('abc', [])).toEqual([
      { text: 'abc', match: false },
    ]);
    expect(highlightSegments('', [{ start: 0, end: 2 }])).toEqual([]);
  });
});

@Component({
  imports: [HighlightedTextComponent],
  template: `<of-highlighted-text [text]="text()" [matches]="matches" />`,
})
class Host {
  readonly text = signal('<b>Gartenpumpe</b> für Teiche');
  readonly matches = [{ start: 3, end: 14 }];
}

describe('of-highlighted-text', () => {
  it('marks the matches and shows markup as text, never as HTML', () => {
    const f = TestBed.createComponent(Host);
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect(el.textContent).toBe('<b>Gartenpumpe</b> für Teiche');
    expect(el.querySelector('b')).toBeNull();
    const mark = el.querySelector('mark')!;
    expect(mark.textContent).toBe('Gartenpumpe');
    expect(mark.className).toContain('font-semibold');
    expect(mark.className).toContain('underline');
  });
});
