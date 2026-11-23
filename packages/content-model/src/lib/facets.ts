import type { ProjectConfig } from './config.js';

/** A configured facet with its values. */
export type Facet = ProjectConfig['facets'][number];

/**
 * The facet whose values name the products releases are cut for:
 * `release.productFacet`, else the first facet; undefined when there is none.
 */
export function productFacet(
  config: Pick<ProjectConfig, 'facets' | 'release'>,
): Facet | undefined {
  const id = config.release?.productFacet;
  return id === undefined
    ? config.facets[0]
    : config.facets.find((f) => f.id === id);
}
