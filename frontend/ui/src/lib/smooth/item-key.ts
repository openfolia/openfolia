/** Tells items apart by their `id` when they have one, else by themselves. */
export function defaultItemKey(item: unknown): unknown {
  return item !== null && typeof item === 'object' && 'id' in item
    ? (item as { id: unknown }).id
    : item;
}
