import { describe, expect, it } from 'vitest';

import { parseStored } from './preferences.service';

describe('the browser copy of the preferences', () => {
  it('reads a stored copy back', () => {
    expect(
      parseStored(
        JSON.stringify({
          showTips: false,
          dismissedTips: ['content.new-module'],
          tourDone: true,
        }),
      ),
    ).toEqual({
      showTips: false,
      dismissedTips: ['content.new-module'],
      tourDone: true,
    });
  });

  it('holds a tampered copy to what the API accepts', () => {
    const many = Array.from({ length: 600 }, (_, i) => `tip-${i}`);
    const parsed = parseStored(
      JSON.stringify({
        showTips: 'yes',
        dismissedTips: [1, 'Not An Id', 'x'.repeat(101), ...many],
      }),
    );
    expect(parsed?.showTips).toBe(true);
    expect(parsed?.tourDone).toBe(false);
    expect(parsed?.dismissedTips).toHaveLength(500);
    expect(parsed?.dismissedTips[0]).toBe('tip-0');
  });

  it('takes nothing that is not a stored copy', () => {
    expect(parseStored(null)).toBeNull();
    expect(parseStored('not json')).toBeNull();
    expect(parseStored('42')).toBeNull();
  });
});
