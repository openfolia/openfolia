import { Injectable } from '@nestjs/common';
import {
  conditionIssues,
  evaluateCondition,
  textIn,
  variantLabel,
  variantSlug,
  type Condition,
} from '@openfolia/content-model';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { UnprocessableProblems } from '../../../base/core/errors.js';
import {
  paginate,
  type PageRequest,
  type Paginated,
} from '../../../base/core/paging.js';
import type { ReadableContent } from '../../../content/core/readable-content.js';
import type { VariantSummary } from '../../../manuals/core/variants.js';

/** A manual in one of the variant combinations its manifest lists. */
export interface VariantBuild {
  manualId: string;
  manualTitle: string;
  variant: VariantSummary;
}

/**
 * One page of the builds a condition holds for: every variant combination
 * a manual the actor may read lists (`variants:` in its manifest), in
 * the order the manuals are listed in, then the manifest's order. Evaluated as `resolveManual`
 * evaluates a variant block: version attributes compare numerically, and a
 * test on an attribute the combination does not set does not hold.
 *
 * Only manuals the actor may read are considered (`ReadableContent.manuals`),
 * so a manual outside the reader's scope is never named nor counted; one
 * whose manifest cannot be read lists no build. A condition naming an
 * attribute or value the configuration does not hold is refused
 * (`unknown-variant`), one problem per issue, before any manual is read.
 */
@Injectable()
export class MatchVariantsAction extends ActorAction<
  {
    actor: Actor;
    snapshot: ReadableContent;
    when: Condition;
    page: PageRequest;
  },
  Paginated<VariantBuild>
> {
  readonly policy = 'content.read';

  protected async run({
    snapshot,
    when,
    page,
  }: {
    snapshot: ReadableContent;
    when: Condition;
    page: PageRequest;
  }): Promise<Paginated<VariantBuild>> {
    const config = await snapshot.config();
    const issues = conditionIssues(when, config);
    if (issues.length > 0) {
      throw new UnprocessableProblems(
        'unknown-variant',
        'The condition names what the configuration does not hold.',
        issues.map((issue) => ({
          detail: issue.message,
          meta: { issue: issue.code },
        })),
      );
    }
    const versionAttributes = new Set(
      config.variantAttributes
        .filter((attribute) => attribute.kind === 'version')
        .map((attribute) => attribute.id),
    );
    // A listing without a language (#731): titles and labels in the source language.
    const source = config.languages.source;
    const builds: VariantBuild[] = [];
    for (const manual of await snapshot.manuals()) {
      if (!('manifest' in manual)) continue;
      for (const values of manual.manifest.variants) {
        if (!evaluateCondition(when, values, { versionAttributes })) continue;
        builds.push({
          manualId: manual.id,
          manualTitle: textIn(manual.manifest.title, source, source),
          variant: {
            slug: variantSlug(values),
            label: variantLabel(values, config, source),
            values,
          },
        });
      }
    }
    return paginate(builds, page);
  }
}
