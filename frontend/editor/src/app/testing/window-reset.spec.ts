// The window every test starts from (`testing/test-setup.ts`): a stub one test leaves on it is
// gone by the next test, of this file or the next one in the worker (#780). The tests run in
// the order written: each stubbing test leaves its stub for the one after it.
const descriptorBefore = Object.getOwnPropertyDescriptor(window, 'matchMedia');
const valueBefore = window.matchMedia;

const stub = ((media: string) => ({
  matches: true,
  media,
})) as unknown as typeof window.matchMedia;

function expectMatchMediaAsBefore() {
  expect(Object.getOwnPropertyDescriptor(window, 'matchMedia')).toEqual(
    descriptorBefore,
  );
  expect(window.matchMedia).toBe(valueBefore);
}

describe('the window between tests', () => {
  it('lets a test assign window.matchMedia and not put it back', () => {
    window.matchMedia = stub;
    expect(window.matchMedia('(x)').matches).toBe(true);
  });

  it('gives the next test the window.matchMedia the setup found', () => {
    expectMatchMediaAsBefore();
  });

  it('lets a test redefine window.matchMedia and not put it back', () => {
    // `vi.restoreAllMocks()` does not undo a `defineProperty`.
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: stub,
    });
    expect(window.matchMedia('(x)').matches).toBe(true);
  });

  it('gives the test after that the window.matchMedia the setup found too', () => {
    expectMatchMediaAsBefore();
  });
});
