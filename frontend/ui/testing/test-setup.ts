// Runs before every unit test file of this library (project.json, `setupFiles`).
//
// The Angular builder runs Vitest without isolation: the spec files a worker picks up share one
// window, so what one test leaves in it is there for the next test, of that file or another
// (#933). A `window.matchMedia` left answering "reduce" turns every animation off for the specs
// after it, and which files share a worker changes with the machine's load. So a test that leaves
// `matchMedia` changed fails, and the window gets its own back for the next test.
// A spec stubs it with `vi.stubGlobal` and unstubs it in its own `afterEach`.
import { afterEach, expect } from 'vitest';

// `window.matchMedia` as the worker's window first had it. This file runs again before every spec
// file of the worker, so the first run keeps it on the window, where the later ones find it.
const key = Symbol.for('openfolia.ui-test-setup.matchMedia');
type Kept = { descriptor: PropertyDescriptor | undefined; value: unknown };
const kept = window as unknown as Record<symbol, Kept | undefined>;
kept[key] ??= {
  descriptor: Object.getOwnPropertyDescriptor(window, 'matchMedia'),
  value: window.matchMedia,
};
const original = kept[key];

function restore() {
  // Both the property (undoes a `defineProperty`) and its value (undoes an assignment).
  if (original.descriptor)
    Object.defineProperty(window, 'matchMedia', original.descriptor);
  else Reflect.deleteProperty(window, 'matchMedia');
  if (window.matchMedia !== original.value)
    Reflect.set(window, 'matchMedia', original.value);
}

afterEach(() => {
  const changed = window.matchMedia !== original.value;
  if (changed) restore();
  expect(
    changed,
    'the test left window.matchMedia changed: stub it with vi.stubGlobal and unstub it in afterEach',
  ).toBe(false);
});
