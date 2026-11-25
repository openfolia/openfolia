import { Injectable } from '@nestjs/common';
import {
  type Block,
  type Condition,
  formatCondition,
  type ResolveIssue,
  textIn,
  type UpdatePhase,
} from '@openfolia/content-model';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { NotFoundError } from '../../../base/core/errors.js';
import type { ReadableContent } from '../../../content/core/readable-content.js';
import { refuseTooLarge } from '../too-large.js';

/** A label in the guide's language: an ID and what a reader reads for it. */
export interface UpdateGuideLabel {
  id: string;
  label: string;
}

/** A step of an update guide as a reader gets it (#906). */
export interface UpdateGuideStepView {
  /** The step's module, and `--2`, `--3`, … for its later steps (manifest order). */
  id: string;
  module: string;
  title: string;
  /** The language the module is in: the guide's, else the source language. */
  lang: string;
  version: string;
  phase: UpdatePhase;
  level: string | null;
  when: Condition | null;
  /** `when` as it is written (`cluster in (yes)`). */
  condition: string | null;
  blocks: Block[];
}

/** An update guide as a reader gets it (#906): what to pick from, and every step. */
export interface UpdateGuideView {
  id: string;
  lang: string;
  title: string;
  /** The version attribute it follows. */
  attribute: UpdateGuideLabel;
  /** Oldest first. */
  versions: string[];
  /** The levels a reader picks from: the configured audiences up to the guide's, least restricted first. */
  levels: UpdateGuideLabel[];
  /** The enum attributes the steps' conditions test, with their values. */
  options: (UpdateGuideLabel & { values: UpdateGuideLabel[] })[];
  /** The steps the reader may see, by version, then phase, then manifest order. */
  steps: UpdateGuideStepView[];
  issues: ResolveIssue[];
}

/**
 * An update guide (#906) in a configured language, as a reader (the portal) needs it to build the
 * guide statically and filter it on the client: its versions, levels and options, and every step
 * the reader may see with its version, phase, level, condition and body, resolved for the guide's
 * first variant (its text attributes). The same rules as for resolving a manual: a manual the
 * reader may not see, one that is not an update guide, or a language not configured is not found;
 * a step whose module the reader may not see is left out; past the expanded-size limits it is 422
 * `expansion-too-large`.
 */
@Injectable()
export class GetUpdateGuideAction extends ActorAction<
  { actor: Actor; snapshot: ReadableContent; id: string; lang: string },
  UpdateGuideView
> {
  readonly policy = 'content.read';

  protected async run({
    snapshot,
    id,
    lang,
  }: {
    snapshot: ReadableContent;
    id: string;
    lang: string;
  }): Promise<UpdateGuideView> {
    const config = await snapshot.config();
    const manual = await snapshot.manual(id);
    const guide = manual?.manifest.guide;
    if (!manual || manual.manifest.kind !== 'update-guide' || !guide) {
      throw new NotFoundError(`No update guide "${id}".`);
    }
    const noLanguage = () =>
      new NotFoundError(`Language "${lang}" is not configured.`);
    const { source, targets } = config.languages;
    if (lang !== source && !targets.includes(lang)) throw noLanguage();
    const variant = manual.manifest.variants[0] ?? {};
    const resolution = await snapshot.resolve(id, variant, lang);
    if (!resolution) throw noLanguage();
    refuseTooLarge(resolution);

    const label = (text: Parameters<typeof textIn>[0]) =>
      textIn(text, lang, source);
    const ordered = resolution.manual.updateSteps ?? [];
    // IDs counted in manifest order, so a step keeps its ID when steps of other versions come.
    const seen = new Map<string, number>();
    const ids = new Map<number, string>();
    for (const step of [...ordered].sort((a, b) => a.index - b.index)) {
      const n = (seen.get(step.entry.module) ?? 0) + 1;
      seen.set(step.entry.module, n);
      ids.set(
        step.index,
        n === 1 ? step.entry.module : `${step.entry.module}--${n}`,
      );
    }

    const optionIds = new Set<string>();
    const collect = (condition: Condition): void => {
      if (condition.op === 'all' || condition.op === 'any')
        condition.of.forEach(collect);
      else if (condition.op === 'not') collect(condition.of);
      else optionIds.add(condition.attr);
    };
    for (const step of ordered) if (step.when) collect(step.when);

    const attr = config.variantAttributes.find((a) => a.id === guide.attribute);
    const audienceRank = config.audiences.findIndex(
      (a) => a.id === manual.manifest.audience,
    );
    const levels =
      manual.manifest.audience === undefined || audienceRank < 0
        ? config.audiences
        : config.audiences.slice(0, audienceRank + 1);

    return {
      id,
      lang,
      title: resolution.manual.title,
      attribute: {
        id: guide.attribute,
        label: attr ? label(attr.label) : guide.attribute,
      },
      versions: [...guide.versions],
      levels: levels.map((a) => ({ id: a.id, label: label(a.label) })),
      options: config.variantAttributes.flatMap((a) =>
        a.kind === 'enum' && optionIds.has(a.id)
          ? [
              {
                id: a.id,
                label: label(a.label),
                values: a.values.map((v) => ({
                  id: v.id,
                  label: label(v.label),
                })),
              },
            ]
          : [],
      ),
      steps: ordered.map((step) => ({
        id: ids.get(step.index) as string,
        module: step.entry.module,
        title: step.entry.title,
        lang: step.entry.lang,
        version: step.version,
        phase: step.phase,
        level: step.level ?? null,
        when: step.when ?? null,
        condition: step.when ? formatCondition(step.when) : null,
        blocks: step.entry.blocks,
      })),
      issues: resolution.issues,
    };
  }
}
