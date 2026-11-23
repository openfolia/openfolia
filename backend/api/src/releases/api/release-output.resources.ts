import { LanguageTag, ModuleId } from '@openfolia/content-model';
import { z } from 'zod';
import {
  PageLinks,
  PageMeta,
  resourceObject,
  singleDocument,
} from '../../base/api/json-api.js';
import {
  OUTPUT_KINDS,
  OUTPUT_STATES,
  type ReleaseOutput,
} from '../core/release-output.js';
import type { Release } from '../core/release.js';
import type { DesignInUse as DesignInUseValue } from '../../content/core/design-in-use.js';
import { DesignInUse } from '../../manuals/api/manual.resources.js';
import type { RetriedOutput } from '../core/actions/release-outputs.action.js';

export const ReleaseOutputResource = resourceObject('ReleaseOutput', {
  attributes: z.object({
    manual: z
      .string()
      .nullable()
      .describe('The manual’s ID; null for an offline package (all of them).'),
    variant: z
      .string()
      .nullable()
      .describe(
        'The variant’s slug, e.g. `model=large` (the manifest’s); null for an offline package (every variant).',
      ),
    lang: z.string().describe('The language, a language tag.'),
    kind: z
      .enum(OUTPUT_KINDS)
      .describe(
        'What it is: `pdf`, a manual in one variant and language; `offline-package` (#59), a ZIP of every manual the language and audience level reads, as HTML pages and PDFs, that opens from the file system without a network.',
      ),
    audience: z
      .string()
      .nullable()
      .describe(
        'The audience level an offline package is for (it holds what that level reads); null for a PDF, and for a package when no levels are configured.',
      ),
    state: z
      .enum(OUTPUT_STATES)
      .describe(
        '`queued` (its render job waits), `rendering` (an attempt started; one retried after a passing failure stays here), `done` (the file is there) or `failed` (for good; `POST …/retry` queues it again).',
      ),
    sha256: z
      .string()
      .nullable()
      .describe(
        'The file’s SHA-256 (the blob store’s key); null until done. Outputs that reuse a file share it.',
      ),
    size: z
      .number()
      .int()
      .nullable()
      .describe('The file’s size in bytes; null until done.'),
    error: z
      .object({
        code: z
          .string()
          .describe(
            'Stable: `pdf-accessibility`, `render-timeout`, `render-failed`, `invalid-content`, `renderer-busy`, `render-error`, …',
          ),
        detail: z.string(),
      })
      .nullable()
      .describe(
        'Why it failed (or, while it is retried, why the latest attempt did); null otherwise.',
      ),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
    finishedAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe('When it was done or failed; null while queued or rendering.'),
  }),
  meta: z.object({
    reusedFrom: z
      .object({ releaseId: z.string(), outputId: z.string() })
      .nullable()
      .describe(
        'The release did not change the manual in this language: the output (of an earlier release) whose file this one is. Null when rendered for this release.',
      ),
    attempts: z
      .number()
      .int()
      .describe('Render attempts started, over every retry.'),
    retries: z
      .number()
      .int()
      .describe('How often it was queued again after failing.'),
    withdrawn: z
      .boolean()
      .describe(
        'The release is withdrawn: the file stays readable at its tag, but it is no longer the product’s current one.',
      ),
    /** The page design the manual is printed with at the release's tag (#589). */
    design: DesignInUse.optional().describe(
      'The page design the manual is printed with at the release’s tag; absent for an offline package.',
    ),
  }),
  links: z.object({
    file: z
      .string()
      .nullable()
      .describe('The file (`GET …/outputs/{outputId}/file`); null until done.'),
  }),
})
  .describe(
    'One file of a release: a manual in one variant and language, rendered at the release’s tag as the manual’s audience reads it, so it is the same for everyone who may read the manual; or an offline package (#59) of one language and audience level, built from the release’s tag as that level reads it.',
  )
  .meta({ id: 'ReleaseOutputResource' });

const { attributes, meta } = ReleaseOutputResource.shape;

/**
 * What `POST …/retry` answers (#340): a `ReleaseOutput` in full for a
 * publisher who may read the output, else only its `state` and its
 * counts, every other attribute absent.
 */
export const ReleaseOutputDocument = singleDocument(
  ReleaseOutputResource.extend({
    attributes: attributes.partial().required({ state: true }),
    meta: meta.partial().required({ attempts: true, retries: true }),
  }).describe(
    'The output queued again. A publisher who may not read it (no role of theirs covers all of its manual, as `GET …/outputs` judges it) gets only `state`, `meta.attempts` and `meta.retries`: every other attribute and `meta` member is absent, so retrying shows nothing that reading would not.',
  ),
).meta({ id: 'ReleaseOutputDocument' });

export const ReleaseOutputPageDocument = z
  .object({
    data: z.array(ReleaseOutputResource),
    meta: z.object({ page: PageMeta }),
    links: PageLinks,
  })
  .meta({ id: 'ReleaseOutputPageDocument' });

/** Filter parameters of `GET /releases/:releaseId/outputs`, validated before any query. */
export const outputFilters = {
  manual: ModuleId,
  kind: z.enum(OUTPUT_KINDS),
  lang: LanguageTag,
  state: z.enum(OUTPUT_STATES),
};

/** A retried output as `POST …/retry` answers it: in full only for a reader of it (`RetriedOutput`). */
export function toRetriedOutputResource(
  retried: RetriedOutput,
): z.infer<typeof ReleaseOutputDocument>['data'] {
  if (retried.whole) {
    return toReleaseOutputResource(
      retried.release,
      retried.output,
      retried.design,
    );
  }
  const { id, state, attempts, retries } = retried.output;
  return {
    type: 'ReleaseOutput',
    id,
    attributes: { state },
    meta: { attempts, retries },
    links: { file: null },
  };
}

export function toReleaseOutputResource(
  release: Pick<Release, 'id' | 'withdrawal'>,
  output: ReleaseOutput,
  design: DesignInUseValue | undefined,
): z.infer<typeof ReleaseOutputResource> {
  const isPackage = output.kind === 'offline-package';
  return {
    type: 'ReleaseOutput',
    id: output.id,
    attributes: {
      manual: isPackage ? null : output.manualId,
      variant: isPackage ? null : output.variant,
      lang: output.lang,
      kind: output.kind,
      audience: isPackage ? output.audience : null,
      state: output.state,
      sha256: output.sha256,
      size: output.size,
      error: output.error && { ...output.error },
      createdAt: output.createdAt.toISOString(),
      updatedAt: output.updatedAt.toISOString(),
      finishedAt: output.finishedAt?.toISOString() ?? null,
    },
    meta: {
      reusedFrom: output.reusedFrom && { ...output.reusedFrom },
      attempts: output.attempts,
      retries: output.retries,
      withdrawn: release.withdrawal !== null,
      ...(!isPackage && design && { design: { ...design } }),
    },
    links: {
      file:
        output.state === 'done'
          ? `/releases/${release.id}/outputs/${output.id}/file`
          : null,
    },
  };
}
