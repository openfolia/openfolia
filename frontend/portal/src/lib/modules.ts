/**
 * Which modules a resolved manual holds, read from the manual's own structure: shared by the
 * fetch step's audience check (`build/audience.ts`) and the pages' re-check of the snapshot
 * (`parseSnapshot`), so both count the same modules.
 */
export class AudienceError extends Error {}

/** `module--block` (and `module--block--2` for a repeat): a module ID never holds `--`. */
const QUALIFIED = /^([a-z0-9]+(?:-[a-z0-9]+)*)--/;

type Node = Record<string, unknown>;

const nodes = (value: unknown): Node[] =>
  Array.isArray(value)
    ? value.filter(
        (item): item is Node => typeof item === 'object' && item !== null,
      )
    : [];

/**
 * Every module a resolved manual holds: its entries' modules and, for every block, list item
 * and procedure step in them (in sections, admonitions, table cells, …), the module its ID
 * names (`module--block`: what a module reference inlined keeps its own module's ID), and the
 * modules a cross-reference names by title (`xrefTitles`). The
 * API's `origins` bookkeeping only adds to that, never replaces it. A block whose ID names no
 * module refuses the manual: its module, so its audience, cannot be told.
 */
export function modulesOf(resolved: Record<string, unknown>): Set<string> {
  const modules = new Set<string>();
  const block = (node: Node): void => {
    const id = node['id'];
    const qualified = typeof id === 'string' ? QUALIFIED.exec(id) : null;
    if (qualified === null)
      throw new AudienceError(
        `a block ID (${typeof id === 'string' ? JSON.stringify(id.slice(0, 80)) : 'none'}) does not name its module`,
      );
    modules.add(qualified[1]!);
    for (const child of nodes(node['blocks'])) block(child);
    for (const item of [...nodes(node['items']), ...nodes(node['steps'])])
      block(item);
    for (const row of nodes(node['rows']))
      for (const cell of nodes(row['cells']))
        for (const child of nodes(cell['blocks'])) block(child);
  };
  const entries = (list: unknown): void => {
    for (const entry of nodes(list)) {
      if (entry['kind'] === 'module' && typeof entry['module'] === 'string')
        modules.add(entry['module']);
      for (const child of nodes(entry['blocks'])) block(child);
      entries(entry['entries']);
    }
  };
  entries(resolved['entries']);
  const origins = resolved['origins'];
  if (typeof origins === 'object' && origins !== null)
    for (const origin of Object.values(
      origins as Record<string, { module?: unknown }>,
    ))
      if (typeof origin?.module === 'string') modules.add(origin.module);
  // A cross-reference names a module outside the manual by its title (#796): that title is
  // content of the module too, so its audience is checked like any other's.
  const titles = resolved['xrefTitles'];
  if (typeof titles === 'object' && titles !== null)
    for (const module of Object.keys(titles)) modules.add(module);
  return modules;
}
