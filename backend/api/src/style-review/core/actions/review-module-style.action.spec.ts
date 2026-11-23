import { type Module, ProjectConfig } from '@openfolia/content-model';
import { actorWith } from '../../../../tests/fakes/actors.js';
import { FakeAuditLog } from '../../../../tests/fakes/fake-audit-log.js';
import { FakeChangeSetStore } from '../../../../tests/fakes/fake-change-set-store.js';
import {
  config as baseConfig,
  FakeSnapshot,
  module,
} from '../../../../tests/fakes/fake-content.js';
import { FakeStyleReviewer } from '../../../../tests/fakes/fake-style-reviewer.js';
import { FakeUnitOfWork } from '../../../../tests/fakes/fake-unit-of-work.js';
import { FakeWorkingCopyStore } from '../../../../tests/fakes/fake-working-copy-store.js';
import type { Actor } from '../../../access/core/actor.js';
import type { Permission } from '../../../access/core/permissions.js';
import { ForbiddenError, NotFoundError } from '../../../base/core/errors.js';
import { GetWorkingCopyAction } from '../../../change-sets/core/actions/get-working-copy.action.js';
import { ChangeSetAuthoredBranches } from '../../../change-sets/core/change-set-authored-branches.js';
import {
  type ChangeSet,
  changeSetBranch,
  newChangeSetId,
} from '../../../change-sets/core/change-set.js';
import { OpenSnapshotAction } from '../../../content/core/actions/open-snapshot.action.js';
import {
  ContentRepository,
  type ContentSnapshot,
} from '../../../content/core/content.repository.js';
import { StyleReviewer } from '../style-reviewer.js';
import {
  MAX_CONCURRENT_REVIEWS,
  MAX_REVIEW_CHARS,
  ReviewModuleStyleAction,
} from './review-module-style.action.js';

const EDITING: Permission[] = [
  'content.read',
  'content.read.draft',
  'content.edit',
];
const editor = (id: string): Actor => ({ ...actorWith(EDITING), id });
const author = editor('sample-author');
const other = editor('sample-other');

class FakeRepository extends ContentRepository {
  readonly branches = new Map<string, ContentSnapshot>();
  readonly main: ContentSnapshot = new FakeSnapshot();

  at(ref: string): Promise<ContentSnapshot | undefined> {
    return Promise.resolve(ref === 'main' ? this.main : this.branches.get(ref));
  }

  refs() {
    return Promise.resolve({
      branches: [
        { name: 'main', commit: this.main.commit },
        ...[...this.branches].map(([name, s]) => ({
          name,
          commit: s.commit,
        })),
      ],
      tags: [],
    });
  }
}

/** A module with a paragraph, an attribute in a second one, and a section title. */
const charging = (): Module => ({
  ...module('charging'),
  blocks: [
    {
      type: 'section',
      id: 's',
      title: [{ type: 'text', text: 'Charging the battery' }],
      blocks: [
        {
          type: 'paragraph',
          id: 'p1',
          content: [
            { type: 'text', text: 'Utilize the charger in order to charge.' },
          ],
        },
        {
          type: 'paragraph',
          id: 'p2',
          content: [
            { type: 'text', text: 'Switch off ' },
            { type: 'attribute', name: 'product' },
            { type: 'text', text: ' first.' },
          ],
        },
        {
          type: 'literal',
          id: 'l',
          text: 'secret literal',
        },
      ],
    },
  ],
});

function setUp(
  options: {
    reviewer?: StyleReviewer;
    modules?: Module[];
    styleGuide?: string;
    perMinute?: number;
    timeoutMs?: number;
  } = {},
) {
  const id = newChangeSetId();
  const now = new Date();
  const mine: ChangeSet = {
    id,
    title: 'x',
    description: null,
    author: { kind: 'user', id: author.id },
    baseRef: 'main',
    baseCommit: 'a'.repeat(40),
    baseReleased: true,
    branch: changeSetBranch(id),
    state: 'draft',
    createdAt: now,
    updatedAt: now,
  };
  const repository = new FakeRepository();
  const config = ProjectConfig.parse({
    ...baseConfig,
    textAttributes: [{ id: 'product', label: 'Product' }],
    ...(options.styleGuide !== undefined && { styleGuide: options.styleGuide }),
  });
  const branch = new FakeSnapshot({
    config,
    modules: options.modules ?? [charging()],
  });
  repository.branches.set(mine.branch, branch);
  const changeSets = new FakeChangeSetStore([mine]);
  const copies = new FakeWorkingCopyStore();
  const audit = new FakeAuditLog();
  const unit = new FakeUnitOfWork();
  const open = new OpenSnapshotAction(
    repository,
    new ChangeSetAuthoredBranches(changeSets),
  );
  const reviewer = options.reviewer ?? new FakeStyleReviewer();
  const action = new ReviewModuleStyleAction(
    reviewer,
    {
      perMinute: options.perMinute ?? 100,
      timeoutMs: options.timeoutMs ?? 5_000,
    },
    new GetWorkingCopyAction(changeSets, copies, open),
    open,
    audit,
    unit,
  );
  const review = (actor: Actor = author, moduleId = 'charging') =>
    action.handle({ actor, changeSetId: id, lang: 'en', moduleId });
  return { mine, branch, copies, audit, reviewer, review };
}

/** Off, as the default adapter (`NoStyleReviewer`, in `repos/`) is. */
class OffStyleReviewer extends StyleReviewer {
  readonly configured = false;
  review(): never {
    throw new Error('not configured');
  }
}

const fake = (t: { reviewer: StyleReviewer }) =>
  t.reviewer as FakeStyleReviewer;

describe('ReviewModuleStyleAction', () => {
  it('is 404 not-configured with the default reviewer, before reading anything', async () => {
    const t = setUp({ reviewer: new OffStyleReviewer() });
    await expect(t.review()).rejects.toMatchObject({ code: 'not-configured' });
    // Not even a missing change set is looked up.
    await expect(t.review(author, 'nothing')).rejects.toMatchObject({
      code: 'not-configured',
    });
    expect(t.audit.events).toEqual([]);
  });

  it('needs content.edit', async () => {
    const t = setUp();
    await expect(
      t.review({
        ...actorWith(['content.read', 'content.read.draft']),
        id: author.id,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(fake(t).requests).toEqual([]);
  });

  it('sends only the translatable text of the module and the style guide', async () => {
    const t = setUp({ styleGuide: 'Write plain English.' });
    await t.review();
    expect(fake(t).requests).toEqual([
      {
        lang: 'en',
        styleGuide: 'Write plain English.',
        units: [
          {
            blockId: 's',
            kind: 'section',
            parts: [{ field: 'title', text: 'Charging the battery' }],
          },
          {
            blockId: 'p1',
            kind: 'paragraph',
            parts: [
              {
                field: 'content',
                text: 'Utilize the charger in order to charge.',
              },
            ],
          },
          {
            blockId: 'p2',
            kind: 'paragraph',
            parts: [{ field: 'content', text: 'Switch off {product} first.' }],
          },
        ],
      },
    ]);
    const sent = JSON.stringify(fake(t).requests);
    expect(sent).not.toContain('secret literal');
    expect(sent).not.toContain('Title of charging');
  });

  it('reviews the working copy when there is one, and says which version', async () => {
    const t = setUp();
    const saved = charging();
    saved.blocks = [
      {
        type: 'paragraph',
        id: 'w',
        content: [{ type: 'text', text: 'Saved text.' }],
      },
    ];
    t.copies.copies.set(`${t.mine.id}:module/en/charging`, {
      changeSetId: t.mine.id,
      subject: { type: 'module', lang: 'en', moduleId: 'charging' },
      content: saved,
      baseCommit: t.branch.commit,
      version: 3,
      updatedBy: { kind: 'user', id: author.id },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const review = await t.review();
    expect(fake(t).requests[0]?.units).toEqual([
      {
        blockId: 'w',
        kind: 'paragraph',
        parts: [{ field: 'content', text: 'Saved text.' }],
      },
    ]);
    expect(review).toMatchObject({ version: 3, baseCommit: t.branch.commit });
  });

  it('returns suggestions inside the text, in document order, and drops the rest', async () => {
    const t = setUp();
    fake(t).answer = [
      // In order: p1 after s.
      {
        blockId: 'p1',
        field: 'content',
        start: 0,
        end: 8,
        message: 'Plainer.',
        replacement: 'Use',
      },
      {
        blockId: 's',
        field: 'title',
        start: 0,
        end: 8,
        message: 'Shorter.',
        replacement: 'Charge',
      },
      {
        blockId: 'p1',
        field: 'content',
        start: 20,
        end: 31,
        message: 'Wordy.',
        replacement: 'to',
      },
      // Remark only.
      {
        blockId: 'p2',
        field: 'content',
        start: 0,
        end: 10,
        message: '  Say why.\n',
      },
      // Dropped: an unknown block, a field the block has not, out of bounds, empty,
      // over the attribute, a replacement with a line break, no message, the same text.
      { blockId: 'nope', field: 'content', start: 0, end: 1, message: 'x' },
      { blockId: 'p1', field: 'title', start: 0, end: 1, message: 'x' },
      { blockId: 'p1', field: 'content', start: 30, end: 400, message: 'x' },
      { blockId: 'p1', field: 'content', start: 3, end: 3, message: 'x' },
      { blockId: 'p2', field: 'content', start: 5, end: 15, message: 'x' },
      {
        blockId: 'p1',
        field: 'content',
        start: 0,
        end: 8,
        message: 'x',
        replacement: 'a\nb',
      },
      { blockId: 'p1', field: 'content', start: 0, end: 8, message: ' ' },
      {
        blockId: 'p1',
        field: 'content',
        start: 0,
        end: 8,
        message: 'x',
        replacement: 'Utilize ',
      },
      { blockId: 'l', field: 'content', start: 0, end: 3, message: 'x' },
      // Hidden direction overrides and a line separator in a replacement.
      {
        blockId: 'p1',
        field: 'content',
        start: 0,
        end: 8,
        message: 'x',
        replacement: 'U\u202ese',
      },
      {
        blockId: 'p1',
        field: 'content',
        start: 0,
        end: 8,
        message: 'x',
        replacement: 'U\u2028se',
      },
      {
        blockId: 'p1',
        field: 'content',
        start: 0,
        end: 8,
        message: 'x',
        replacement: 'U\ud800se',
      },
      // A duplicate of the first.
      {
        blockId: 'p1',
        field: 'content',
        start: 0,
        end: 8,
        message: 'Plainer.',
        replacement: 'Use',
      },
    ];
    const review = await t.review();
    expect(
      review.suggestions.map((s) => [
        s.blockId,
        s.field,
        s.range,
        s.original,
        s.replacement,
        s.message,
        s.rule,
      ]),
    ).toEqual([
      [
        's',
        'title',
        { start: 0, end: 8 },
        'Charging',
        'Charge',
        'Shorter.',
        'model',
      ],
      [
        'p1',
        'content',
        { start: 0, end: 8 },
        'Utilize ',
        'Use',
        'Plainer.',
        'model',
      ],
      [
        'p1',
        'content',
        { start: 20, end: 31 },
        'in order to',
        'to',
        'Wordy.',
        'model',
      ],
      [
        'p2',
        'content',
        { start: 0, end: 10 },
        'Switch off',
        null,
        'Say why.',
        'model',
      ],
    ]);
    expect(review.dropped).toBe(13);
    expect(new Set(review.suggestions.map((s) => s.id)).size).toBe(4);
  });

  it('sends each callout legend as a unit of its own, and keeps suggestions on it (#573)', async () => {
    const pictured: Module = {
      ...module('charging'),
      blocks: [
        {
          type: 'image',
          id: 'img',
          asset: 'a'.repeat(64),
          alt: 'The charger',
          callouts: [
            {
              id: 'img-1',
              anchor: { x: 0.2, y: 0.3 },
              legend: [{ type: 'text', text: 'Utilize this plug' }],
            },
            {
              id: 'img-2',
              anchor: { x: 0.6, y: 0.4 },
              legend: [{ type: 'text', text: 'Indicator lamp' }],
            },
          ],
        },
      ],
    };
    const t = setUp({ modules: [pictured] });
    fake(t).answer = [
      {
        blockId: 'img-1',
        field: 'legend',
        start: 0,
        end: 7,
        message: 'Use “use”.',
        replacement: 'Use',
      },
      // The legend's field on the image itself: not a part that was sent.
      {
        blockId: 'img',
        field: 'legend',
        start: 0,
        end: 3,
        message: 'x',
        replacement: 'y',
      },
    ];
    const review = await t.review();
    expect(fake(t).requests[0]?.units).toEqual([
      {
        blockId: 'img',
        kind: 'image',
        parts: [{ field: 'alt', text: 'The charger' }],
      },
      {
        blockId: 'img-1',
        kind: 'callout',
        parts: [{ field: 'legend', text: 'Utilize this plug' }],
      },
      {
        blockId: 'img-2',
        kind: 'callout',
        parts: [{ field: 'legend', text: 'Indicator lamp' }],
      },
    ]);
    expect(review.suggestions).toEqual([
      expect.objectContaining({
        blockId: 'img-1',
        field: 'legend',
        range: { start: 0, end: 7 },
        original: 'Utilize',
        replacement: 'Use',
      }),
    ]);
    expect(review.dropped).toBe(1);
  });

  it('records one audit event per review, without any text', async () => {
    const t = setUp();
    fake(t).answer = [
      {
        blockId: 'p1',
        field: 'content',
        start: 0,
        end: 8,
        message: 'Plainer.',
        replacement: 'Use',
      },
      { blockId: 'nope', field: 'content', start: 0, end: 1, message: 'x' },
    ];
    await t.review();
    expect(t.audit.events).toEqual([
      expect.objectContaining({
        actor: { kind: 'user', id: author.id },
        action: 'module.style-review',
        subject: { type: 'module', id: 'en/charging' },
        comment: null,
        data: {
          changeSetId: t.mine.id,
          outcome: 'ok',
          suggestions: 1,
          dropped: 1,
        },
      }),
    ]);
    expect(JSON.stringify(t.audit.events)).not.toMatch(/Utilize|Use|Plainer/);
  });

  it('is only for the change set’s author, as its working copy is', async () => {
    const t = setUp();
    await expect(t.review(other)).rejects.toBeInstanceOf(ForbiddenError);
    const outsider = {
      ...actorWith(['content.read', 'content.edit']),
      id: 'x',
    };
    await expect(t.review(outsider)).rejects.toBeInstanceOf(NotFoundError);
    expect(fake(t).requests).toEqual([]);
    expect(t.audit.events).toEqual([]);
  });

  it('does not send a module that is not there', async () => {
    const t = setUp();
    await expect(t.review(author, 'missing')).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(fake(t).requests).toEqual([]);
  });

  it('sends nothing for a module without text', async () => {
    const empty: Module = {
      ...module('charging'),
      blocks: [{ type: 'literal', id: 'l', text: 'only code' }],
    };
    const t = setUp({ modules: [empty] });
    const review = await t.review();
    expect(review.suggestions).toEqual([]);
    expect(fake(t).requests).toEqual([]);
    expect(t.audit.events[0]?.data).toMatchObject({ outcome: 'empty' });
  });

  it('refuses text longer than MAX_REVIEW_CHARS (422 too-large), sending nothing', async () => {
    const long: Module = {
      ...module('charging'),
      blocks: [
        {
          type: 'paragraph',
          id: 'p',
          content: [{ type: 'text', text: 'x'.repeat(MAX_REVIEW_CHARS - 5) }],
        },
      ],
    };
    const t = setUp({ modules: [long], styleGuide: 'Short sentences.' });
    await expect(t.review()).rejects.toMatchObject({
      code: 'too-large',
      meta: { max: MAX_REVIEW_CHARS },
    });
    expect(fake(t).requests).toEqual([]);
  });

  it('limits reviews per person and minute (429 with the seconds to wait)', async () => {
    const t = setUp({ perMinute: 2 });
    await t.review();
    await t.review();
    const refused = t.review();
    await expect(refused).rejects.toMatchObject({ code: 'rate-limited' });
    await expect(refused).rejects.toHaveProperty('retryAfterSeconds');
    expect(fake(t).requests).toHaveLength(2);
  });

  it('cuts a review off after the timeout (503 style-review-timeout), even if the adapter ignores the signal', async () => {
    const t = setUp({ timeoutMs: 20 });
    fake(t).hang = true;
    fake(t).ignoreSignal = true;
    await expect(t.review()).rejects.toMatchObject({
      code: 'style-review-timeout',
      retryAfterSeconds: 1,
    });
    expect(t.audit.events[0]?.data).toMatchObject({ outcome: 'timeout' });
  });

  it('answers a failing endpoint with 503, without passing its error on', async () => {
    const t = setUp();
    fake(t).fail = new Error('https://secret.example/?key=sk-123 broke');
    const failed = t.review();
    await expect(failed).rejects.toMatchObject({
      code: 'style-review-unavailable',
    });
    await expect(failed).rejects.not.toHaveProperty(
      'message',
      expect.stringContaining('sk-123'),
    );
    expect(t.audit.events[0]?.data).toMatchObject({ outcome: 'failed' });
  });

  it('runs at most MAX_CONCURRENT_REVIEWS at once (503 style-review-busy)', async () => {
    const t = setUp({ timeoutMs: 200 });
    fake(t).hang = true;
    const running = Array.from({ length: MAX_CONCURRENT_REVIEWS }, () =>
      t.review(),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(t.review()).rejects.toMatchObject({
      code: 'style-review-busy',
    });
    await Promise.allSettled(running);
    // Once they ended, a review runs again.
    fake(t).hang = false;
    await expect(t.review()).resolves.toMatchObject({ suggestions: [] });
  });
});
