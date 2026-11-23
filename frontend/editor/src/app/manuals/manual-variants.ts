import { variantSlug } from '@openfolia/content-model/core';

import type { Schema } from '../api';
import type { ProjectConfig } from '../content/browser-model';

export type VariantValues = Readonly<Record<string, string>>;
export type VariantSummary = Schema<'VariantSummary'>;

/** "Large · Software 2.3", in the configured attribute order (as the API labels variants). */
export function variantLabel(
  values: VariantValues,
  config: ProjectConfig | null,
): string {
  if (!config) return Object.values(values).join(' · ');
  return config.variantAttributes
    .flatMap((attr) => {
      const value = values[attr.id];
      if (value === undefined) return [];
      if (attr.kind === 'version') return [`${attr.label} ${value}`];
      return [attr.values.find((v) => v.id === value)?.label ?? value];
    })
    .join(' · ');
}

/** Variants as `GET /manuals/:id` summarises them: for a manual only in a working copy. */
export function summarizeVariants(
  variants: readonly VariantValues[],
  config: ProjectConfig | null,
): VariantSummary[] {
  return variants.map((values) => ({
    slug: variantSlug({ ...values }),
    label: variantLabel(values, config),
    values: { ...values },
  }));
}

/**
 * The one variant a new manual starts with (a manifest needs one): the first value of every
 * enum attribute; version attributes are left unset (a condition on one does not hold). The
 * manual's own variant settings change it later.
 */
export function defaultVariant(config: ProjectConfig): Record<string, string> {
  return Object.fromEntries(
    config.variantAttributes.flatMap((attr) =>
      attr.kind === 'enum' && attr.values[0]
        ? [[attr.id, attr.values[0].id]]
        : [],
    ),
  );
}
