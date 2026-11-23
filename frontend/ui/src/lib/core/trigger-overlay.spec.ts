import {
  type ConnectedOverlayPositionChange,
  Overlay,
  type OverlayRef,
} from '@angular/cdk/overlay';
import { DomPortal } from '@angular/cdk/portal';
import { Injector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildDropdownPositions } from '../dropdown-menu/dropdown-positions';
import {
  createTriggerOverlay,
  isOutsideView,
  slideAlongTrigger,
} from './trigger-overlay';

describe('slideAlongTrigger', () => {
  it('leaves a panel that fits where it is', () => {
    expect(
      slideAlongTrigger(
        { start: 100, end: 300 },
        { start: 100, end: 180 },
        8,
        1272,
      ),
    ).toBe(0);
  });

  it('slides a panel past the far edge back in, along the trigger', () => {
    // A 200px panel start-aligned to a trigger at 250 on a 320px screen.
    expect(
      slideAlongTrigger(
        { start: 250, end: 450 },
        { start: 250, end: 300 },
        8,
        312,
      ),
    ).toBe(-138);
  });

  it('keeps the start of a panel longer than the room in view', () => {
    expect(
      slideAlongTrigger(
        { start: 20, end: 420 },
        { start: 20, end: 60 },
        8,
        312,
      ),
    ).toBe(-12);
  });

  it('never slides a panel off the trigger it belongs to', () => {
    // The trigger sits off screen to the left: the panel stops with its end on the trigger's start.
    expect(
      slideAlongTrigger(
        { start: -300, end: -100 },
        { start: -300, end: -260 },
        8,
        1272,
      ),
    ).toBe(40);
  });
});

describe('isOutsideView', () => {
  const viewport = { top: 0, left: 0, bottom: 800, right: 1280 };

  it('is false while any part of the trigger shows', () => {
    expect(
      isOutsideView({ top: -20, bottom: 12, left: 10, right: 90 }, [viewport]),
    ).toBe(false);
  });

  it('is true once the trigger is wholly past an edge', () => {
    expect(
      isOutsideView({ top: -40, bottom: -8, left: 10, right: 90 }, [viewport]),
    ).toBe(true);
  });

  it('counts a clipping container, not only the viewport', () => {
    const main = { top: 64, left: 240, bottom: 800, right: 1280 };
    expect(
      isOutsideView({ top: 20, bottom: 52, left: 300, right: 380 }, [
        viewport,
        main,
      ]),
    ).toBe(true);
  });
});

/** A DOMRect at `top`/`left`, the size given. */
function rect(left: number, top: number, width: number, height: number) {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

describe('createTriggerOverlay', () => {
  let trigger: HTMLButtonElement;
  let triggerTop: number;
  let overlayRef: OverlayRef | undefined;
  const onTriggerHidden = vi.fn();
  const placed: ConnectedOverlayPositionChange[] = [];

  beforeEach(() => {
    const root = document.documentElement;
    Object.defineProperty(root, 'clientWidth', {
      configurable: true,
      value: 1280,
    });
    Object.defineProperty(root, 'clientHeight', {
      configurable: true,
      value: 800,
    });
    trigger = document.createElement('button');
    document.body.append(trigger);
    triggerTop = 100;
    trigger.getBoundingClientRect = () => rect(100, triggerTop, 80, 32);
    onTriggerHidden.mockReset();
    placed.length = 0;
  });

  afterEach(() => {
    overlayRef?.dispose();
    overlayRef = undefined;
    trigger.remove();
    const root = document.documentElement;
    delete (root as { clientWidth?: number }).clientWidth;
    delete (root as { clientHeight?: number }).clientHeight;
  });

  function open(
    positions = buildDropdownPositions('bottom', 'start', 4),
    size = { width: 200, height: 300 },
  ): HTMLElement {
    const injector = TestBed.inject(Injector);
    const { positionStrategy, scrollStrategy } = createTriggerOverlay(
      injector,
      {
        origin: trigger,
        positions,
        onTriggerHidden,
      },
    );
    positionStrategy.positionChanges.subscribe((change) => placed.push(change));
    overlayRef = TestBed.inject(Overlay).create({
      positionStrategy,
      scrollStrategy,
    });
    const panel = document.createElement('div');
    document.body.append(panel);
    overlayRef.attach(new DomPortal(panel));
    // jsdom lays nothing out: the pane's box is read back from the styles CDK set on it.
    const pane = overlayRef.overlayElement;
    pane.getBoundingClientRect = () => {
      const { left, right, top, bottom } = pane.style;
      const root = document.documentElement;
      const x = left
        ? parseFloat(left)
        : right
          ? root.clientWidth - parseFloat(right) - size.width
          : 0;
      const y = top
        ? parseFloat(top)
        : bottom
          ? root.clientHeight - parseFloat(bottom) - size.height
          : 0;
      // CDK's offsets (and the slide) are translates.
      const shift = (axis: 'X' | 'Y') =>
        [
          ...pane.style.transform.matchAll(
            new RegExp(`translate${axis}\\((-?[\\d.]+)px\\)`, 'g'),
          ),
        ].reduce((sum, match) => sum + parseFloat(match[1] ?? '0'), 0);
      return rect(x + shift('X'), y + shift('Y'), size.width, size.height);
    };
    overlayRef.updatePosition();
    return panel;
  }

  const lastSide = () => placed.at(-1)?.connectionPair.overlayY;

  it('opens below the trigger when there is room', () => {
    open();
    expect(lastSide()).toBe('top');
    expect(overlayRef?.overlayElement.style.top).toBe('132px');
  });

  it('follows the trigger on a window scroll, not pushed into the viewport', () => {
    open();
    triggerTop = 20;
    document.dispatchEvent(new Event('scroll'));
    expect(overlayRef?.overlayElement.style.top).toBe('52px');
    expect(onTriggerHidden).not.toHaveBeenCalled();
  });

  it('flips above the trigger near the bottom edge', () => {
    triggerTop = 600;
    open();
    expect(lastSide()).toBe('bottom');
    expect(overlayRef?.overlayElement.style.bottom).toBe(`${800 - 600}px`);
  });

  it('slides along the trigger into a narrow viewport, never off it', () => {
    Object.defineProperty(document.documentElement, 'clientWidth', {
      configurable: true,
      value: 320,
    });
    trigger.getBoundingClientRect = () => rect(230, triggerTop, 50, 32);
    open(buildDropdownPositions('bottom', 'start', 4), {
      width: 300,
      height: 200,
    });
    // No alignment fits 300px: end-aligned it starts at -20, so it slides right to the 8px margin.
    expect(overlayRef?.overlayElement.style.transform).toContain(
      'translateX(28px)',
    );
  });

  it('opens below a trigger with no room on either side for a side panel', () => {
    Object.defineProperty(document.documentElement, 'clientWidth', {
      configurable: true,
      value: 320,
    });
    trigger.getBoundingClientRect = () => rect(134, triggerTop, 110, 32);
    open(buildDropdownPositions('right', 'start', 4), {
      width: 288,
      height: 120,
    });
    expect(placed.at(-1)?.connectionPair).toMatchObject({
      originY: 'bottom',
      overlayY: 'top',
    });
  });

  it('closes once the trigger has scrolled out of view', () => {
    open();
    triggerTop = -40;
    document.dispatchEvent(new Event('scroll'));
    expect(onTriggerHidden).toHaveBeenCalledTimes(1);
    // It stops listening: a further scroll does not close twice.
    document.dispatchEvent(new Event('scroll'));
    expect(onTriggerHidden).toHaveBeenCalledTimes(1);
  });

  it('hears the scroll of a container around the trigger', () => {
    const main = document.createElement('main');
    main.style.overflowY = 'auto';
    document.body.append(main);
    main.append(trigger);
    main.getBoundingClientRect = () => rect(0, 64, 1280, 736);
    open();
    triggerTop = 20; // wholly under the container's top edge, still inside the viewport
    main.dispatchEvent(new Event('scroll'));
    expect(onTriggerHidden).toHaveBeenCalledTimes(1);
    main.remove();
  });

  it('follows a container scroll even when the trigger sits in another panel', () => {
    // A submenu's row lives in its menu's pane, outside the scrolled container.
    const main = document.createElement('main');
    const parentPane = document.createElement('div');
    parentPane.className = 'cdk-overlay-pane';
    document.body.append(main, parentPane);
    parentPane.append(trigger);
    open();
    triggerTop = 60;
    main.dispatchEvent(new Event('scroll'));
    expect(overlayRef?.overlayElement.style.top).toBe('92px');
    main.remove();
    parentPane.remove();
  });

  it('ignores the scroll of a container the trigger is not in', () => {
    const aside = document.createElement('aside');
    document.body.append(aside);
    open();
    triggerTop = 60;
    aside.dispatchEvent(new Event('scroll'));
    expect(overlayRef?.overlayElement.style.top).toBe('132px');
    aside.remove();
  });

  it('caps the height to the room on its side when neither side is tall enough', () => {
    Object.defineProperty(document.documentElement, 'clientHeight', {
      configurable: true,
      value: 700,
    });
    triggerTop = 300;
    open(buildDropdownPositions('bottom', 'start', 4), {
      width: 200,
      height: 384,
    });
    // Below: from 336 to 700 - 8 leaves 356px.
    expect(lastSide()).toBe('top');
    expect(overlayRef?.overlayElement.style.maxHeight).toBe('356px');

    // More room later (the page scrolled it up): the cap is lifted, the list keeps its scroll.
    const list = overlayRef!.overlayElement.querySelector('div')!;
    list.scrollTop = 120;
    triggerTop = 100;
    document.dispatchEvent(new Event('scroll'));
    expect(overlayRef?.overlayElement.style.maxHeight).toBe('');
    expect(list.scrollTop).toBe(120);
  });

  it('ignores a scroll inside the panel itself', () => {
    const panel = open();
    triggerTop = -40;
    panel.dispatchEvent(new Event('scroll'));
    expect(onTriggerHidden).not.toHaveBeenCalled();
  });
});
