import {
  variantLabel,
  variantSlug,
  type Manifest,
  type ProjectConfig,
  type VariantValues,
} from '@openfolia/content-model';

export interface VariantSummary {
  /** For URLs, e.g. `model=large`. */
  slug: string;
  /** For people, e.g. "Large · Software 2.3". */
  label: string;
  values: VariantValues;
}

/**
 * The variants a manifest is published in, with their slugs and labels: in the source language,
 * as a listing without a language names them (#731).
 */
export function summarizeVariants(
  manifest: Manifest,
  config: ProjectConfig,
): VariantSummary[] {
  return manifest.variants.map((values) => ({
    slug: variantSlug(values),
    label: variantLabel(values, config, config.languages.source),
    values,
  }));
}
