import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { Component, inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { provideZard } from '@openfolia/ui/core';
import { ToastService } from '@openfolia/ui/toast';

import { apiErrorInterceptor } from '../api/api-interceptors';
import type { TextChange, TextChangeRefusal } from '../doc-editor/text-fields';
import { StyleReview, type SuggestionTarget } from './style-review';
import { SuggestionsPanelComponent } from './suggestions-panel.component';

const SUBJECT = { changeSetId: 'cs1', lang: 'en', moduleId: 'pump' };
const ROUTE = '/api/change-sets/cs1/modules/en/pump/style-review';

/** A field of text by block ID and field, changed as the editor changes it. */
class FakeTarget implements SuggestionTarget {
  readonly texts = new Map<string, string>([
    ['pump-1/legend', 'Utilize the outlet'],
    ['p1/content', 'Switch it off.'],
  ]);
  readonly shown: string[] = [];

  textOf(blockId: string, field: string): string | null {
    return this.texts.get(`${blockId}/${field}`) ?? null;
  }

  changeText(change: TextChange): 'applied' | TextChangeRefusal {
    const k = `${change.blockId}/${change.field}`;
    const text = this.texts.get(k);
    if (text === undefined) return 'missing';
    if (
      text !== change.expected ||
      text.slice(change.range.start, change.range.end) !== change.original
    ) {
      return 'changed';
    }
    this.texts.set(
      k,
      text.slice(0, change.range.start) +
        change.replacement +
        text.slice(change.range.end),
    );
    return 'applied';
  }

  textsNow(): (blockId: string, field: string) => string | null {
    const kept = new Map(this.texts);
    return (blockId, field) => kept.get(`${blockId}/${field}`) ?? null;
  }

  showText(blockId: string, field: string): boolean {
    this.shown.push(`${blockId}/${field}`);
    return this.texts.has(`${blockId}/${field}`);
  }
}

const answer = (suggestions: unknown[]) => ({
  data: {
    type: 'StyleReview',
    id: 'en/pump',
    attributes: { lang: 'en', moduleId: 'pump', suggestions },
    meta: { version: 2, baseCommit: 'a'.repeat(40), dropped: 0 },
  },
});

const LEGEND = {
  id: 's1',
  blockId: 'pump-1',
  field: 'legend',
  range: { start: 0, end: 7 },
  original: 'Utilize',
  message: 'Prefer <b>plain</b> words.',
  replacement: 'Use',
  rule: 'model',
};
const REMARK = {
  id: 's2',
  blockId: 'p1',
  field: 'content',
  range: { start: 7, end: 9 },
  original: 'it',
  message: 'Name what is switched off.',
  replacement: null,
  rule: 'model',
};

@Component({
  imports: [SuggestionsPanelComponent],
  providers: [StyleReview],
  template: `<of-suggestions-panel
    [state]="review.state()"
    [items]="review.items()"
    [error]="review.error()"
    [announcement]="review.announcement()"
    (review)="run()"
    (apply)="review.apply($event, target)"
    (show)="review.show($event, target)"
    (dismiss)="review.dismiss($event)"
  />`,
})
class Host {
  readonly review = inject(StyleReview);
  readonly target = new FakeTarget();
  saved = true;
  run() {
    void this.review.review(
      SUBJECT,
      () => Promise.resolve(this.saved),
      this.target,
      () => 'editor.moduleActions.unsaved',
    );
  }
}

async function render() {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(withInterceptors([apiErrorInterceptor])),
      provideHttpClientTesting(),
      provideZard(),
    ],
  });
  const fixture = TestBed.createComponent(Host);
  const http = TestBed.inject(HttpTestingController);
  const toasts = TestBed.inject(ToastService);
  const el = fixture.nativeElement as HTMLElement;
  const host = fixture.componentInstance;
  host.review.reset(SUBJECT);
  await fixture.whenStable();
  const settle = async () => {
    await Promise.resolve();
    await fixture.whenStable();
  };
  const click = async (selector: string, within: ParentNode = el) => {
    (within.querySelector(selector) as HTMLButtonElement).click();
    await settle();
  };
  const rows = () => [...el.querySelectorAll('[data-slot="suggestion"]')];
  return { fixture, http, toasts, el, host, settle, click, rows };
}

describe('the style review in the module editor (#573)', () => {
  it('lists the suggestions as text, and applies one to a callout legend with Undo', async () => {
    const t = await render();
    await t.click('[data-slot="style-review-run"]');
    t.http
      .expectOne({ method: 'POST', url: ROUTE })
      .flush(answer([LEGEND, REMARK]));
    await t.settle();

    expect(t.rows()).toHaveLength(2);
    const [legend, remark] = t.rows() as HTMLElement[];
    expect(legend!.textContent).toContain('Callout legend');
    // The model's words are text, never markup.
    expect(legend!.textContent).toContain('Prefer <b>plain</b> words.');
    expect(legend!.querySelector('b')).toBeNull();
    expect(legend!.querySelector('del')?.textContent).toBe('Utilize');
    expect(legend!.querySelector('ins')?.textContent).toBe('Use');
    // A remark without a fix is only shown or dismissed.
    expect(remark!.querySelector('[data-action="apply"]')).toBeNull();
    expect(t.el.textContent).toContain('2 suggestions');

    await t.click('[data-action="apply"]', legend!);
    expect(t.host.target.texts.get('pump-1/legend')).toBe('Use the outlet');
    expect(t.host.target.shown).toEqual([]);
    expect(t.rows()).toHaveLength(1);
    // The toast's Undo puts the text and the suggestion back.
    const toast = t.toasts.toasts().at(-1)!;
    expect(toast.message).toEqual({ key: 'editor.suggestions.applied' });
    toast.onAction!();
    await t.settle();
    expect(t.host.target.texts.get('pump-1/legend')).toBe('Utilize the outlet');
    expect(t.rows()).toHaveLength(2);
    t.http.verify();
  });

  it('refuses to apply once the field’s text changed, and says so', async () => {
    const t = await render();
    await t.click('[data-slot="style-review-run"]');
    t.http.expectOne(ROUTE).flush(answer([LEGEND]));
    await t.settle();
    // Typed after the review: the range still says "Utilize", the rest does not.
    t.host.target.texts.set('pump-1/legend', 'Utilize the inlet');
    await t.click('[data-action="apply"]');
    expect(t.host.target.texts.get('pump-1/legend')).toBe('Utilize the inlet');
    expect(t.toasts.toasts().at(-1)?.message).toEqual({
      key: 'editor.suggestions.changed',
    });
    const [row] = t.rows();
    expect(row!.querySelector('[data-slot="suggestion-stale"]')).not.toBeNull();
    expect(row!.querySelector('[data-action="apply"]')).toBeNull();
    await t.click('[data-action="dismiss"]', row!);
    expect(t.rows()).toHaveLength(0);
  });

  it('holds suggestions against the text as it was when the review was asked for', async () => {
    const t = await render();
    await t.click('[data-slot="style-review-run"]');
    // Typed while the review ran: after the range, so "Utilize" is still where it was.
    t.host.target.texts.set('pump-1/legend', 'Utilize the outlet now');
    t.http.expectOne(ROUTE).flush(answer([LEGEND]));
    await t.settle();
    await t.click('[data-action="apply"]');
    expect(t.host.target.texts.get('pump-1/legend')).toBe(
      'Utilize the outlet now',
    );
    expect(t.toasts.toasts().at(-1)?.message).toEqual({
      key: 'editor.suggestions.changed',
    });
  });

  it('shows a suggestion’s text in the editor', async () => {
    const t = await render();
    await t.click('[data-slot="style-review-run"]');
    t.http.expectOne(ROUTE).flush(answer([LEGEND]));
    await t.settle();
    await t.click('[data-action="show"]');
    expect(t.host.target.shown).toEqual(['pump-1/legend']);
  });

  it('says when the server has no style review, and offers it no more', async () => {
    const t = await render();
    await t.click('[data-slot="style-review-run"]');
    t.http.expectOne(ROUTE).flush(
      {
        errors: [
          {
            status: '404',
            title: 'Not found',
            code: 'not-configured',
            detail: 'x',
          },
        ],
      },
      { status: 404, statusText: 'Not Found' },
    );
    await t.settle();
    // The section goes (#247: as when the server says so up front); a toast says why.
    expect(t.el.querySelector('[data-slot="suggestions-panel"]')).toBeNull();
    expect(t.el.querySelector('[data-slot="style-review-run"]')).toBeNull();
  });

  it('names a busy server and a rate limit in words of its own', async () => {
    const t = await render();
    await t.click('[data-slot="style-review-run"]');
    t.http.expectOne(ROUTE).flush(
      {
        errors: [
          {
            status: '429',
            title: 'Too many',
            code: 'rate-limited',
            detail: 'x',
            meta: { retryAfter: 12 },
          },
        ],
      },
      { status: 429, statusText: 'Too Many Requests' },
    );
    await t.settle();
    expect(t.el.querySelector('[role="alert"]')?.textContent).toContain(
      'Too many style reviews in a minute. Try again in 12 s.',
    );
  });

  it('asks nothing when the text could not be saved first', async () => {
    const t = await render();
    t.host.saved = false;
    await t.click('[data-slot="style-review-run"]');
    t.http.expectNone(ROUTE);
    expect(t.el.querySelector('[role="alert"]')).not.toBeNull();
  });
});
