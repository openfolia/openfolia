import { TestBed } from '@angular/core/testing';

import { ACTIVE_MS, Activity } from './activity';

describe('Activity (#378)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('counts what a person does in a frame’s document too, while it is watched', () => {
    const activity = TestBed.inject(Activity);
    const frame = document.implementation.createHTMLDocument();
    const unwatch = activity.watch(frame);
    const after = (event: Event) => {
      vi.advanceTimersByTime(ACTIVE_MS);
      expect(activity.recent()).toBe(false);
      frame.dispatchEvent(event);
      return activity.recent();
    };
    expect(after(new Event('wheel'))).toBe(true);
    // A click the page makes itself is nobody's.
    expect(after(new Event('click'))).toBe(false);
    unwatch();
    expect(after(new Event('wheel'))).toBe(false);
  });
});
