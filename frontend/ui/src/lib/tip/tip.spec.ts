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

  it('shows a tour step with its count, Back kept in place on the first step, Done on the last', () => {
    vi.useFakeTimers();
    reducedMotion(false);
    const { overlay, byId } = setup();
    const actions: TipAction[] = [];
    const ref: TipRef = overlay.open({
      anchor: byId('anchor'),
      content: { ...tip, step: { index: 1, total: 2 } },
      onAction: (a) => actions.push(a),
      onDismiss: () => undefined,
    });
    let shown = card()!;
    expect(
      shown.querySelector('[data-slot="tip-step"]')?.textContent?.trim(),
    ).toBe('1 of 2');
    const back = shown.querySelector<HTMLElement>('[data-action="back"]')!;
    expect(back.classList).toContain('invisible');
    expect(back.getAttribute('aria-hidden')).toBe('true');
    expect(
      shown.querySelector('[data-action="next"]')?.textContent?.trim(),
    ).toBe('Next');
    shown.querySelector<HTMLElement>('[data-action="next"]')!.click();
    shown.querySelector<HTMLElement>('[data-action="skip"]')!.click();
    expect(actions).toEqual(['next', 'skip']);

    ref.update(byId('other'), { ...tip, step: { index: 2, total: 2 } });
    vi.advanceTimersByTime(TIP_ANIMATION_MS);
    shown = card()!;
    expect(
      shown.querySelector('[data-slot="tip-step"]')?.textContent?.trim(),
    ).toBe('2 of 2');
    expect(
      shown.querySelector('[data-action="back"]')?.classList,
    ).not.toContain('invisible');
    expect(
      shown.querySelector('[data-action="next"]')?.textContent?.trim(),
    ).toBe('Done');
    // The focus followed the card to its new place.
    expect(document.activeElement).toBe(shown);
    ref.close();
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
