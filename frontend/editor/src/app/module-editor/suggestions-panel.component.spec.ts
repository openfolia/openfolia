import { TestBed } from '@angular/core/testing';
import { provideZard } from '@openfolia/ui/core';

import type { SuggestionItem } from './suggestion-items';
import {
  type StyleReviewState,
  SuggestionsPanelComponent,
  type WritingChecksState,
} from './suggestions-panel.component';

// The Suggestions tab (#247): the writing checks' findings first, each with its severity in
// words and Replace, Show and Ignore here; the style review below, left out entirely when the
// server has none.

const finding = (over: Partial<SuggestionItem> = {}): SuggestionItem => ({
  id: 'f1',
  kind: 'writing',
  severity: 'warning',
  blockId: 'dry',
  field: 'content',
  range: { start: 10, end: 16 },
  original: 'loader',
  replacement: 'charger',
  message: '“loader” is a forbidden term.',
  expected: 'Store the loader in a dry place.',
  order: 0,
  ...over,
});

async function render(inputs: {
  checks?: SuggestionItem[];
  checksState?: WritingChecksState;
  state?: StyleReviewState;
  items?: SuggestionItem[];
}) {
  TestBed.configureTestingModule({ providers: [provideZard()] });
  const fixture = TestBed.createComponent(SuggestionsPanelComponent);
  for (const [name, value] of Object.entries(inputs))
    fixture.componentRef.setInput(name, value);
  const events: [string, string][] = [];
  const c = fixture.componentInstance;
  c.apply.subscribe((i) => events.push(['apply', i.id]));
  c.show.subscribe((i) => events.push(['show', i.id]));
  c.dismiss.subscribe((i) => events.push(['dismiss', i.id]));
  c.review.subscribe(() => events.push(['review', '']));
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  return { fixture, el, events };
}

describe('SuggestionsPanelComponent', () => {
  it('lists the writing checks’ findings with their severity in words, and acts on them', async () => {
    const { el, events } = await render({
      checks: [
        finding(),
        finding({
          id: 'f2',
          severity: 'blocking',
          replacement: null,
          original: 'a very long sentence',
          message: 'This sentence has 40 words; at most 25 are allowed.',
        }),
      ],
      checksState: 'ready',
    });
    const checks = el.querySelector('[data-slot="writing-checks-panel"]')!;
    expect(checks.querySelector('h2')?.textContent).toContain('Writing checks');
    const rows = checks.querySelectorAll<HTMLElement>(
      '[data-slot="suggestion"]',
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('Warning');
    expect(rows[0]!.textContent).toContain('“loader” is a forbidden term.');
    expect(rows[0]!.querySelector('del')?.textContent).toBe('loader');
    expect(rows[0]!.querySelector('ins')?.textContent).toBe('charger');
    expect(rows[1]!.textContent).toContain('Blocking');
    // No fix, no Replace.
    expect(rows[1]!.querySelector('[data-action="apply"]')).toBeNull();
    const button = (row: HTMLElement, action: string) =>
      row.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!;
    expect(button(rows[0]!, 'apply').textContent).toContain('Replace');
    expect(button(rows[0]!, 'dismiss').textContent).toContain('Ignore here');
    button(rows[0]!, 'apply').click();
    button(rows[0]!, 'show').click();
    button(rows[1]!, 'dismiss').click();
    expect(events).toEqual([
      ['apply', 'f1'],
      ['show', 'f1'],
      ['dismiss', 'f2'],
    ]);
  });

  it('says why nothing is listed: being read, unreadable, nothing for the language, or nothing found', async () => {
    for (const [state, slot] of [
      ['failed', 'writing-checks-failed'],
      ['off', 'writing-checks-off'],
      ['ready', 'writing-checks-none'],
    ] as const) {
      TestBed.resetTestingModule();
      const { el } = await render({ checksState: state });
      expect(el.querySelector(`[data-slot="${slot}"]`)).not.toBeNull();
    }
    TestBed.resetTestingModule();
    const { el } = await render({ checksState: 'loading' });
    expect(el.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('shows Review style while the server may have a style review, and nothing of it when it has none', async () => {
    const { el, events } = await render({ state: 'idle' });
    const run = el.querySelector<HTMLButtonElement>(
      '[data-slot="style-review-run"]',
    );
    expect(run?.textContent).toContain('Review style');
    run!.click();
    expect(events).toEqual([['review', '']]);
    TestBed.resetTestingModule();
    const off = await render({ state: 'off' });
    expect(off.el.querySelector('[data-slot="suggestions-panel"]')).toBeNull();
    expect(off.el.textContent).not.toContain('Review style');
  });
});
