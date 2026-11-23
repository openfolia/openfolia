/**
 * `items` mapped by `fn`, at most `max` at a time, in their order. For
 * reading many files: all at once, a list of thousands queues every read
 * in front of every other request's (one Git reader serves them in
 * order), and holds every file at once; a few at a time lets other
 * requests' reads in between. The first failure rejects (the reads under
 * way finish, no new one starts).
 */
export async function mapAtMost<T, R>(
  items: readonly T[],
  max: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i] as T, i);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, max), items.length) }, worker),
  );
  return out;
}
