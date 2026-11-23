/** A page of a list, 1-based. */
export interface PageRequest {
  number: number;
  size: number;
}

export interface Paginated<T> {
  items: T[];
  total: number;
}

/** Cuts one page out of a full list. */
export function paginate<T>(
  all: readonly T[],
  page: PageRequest,
): Paginated<T> {
  const start = (page.number - 1) * page.size;
  return { items: all.slice(start, start + page.size), total: all.length };
}
