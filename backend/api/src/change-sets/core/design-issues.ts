import {
  type Issue,
  type PageDesign,
  type ProjectConfig,
  validatePageDesign,
} from '@openfolia/content-model';

/**
 * A design's issues in the shape of a module's: `at` is where in the
 * design (a dotted path), a region's block after `#`
 * (`regions.footer.en#doc-number`).
 */
export function designIssues(
  design: PageDesign,
  config: ProjectConfig,
): Issue[] {
  return validatePageDesign(design, config).map(
    ({ severity, code, message, at, block }) => ({
      severity,
      code,
      message,
      ...(at !== undefined && {
        at: block === undefined ? at : `${at}#${block}`,
      }),
    }),
  ) as Issue[];
}
