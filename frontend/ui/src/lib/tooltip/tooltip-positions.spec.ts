import { describe, expect, it } from 'vitest';

import { placeTooltip } from './tooltip-positions';
import {
  isApplePlatform,
  sidebarShortcutLabel,
} from '../sidebar/sidebar-shortcut';

const viewport = { width: 1280, height: 800 };
const tip = { width: 200, height: 40 };
const box = (left: number, top: number, width = 100, height = 32) => ({
  left,
  top,
  width,
  height,
});

describe('placeTooltip', () => {
  it('keeps the preferred side when it fits, centred, arrow in the middle', () => {
    const p = placeTooltip(box(500, 300), tip, viewport, 'top');
    expect(p.side).toBe('top');
    expect(p.left).toBe(500 + 50 - 100);
    expect(p.top).toBe(300 - 4 - 40);
    expect(p.arrow).toBe(100);
  });

  it('flips to the opposite side when the preferred one has no room (8px margin)', () => {
    // 40 + 4 above leaves 8 - 4 = 4px: inside the margin, so it does not fit.
    const p = placeTooltip(box(500, 40), tip, viewport, 'top');
    expect(p.side).toBe('bottom');
    expect(p.top).toBe(40 + 32 + 4);
  });

  it('flips below and slides left at the top-right corner, arrow on the trigger', () => {
    // A button under the top bar's right edge with a long tooltip: above has no room.
    const trigger = box(1170, 30, 82, 32);
    const long = { width: 318, height: 44 };
    const p = placeTooltip(trigger, long, viewport, 'top');
    expect(p.side).toBe('bottom');
    expect(p.top).toBe(30 + 32 + 4);
    expect(p.left + long.width).toBe(1280 - 8);
    expect(p.left + p.arrow).toBe(1170 + 41);
  });

  it('tries left or right before sliding when above and below both fail', () => {
    const tall = { width: 200, height: 300 };
    const p = placeTooltip(
      box(600, 250, 100, 32),
      tall,
      { width: 1280, height: 330 },
      'top',
    );
    expect(['left', 'right']).toContain(p.side);
  });

  it('slides along the edge when no side has room, the arrow still on the trigger centre', () => {
    const small = { width: 400, height: 200 };
    const wide = { width: 320, height: 40 };
    const p = placeTooltip(box(330, 20, 60, 32), wide, small, 'bottom');
    expect(p.side).toBe('bottom');
    expect(p.left).toBe(400 - 8 - 320);
    expect(p.arrow).toBe(330 + 30 - p.left);
  });

  it('keeps the arrow inside the rounded corners', () => {
    const small = { width: 400, height: 200 };
    const wide = { width: 380, height: 40 };
    const right = placeTooltip(box(390, 100, 8, 32), wide, small, 'top');
    expect(right.arrow).toBe(380 - 12);
    const left = placeTooltip(box(2, 100, 8, 32), wide, small, 'top');
    expect(left.arrow).toBe(12);
  });

  it('slides a side tooltip vertically into the viewport', () => {
    const p = placeTooltip(box(20, 2, 60, 32), tip, viewport, 'right');
    expect(p.side).toBe('right');
    expect(p.left).toBe(20 + 60 + 4);
    expect(p.top).toBe(8);
    expect(p.arrow).toBe(12);
  });
});

describe('sidebarShortcutLabel', () => {
  it('uses the command key on Apple platforms and Ctrl elsewhere', () => {
    expect(sidebarShortcutLabel(true)).toBe('⌘B');
    expect(sidebarShortcutLabel(false)).toBe('Ctrl+B');
    expect(isApplePlatform({ platform: 'MacIntel' })).toBe(true);
    expect(isApplePlatform({ platform: 'Win32' })).toBe(false);
    expect(
      isApplePlatform({ platform: '', userAgentData: { platform: 'macOS' } }),
    ).toBe(true);
  });
});
