import { LiveAnnouncer } from '@angular/cdk/a11y';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import { provideZard } from '../core/provide-zard';
import { pageBusy } from './page-busy';
import type { TipAction, TipContent } from './tip-card.component';
import { TIP_ANIMATION_MS, TipOverlay, type TipRef } from './tip-overlay';

@Component({
  template: `
    <button type="button" id="before">Before</button>
    <button type="button" id="anchor" data-tip="demo">Anchor</button>
    <button type="button" id="other" data-tip="other">Other</button>
    <input id="field" />
  `,
})
class Host {}

const tip: TipContent = {
  id: 'demo.tip',
  title: 'ui.tip.gotIt',
  body: 'ui.tip.turnOff',
};

function setup() {
  TestBed.configureTestingModule({ providers: [provideZard()] });
  const fixture = TestBed.createComponent(Host);
  fixture.autoDetectChanges();
  const el = fixture.nativeElement as HTMLElement;
  document.body.append(el);
  const overlay = TestBed.inject(TipOverlay);
  const byId = (id: string) => el.querySelector<HTMLElement>(`#${id}`)!;
  return { fixture, el, overlay, byId };
}

/** The device's reduced-motion setting, as `matchMedia` answers it. */
function reducedMotion(reduce: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: reduce && query.includes('reduce'),
      media: query,
    }),
  });
}

const card = () => document.querySelector<HTMLElement>('[data-slot="tip"]');

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('TipOverlay', () => {
  it('shows a tip as an announced dialog that takes the focus, and gives it back', async () => {
    vi.useFakeTimers();
    reducedMotion(false);
    const { overlay, byId } = setup();
    byId('before').focus();
    const actions: TipAction[] = [];
    const ref = overlay.open({
      anchor: byId('anchor'),
      content: {
        ...tip,
        learnMore: { href: 'https://docs.test/guide', title: 'Guide' },
      },
      onAction: (a) => actions.push(a),
      onDismiss: () => undefined,
    });
    const shown = card()!;
    expect(shown.getAttribute('role')).toBe('dialog');
    expect(shown.getAttribute('aria-modal')).toBe('false');
    expect(shown.dataset['tipId']).toBe('demo.tip');
    expect(
      document
        .getElementById(shown.getAttribute('aria-labelledby')!)
        ?.textContent?.trim(),
    ).toBe('Got it');
    expect(
      document
        .getElementById(shown.getAttribute('aria-describedby')!)
        ?.textContent?.trim(),
    ).toBe('Turn off tips');
    expect(shown.hasAttribute('data-open')).toBe(true);
    expect(document.activeElement).toBe(shown);

    const more = shown.querySelector<HTMLAnchorElement>(
      '[data-slot="tip-learn-more"]',
    )!;
    expect(more.href).toBe('https://docs.test/guide');
    expect(more.rel).toBe('noopener noreferrer');
    expect(more.target).toBe('_blank');

    shown.querySelector<HTMLElement>('[data-action="got-it"]')!.click();
    shown.querySelector<HTMLElement>('[data-action="turn-off"]')!.click();
    expect(actions).toEqual(['got-it', 'turn-off']);

    ref.close();
    expect(ref.closed).toBe(true);
    expect(shown.hasAttribute('data-closed')).toBe(true);
    expect(document.activeElement).toBe(byId('before'));
    vi.advanceTimersByTime(TIP_ANIMATION_MS);
    expect(card()).toBeNull();
  });

  it('goes at once under reduced motion', () => {
    reducedMotion(true);
    const { overlay, byId } = setup();
    const ref = overlay.open({
      anchor: byId('anchor'),
      content: tip,
      onAction: () => undefined,
      onDismiss: () => undefined,
    });
    expect(card()).not.toBeNull();
    ref.close();
    expect(card()).toBeNull();
  });

  it('closes on Escape and says so', () => {
    const { overlay, byId } = setup();
    const reasons: string[] = [];
    const ref = overlay.open({
      anchor: byId('anchor'),
      content: tip,
      onAction: () => undefined,
      onDismiss: (r) => reasons.push(r),
    });
    card()!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    expect(reasons).toEqual(['escape']);
    expect(ref.closed).toBe(true);
  });

  it('leaves an Escape pressed elsewhere on the page to the page', () => {
    const { overlay, byId } = setup();
    const reasons: string[] = [];
    const ref = overlay.open({
      anchor: byId('anchor'),
      content: tip,
      onAction: () => undefined,
      onDismiss: (r) => reasons.push(r),
    });
    byId('anchor').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    expect(reasons).toEqual([]);
    expect(ref.closed).toBe(false);
    ref.close();
  });

  it('shows a tour step with its count and ×, Back from the second step, Done on the last', () => {
    vi.useFakeTimers();
    reducedMotion(false);
    const { overlay, byId } = setup();
    const actions: TipAction[] = [];
    const ref: TipRef = overlay.open({
      anchor: byId('anchor'),
      content: { ...tip, step: { index: 1, total: 2 } },
      spotlight: true,
      onAction: (a) => actions.push(a),
      onDismiss: () => undefined,
    });
    let shown = card()!;
    expect(
      shown.querySelector('[data-slot="tip-step"]')?.textContent?.trim(),
    ).toBe('1 of 2');
    expect(
      shown.querySelectorAll('[data-slot="tip-dots"] > span'),
    ).toHaveLength(2);
    expect(shown.querySelector('[data-action="back"]')).toBeNull();
    expect(
      shown.querySelector('[data-action="skip"]')?.getAttribute('aria-label'),
    ).toBe('End the tour');
    expect(
      shown.querySelector('[data-action="next"]')?.textContent?.trim(),
    ).toBe('Next');
    shown.querySelector<HTMLElement>('[data-action="next"]')!.click();
    shown.querySelector<HTMLElement>('[data-action="skip"]')!.click();
    expect(actions).toEqual(['next', 'skip']);

    ref.update(byId('other'), { ...tip, step: { index: 2, total: 2 } });
    expect(ref.anchor).toBe(byId('other'));
    vi.advanceTimersByTime(TIP_ANIMATION_MS);
    shown = card()!;
    expect(
      shown.querySelector('[data-slot="tip-step"]')?.textContent?.trim(),
    ).toBe('2 of 2');
    expect(shown.querySelector('[data-action="back"]')).not.toBeNull();
    expect(
      shown.querySelector('[data-action="next"]')?.textContent?.trim(),
    ).toBe('Done');
    // The focus followed the card to its new place.
    expect(document.activeElement).toBe(shown);
    ref.close();
  });

  it('names a task-led step’s buttons, with Not now and no Back, and hands over to a guide page (#869)', () => {
    reducedMotion(true);
    const { overlay, byId } = setup();
    const actions: TipAction[] = [];
    const ref = overlay.open({
      anchor: byId('anchor'),
      content: {
        ...tip,
        step: {
          index: 2,
          total: 3,
          next: 'ui.tip.gotIt',
          dismiss: 'ui.tip.turnOff',
          back: false,
        },
        learnMore: {
          href: 'https://docs.test/first-edit',
          title: 'Your first edit',
          read: true,
        },
      },
      spotlight: true,
      onAction: (a) => actions.push(a),
      onDismiss: () => undefined,
    });
    const shown = card()!;
    expect(shown.querySelector('[data-action="back"]')).toBeNull();
    expect(
      shown.querySelector('[data-action="next"]')?.textContent?.trim(),
    ).toBe('Got it');
    const link = shown.querySelector('[data-slot="tip-learn-more"]')!;
    expect(link.textContent?.trim()).toBe('Read “Your first edit”');
    expect(link.getAttribute('aria-label')).toBe(
      'Read “Your first edit” (opens in a new tab)',
    );
    shown.querySelector<HTMLElement>('[data-action="dismiss"]')!.click();
    expect(actions).toEqual(['skip']);
    ref.close();
  });

  it('dims the page around a tour step, and takes the spotlight away with it', () => {
    reducedMotion(true);
    const { overlay, byId } = setup();
    const spotlight = () =>
      document.querySelector<HTMLElement>('[data-slot="tip-spotlight"]');
    const ref = overlay.open({
      anchor: byId('anchor'),
      content: { ...tip, step: { index: 1, total: 2 } },
      spotlight: true,
      onAction: () => undefined,
      onDismiss: () => undefined,
    });
    expect(spotlight()?.hasAttribute('data-open')).toBe(true);
    expect(spotlight()?.hasAttribute('data-empty')).toBe(false);
    expect(spotlight()?.getAttribute('aria-hidden')).toBe('true');
    // Under the card: first in the overlay container.
    expect(spotlight()?.parentElement?.firstElementChild).toBe(spotlight());

    ref.update(null, { ...tip, step: { index: 2, total: 2 } });
    expect(spotlight()?.hasAttribute('data-empty')).toBe(true);
    ref.close();
    expect(spotlight()).toBeNull();

    // A tip has none.
    overlay
      .open({
        anchor: byId('anchor'),
        content: tip,
        onAction: () => undefined,
        onDismiss: () => undefined,
      })
      .close();
    expect(spotlight()).toBeNull();
  });

  it('follows its anchor when the page moves it without a scroll or a resize (issue 903)', () => {
    vi.useFakeTimers();
    reducedMotion(true);
    const { overlay, byId } = setup();
    const anchor = byId('anchor');
    // Where the anchor is: a list's row, and later the same row once the list has moved it.
    let top = 100;
    vi.spyOn(anchor, 'getBoundingClientRect').mockImplementation(
      () => new DOMRect(40, top, 200, 40),
    );
    const spotlight = () =>
      document.querySelector<HTMLElement>('[data-slot="tip-spotlight"]')!;
    const pane = () =>
      document.querySelector<HTMLElement>('.cdk-overlay-pane')!;
    const ref = overlay.open({
      anchor,
      content: { ...tip, step: { index: 1, total: 2 } },
      spotlight: true,
      onAction: () => undefined,
      onDismiss: () => undefined,
    });
    expect(spotlight().style.top).toBe('94px');
    // Below the row: its bottom (140), then the gap in a transform.
    expect(pane().style.top).toBe('140px');

    // The row is moved by the layout (the list loading in above it): no scroll, no resize.
    top = 160;
    vi.advanceTimersByTime(50);
    expect(spotlight().style.top).toBe('154px');
    expect(pane().style.top).toBe('200px');
    ref.close();
  });

  it('goes once its anchor has left the page, or asks its caller, once, to point it again (issue 903)', () => {
    vi.useFakeTimers();
    reducedMotion(true);
    const { overlay, byId } = setup();
    const reasons: string[] = [];
    const ref = overlay.open({
      anchor: byId('anchor'),
      content: { ...tip, step: { index: 1, total: 2 } },
      spotlight: true,
      onAction: () => undefined,
      onDismiss: (r) => reasons.push(r),
    });
    byId('anchor').remove();
    vi.advanceTimersByTime(50);
    expect(reasons).toEqual(['hidden']);
    expect(ref.closed).toBe(true);

    let gone = 0;
    const asked = overlay.open({
      anchor: byId('other'),
      content: tip,
      onAnchorGone: () => gone++,
      onAction: () => undefined,
      onDismiss: (r) => reasons.push(r),
    });
    byId('other').remove();
    vi.advanceTimersByTime(100);
    expect(gone).toBe(1);
    expect(asked.closed).toBe(false);
    asked.update(byId('before'), tip);
    expect(asked.anchor).toBe(byId('before'));
    asked.close();
  });

  it('ends a tour step on Escape from anywhere, unless the page took the key', () => {
    reducedMotion(true);
    const { overlay, byId } = setup();
    const reasons: string[] = [];
    const ref = overlay.open({
      anchor: byId('anchor'),
      content: { ...tip, step: { index: 1, total: 2 } },
      spotlight: true,
      onAction: () => undefined,
      onDismiss: (r) => reasons.push(r),
    });
    const handled = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    handled.preventDefault();
    byId('before').dispatchEvent(handled);
    expect(ref.closed).toBe(false);

    byId('before').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    expect(reasons).toEqual(['escape']);
    expect(ref.closed).toBe(true);
  });

  it('keeps Tab inside a tour step', () => {
    reducedMotion(true);
    const { overlay, byId } = setup();
    const ref = overlay.open({
      anchor: byId('anchor'),
      content: { ...tip, step: { index: 2, total: 3 } },
      spotlight: true,
      onAction: () => undefined,
      onDismiss: () => undefined,
    });
    const shown = card()!;
    const close = shown.querySelector<HTMLElement>('[data-action="skip"]')!;
    const next = shown.querySelector<HTMLElement>('[data-action="next"]')!;
    const tab = (shiftKey: boolean) =>
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Tab',
          shiftKey,
          bubbles: true,
          cancelable: true,
        }),
      );
    next.focus();
    tab(false);
    expect(document.activeElement).toBe(close);
    tab(true);
    expect(document.activeElement).toBe(next);
    // From the card itself (where the focus lands as it opens), Shift+Tab goes to the last.
    shown.focus();
    tab(true);
    expect(document.activeElement).toBe(next);
    ref.close();
  });

  it('announces a card that comes without the focus, once, in the shared live region (issue 869)', async () => {
    vi.useFakeTimers();
    reducedMotion(true);
    const { overlay, byId } = setup();
    const announce = vi.spyOn(TestBed.inject(LiveAnnouncer), 'announce');
    byId('field').focus();
    const ref = overlay.open({
      anchor: byId('anchor'),
      content: tip,
      focus: false,
      onAction: () => undefined,
      onDismiss: () => undefined,
    });
    // The caret stays where the person types.
    expect(document.activeElement).toBe(byId('field'));
    await vi.advanceTimersByTimeAsync(150);
    const regions = document.querySelectorAll('.cdk-live-announcer-element');
    expect(regions).toHaveLength(1);
    expect(regions[0]?.getAttribute('aria-live')).toBe('polite');
    expect(regions[0]?.textContent).toBe('Got it. Turn off tips');
    // Placed again (a resize), the same card: not said again.
    ref.update(byId('other'), tip);
    await vi.advanceTimersByTimeAsync(150);
    expect(announce).toHaveBeenCalledTimes(1);
    // Another step, still without the focus: said, in the same region.
    ref.update(byId('other'), {
      ...tip,
      id: 'demo.next',
      title: 'ui.tip.next',
    });
    await vi.advanceTimersByTimeAsync(150);
    expect(announce).toHaveBeenCalledTimes(2);
    expect(
      document.querySelectorAll('.cdk-live-announcer-element'),
    ).toHaveLength(1);
    ref.close();

    // A card that takes the focus is announced by that: nothing in the region.
    overlay.open({
      anchor: byId('anchor'),
      content: { ...tip, id: 'demo.focused' },
      onAction: () => undefined,
      onDismiss: () => undefined,
    });
    expect(card()).toBe(document.activeElement);
    expect(announce).toHaveBeenCalledTimes(2);
  });

  it('keeps one tip at a time', () => {
    const { overlay, byId } = setup();
    const first = overlay.open({
      anchor: byId('anchor'),
      content: tip,
      onAction: () => undefined,
      onDismiss: () => undefined,
    });
    overlay.open({
      anchor: null,
      content: { ...tip, id: 'second' },
      onAction: () => undefined,
      onDismiss: () => undefined,
    });
    expect(first.closed).toBe(true);
  });
});

describe('pageBusy', () => {
  it('is busy while the focus is in a field or a modal is open, not for the tip itself', () => {
    const { overlay, byId, el } = setup();
    expect(pageBusy()).toBe(false);
    byId('field').focus();
    expect(pageBusy()).toBe(true);
    // Not where a tour step asks the person to type.
    expect(pageBusy(document, byId('field'))).toBe(false);
    expect(pageBusy(document, byId('anchor'))).toBe(true);
    byId('field').blur();

    const ref = overlay.open({
      anchor: byId('anchor'),
      content: tip,
      onAction: () => undefined,
      onDismiss: () => undefined,
    });
    expect(pageBusy()).toBe(false);
    ref.close();

    const dialog = document.createElement('div');
    dialog.setAttribute('aria-modal', 'true');
    el.append(dialog);
    expect(pageBusy()).toBe(true);
    dialog.dataset['state'] = 'closed';
    expect(pageBusy()).toBe(false);
  });

  it('is busy while a menu is open in the overlay container', () => {
    setup();
    const container = document.createElement('div');
    container.className = 'cdk-overlay-container';
    const pane = document.createElement('div');
    pane.className = 'cdk-overlay-pane';
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    pane.append(menu);
    container.append(pane);
    document.body.append(container);
    expect(pageBusy()).toBe(true);
    menu.setAttribute('data-closed', '');
    expect(pageBusy()).toBe(false);
  });
});
