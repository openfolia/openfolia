/** Whether the person asked for reduced motion; false where `matchMedia` is missing. */
export function prefersReducedMotion(): boolean {
  try {
    return (
      globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ??
      false
    );
  } catch {
    return false;
  }
}
