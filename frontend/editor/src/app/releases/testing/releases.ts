import type {
  HttpTestingController,
  TestRequest,
} from '@angular/common/http/testing';

import type { ManualItem } from '../../preview/preview-model';
import type { MaintenanceLine } from '../create-release-model';
import type {
  OutputProgress,
  ProjectConfig,
  ReleaseChange,
  ReleaseDetail,
  ReleaseItem,
  ReleaseOutput,
} from '../releases-model';

export const RELEASE_ID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
export const OTHER_ID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c';

/** A release as the API sends it, for tests. */
export const release = (
  over: Partial<ReleaseItem['attributes']> & { id?: string } = {},
): ReleaseItem => {
  const { id, ...attributes } = over;
  return {
    type: 'Release',
    id: id ?? RELEASE_ID,
    attributes: {
      product: 'north',
      productFacet: 'product',
      revision: '2.1',
      tag: 'release/north/2.1',
      tagObject: 'a'.repeat(40),
      commit: 'c0ffee1234567890c0ffee1234567890c0ffee12',
      notes: 'Torque values corrected.',
      notesByLanguage: {},
      major: false,
      publishedBy: { kind: 'user', id: 'publisher' },
      publishedAt: '2026-11-18T10:00:00Z',
      withdrawal: null,
      ...attributes,
    },
  };
};

/** Where a release's files stand (`meta.outputs`), done and failed counted, the rest queued. */
export const progress = (
  state: OutputProgress['state'],
  total = 0,
  done = 0,
  failed = 0,
  rendering = 0,
): OutputProgress => ({
  state,
  total,
  queued: total - done - failed - rendering,
  rendering,
  done,
  failed,
  refused: null,
  queue: null,
});

/** A release whose planning was refused (#477): too many files; `wanted` null for a reader. */
export const refused = (
  wanted: number | null = 5952,
  max = 2000,
): OutputProgress => ({
  ...progress('failed'),
  refused: { reason: 'too-many-outputs', wanted, max },
});

/** `GET /releases/:id`'s document: the release with where its files stand. */
export const detail = (
  item: ReleaseItem = release(),
  outputs: OutputProgress | null = progress('done', 3, 3),
): { data: ReleaseDetail } => ({ data: { ...item, meta: { outputs } } });

export const output = (
  id: string,
  over: Partial<ReleaseOutput['attributes']> = {},
): ReleaseOutput => ({
  type: 'ReleaseOutput',
  id,
  attributes: {
    manual: 'operating',
    variant: 'model=large',
    lang: 'en',
    kind: 'pdf',
    audience: null,
    state: 'done',
    sha256: over.state && over.state !== 'done' ? null : 'b'.repeat(64),
    size: over.state && over.state !== 'done' ? null : 2048,
    error: null,
    createdAt: '2026-11-18T10:00:00Z',
    updatedAt: '2026-11-18T10:01:00Z',
    finishedAt: '2026-11-18T10:01:00Z',
    ...over,
  },
  meta: {
    reusedFrom: null,
    attempts: 1,
    retries: 0,
    withdrawn: false,
    design: {
      id: 'classic',
      name: 'Classic',
      source: 'project',
      missing: false,
    },
  },
  links: { file: null },
});

export const change = (
  manual: string,
  lang: string,
  modules: ReleaseChange['meta']['modules'] = [],
  kind: ReleaseChange['meta']['change'] = 'changed',
): ReleaseChange => ({
  type: 'ReleaseChange',
  id: `${lang}/${manual}`,
  attributes: { manual, lang },
  meta: { change: kind, fields: [], modules },
});

export const LINE_ID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a60';

/** A maintenance line as the API sends it, for tests: North 2.1's, open, its branch named by the server. */
export const maintenanceLine = (
  over: Partial<MaintenanceLine['attributes']> & {
    id?: string;
    baseRelease?: string;
    head?: string | null;
  } = {},
): MaintenanceLine => {
  const { id, baseRelease, head, ...attributes } = over;
  return {
    type: 'MaintenanceLine',
    id: id ?? LINE_ID,
    attributes: {
      product: 'north',
      revision: '2.1',
      branch: 'maintenance/north/2.1',
      baseCommit: 'c0ffee1234567890c0ffee1234567890c0ffee12',
      state: 'open',
      createdBy: { kind: 'user', id: 'publisher' },
      createdAt: '2026-11-19T10:00:00Z',
      closedBy: null,
      closedAt: null,
      ...attributes,
    },
    relationships: {
      baseRelease: { data: { type: 'Release', id: baseRelease ?? RELEASE_ID } },
    },
    meta: {
      head:
        head === undefined ? 'feed1234567890feed1234567890feed12345678' : head,
    },
  };
};

export const manual = (id: string, title: string): ManualItem =>
  ({
    type: 'Manual',
    id,
    attributes: {
      schemaVersion: 1,
      title,
      variants: [{ model: 'large' }],
      textAttributes: {},
      entries: [],
    },
    meta: {
      variants: [
        { slug: 'model=large', label: 'Large', values: { model: 'large' } },
      ],
      issues: [],
      design: { id: 'builtin', name: null, source: 'builtin', missing: false },
    },
  }) as ManualItem;

export const config = (): ProjectConfig =>
  ({
    languages: { source: 'en', targets: ['de'] },
    moduleTypes: [],
    audiences: [],
    facets: [
      {
        id: 'product',
        label: 'Product',
        values: [
          { id: 'north', label: 'North' },
          { id: 'south', label: 'South' },
        ],
      },
    ],
    variantAttributes: [],
    textAttributes: [],
    safetySymbols: [],
    outputLabels: {},
    maxHeadingLevel: 3,
    codeLanguages: [],
    pdf: { standard: 'ua-1' },
    delivery: {
      access: 'signed-in',
      missingLanguage: 'picker',
      pdfQrCode: 'none',
      manuals: {},
    },
  }) as ProjectConfig;

/** A paged document of `data`, every item on one page. */
export const paged = <T>(
  data: readonly T[],
  total = data.length,
  meta: Record<string, unknown> = {},
) => ({
  data,
  meta: {
    page: {
      currentPage: 1,
      lastPage: Math.max(1, Math.ceil(total / 50)),
      perPage: 50,
      total,
    },
    ...meta,
  },
  links: { self: '', first: '', last: '', prev: null, next: null },
});

/**
 * Answers every request waiting (and those they lead to, a few rounds) with the first handler
 * whose test matches; a handler returns the body, or a `[status, body]` pair for an error.
 */
export async function answer(
  http: HttpTestingController,
  handlers: readonly (readonly [
    (req: TestRequest['request']) => boolean,
    (req: TestRequest['request']) => unknown,
  ])[],
  settle: () => Promise<void>,
  rounds = 6,
): Promise<TestRequest['request'][]> {
  const seen: TestRequest['request'][] = [];
  for (let round = 0; round < rounds; round++) {
    const waiting = http.match(() => true);
    if (waiting.length === 0) break;
    for (const req of waiting) {
      seen.push(req.request);
      const handler = handlers.find(([test]) => test(req.request));
      if (!handler) {
        req.flush(
          { errors: [{ status: '404', code: 'not-found', title: '' }] },
          { status: 404, statusText: 'Not Found' },
        );
        continue;
      }
      const body = handler[1](req.request);
      if (Array.isArray(body) && typeof body[0] === 'number') {
        req.flush(body[1], { status: body[0], statusText: 'Error' });
      } else {
        req.flush(body as object);
      }
    }
    await settle();
  }
  return seen;
}
