import type { Locator } from '@playwright/test';

/**
 * The space between a `z-switch`'s knob and the inner edge of its track's border, in CSS pixels
 * (`track` is the switch's button). `end` is the side the knob rests on, `away` the other one.
 */
export const knobGaps = (track: Locator) =>
  track.evaluate((button) => {
    const knob = button.querySelector('[data-size]');
    if (!knob) throw new Error('no knob in the switch');
    const outer = button.getBoundingClientRect();
    const inner = knob.getBoundingClientRect();
    const style = getComputedStyle(button);
    const round = (value: number) => Math.round(value * 100) / 100;
    const left = round(
      inner.left - outer.left - parseFloat(style.borderLeftWidth),
    );
    const right = round(
      outer.right - inner.right - parseFloat(style.borderRightWidth),
    );
    const on = button.getAttribute('aria-checked') === 'true';
    return {
      on,
      size: knob.getAttribute('data-size'),
      top: round(inner.top - outer.top - parseFloat(style.borderTopWidth)),
      bottom: round(
        outer.bottom - inner.bottom - parseFloat(style.borderBottomWidth),
      ),
      end: on ? right : left,
      away: on ? left : right,
    };
  });
