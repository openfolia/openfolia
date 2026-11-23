import { FakeReleaseDiffStore } from '../../../../tests/fakes/fake-release-diff-store.js';
import { ProjectConfig } from '@openfolia/content-model';
import { actorWith, READER } from '../../../../tests/fakes/actors.js';
import { FakeAuditLog } from '../../../../tests/fakes/fake-audit-log.js';
import { FakeAuthoredBranches } from '../../../../tests/fakes/fake-authored-branches.js';
import {
  config as baseConfig,
  FakeSnapshot,
} from '../../../../tests/fakes/fake-content.js';
import {
  FakeMaintenanceBranches,
  FakeMaintenanceLineStore,
} from '../../../../tests/fakes/fake-maintenance-lines.js';
import { FakeJobQueue } from '../../../../tests/fakes/fake-job-queue.js';
import { FakeChangeSetBranches } from '../../../../tests/fakes/fake-change-set-branches.js';
import { FakeReleaseEvents } from '../../../../tests/fakes/fake-release-events.js';
import { FakeReleaseStore } from '../../../../tests/fakes/fake-release-store.js';
import { FakeReleaseTags } from '../../../../tests/fakes/fake-release-tags.js';
import { FakeRepository } from '../../../../tests/fakes/fake-repository.js';
import { FakeUnitOfWork } from '../../../../tests/fakes/fake-unit-of-work.js';
import type { Actor } from '../../../access/core/actor.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
} from '../../../base/core/errors.js';
import { OpenSnapshotAction } from '../../../content/core/actions/open-snapshot.action.js';
import { CreateReleaseAction } from './create-release.action.js';
import { ReleaseChangeReader } from './release-changes.action.js';
import {
  CloseMaintenanceLineAction,
  GetMaintenanceLineAction,
  ListMaintenanceLineReleasesAction,
  ListMaintenanceLinesAction,
  StartMaintenanceLineAction,
} from './maintenance-lines.action.js';

const config = ProjectConfig.parse({
  ...baseConfig,
  facets: [
    {
      id: 'product-line',
      label: 'Product line',
      values: [
        { id: 'tuggers', label: 'Tuggers' },
        { id: 'lifters', label: 'Lifters' },
      ],
    },
  ],
});

const publisher: Actor = {
  ...actorWith(['content.read', 'content.read.draft', 'release.publish']),
  id: 'sample-publisher',
};
const page = { number: 1, size: 20 };

/** A repository whose `main` is a release, and a maintenance branch with a fix. */
function setup() {
  const repo = new FakeRepository(new FakeSnapshot({ config }));
  const open = new OpenSnapshotAction(repo, new FakeAuthoredBranches());
  const tags = new FakeReleaseTags();
  const releases = new FakeReleaseStore();
  const lines = new FakeMaintenanceLineStore();
  const branches = new FakeMaintenanceBranches();
  const audit = new FakeAuditLog();
  const unit = new FakeUnitOfWork();
  const jobs = new FakeJobQueue();
  releases.lineOf = (id) => lines.released.get(id);
  const create = new CreateReleaseAction(
    open,
    tags,
    releases,
    audit,
    unit,
    new FakeReleaseEvents(),
    new ReleaseChangeReader(
      releases,
      open,
      new FakeChangeSetBranches(),
      lines,
      new FakeReleaseDiffStore(),
    ),
    jobs,
    lines,
  );
  return {
    jobs,
    repo,
    tags,
    releases,
    lines,
    branches,
    audit,
    cut: (over: Partial<Parameters<CreateReleaseAction['handle']>[0]> = {}) =>
      create.handle({
        actor: publisher,
        product: 'tuggers',
        revision: '2.1',
        notes: null,
        ...over,
      }),
    start: new StartMaintenanceLineAction(
      open,
      releases,
      lines,
      branches,
      audit,
      unit,
    ),
    close: new CloseMaintenanceLineAction(
      open,
      releases,
      lines,
      branches,
      audit,
      unit,
    ),
    list: new ListMaintenanceLinesAction(lines, branches),
    get: new GetMaintenanceLineAction(lines, branches),
    lineReleases: new ListMaintenanceLineReleasesAction(lines, releases),
  };
}

const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => 'ok',
    (e: unknown) =>
      e instanceof ConflictError || e instanceof UnprocessableError
        ? e.code
        : e instanceof ForbiddenError
          ? 'forbidden'
          : e instanceof NotFoundError
            ? 'not-found'
            : String(e),
  );

describe('StartMaintenanceLineAction', () => {
  it('creates the branch at exactly the release’s commit, records the line and audits it', async () => {
    const t = setup();
    const release = await t.cut();
    const { line, head } = await t.start.handle({
      actor: publisher,
      releaseId: release.id,
    });
    expect(line).toEqual({
      id: expect.any(String),
      product: 'tuggers',
      revision: '2.1',
      baseRelease: release.id,
      baseCommit: release.commit,
      branch: 'maintenance/tuggers/2.1',
      createdBy: { kind: 'user', id: 'sample-publisher' },
      createdAt: expect.any(Date),
      closedAt: null,
      closedBy: null,
    });
    expect(head).toBe(release.commit);
    expect(t.branches.heads.get(line.branch)).toBe(release.commit);
    expect(t.lines.rows).toEqual([line]);
    expect(t.audit.events.at(-1)).toMatchObject({
      action: 'maintenance-line.start',
      subject: { type: 'maintenance-line', id: line.id },
      data: {
        product: 'tuggers',
        revision: '2.1',
        baseRelease: release.id,
        branch: line.branch,
        commit: release.commit,
      },
    });
  });

  it('takes a branch an earlier attempt made at the same commit, and refuses one elsewhere', async () => {
    const t = setup();
    const release = await t.cut();
    t.branches.heads.set('maintenance/tuggers/2.1', release.commit);
    const { line } = await t.start.handle({
      actor: publisher,
      releaseId: release.id,
    });
    expect(t.audit.events.at(-1)?.data).toMatchObject({ branchExisted: true });

    const other = await t.cut({ revision: '2.2' });
    t.branches.heads.set('maintenance/tuggers/2.2', 'f'.repeat(40));
    expect(
      await codeOf(t.start.handle({ actor: publisher, releaseId: other.id })),
    ).toBe('branch-exists');
    expect(t.lines.rows).toEqual([line]);
  });

  it('is one line per release, and needs a published release', async () => {
    const t = setup();
    const release = await t.cut();
    const { line } = await t.start.handle({
      actor: publisher,
      releaseId: release.id,
    });
    await expect(
      t.start.handle({ actor: publisher, releaseId: release.id }),
    ).rejects.toMatchObject({
      code: 'maintenance-line-exists',
      meta: { maintenanceLineId: line.id },
    });
    expect(
      await codeOf(
        t.start.handle({ actor: publisher, releaseId: 'not-a-release' }),
      ),
    ).toBe('not-found');
  });

  it('needs release.publish covering the product everywhere', async () => {
    const t = setup();
    const release = await t.cut();
    const narrow: Actor = {
      kind: 'user',
      id: 'narrow',
      roles: [
        { id: 'r', name: 'R', permissions: ['content.read'], scope: {} },
        {
          id: 'p',
          name: 'P',
          permissions: ['release.publish'],
          scope: { languages: ['en'] },
        },
      ],
    };
    expect(
      await codeOf(t.start.handle({ actor: narrow, releaseId: release.id })),
    ).toBe('forbidden');
    expect(
      await codeOf(t.start.handle({ actor: READER, releaseId: release.id })),
    ).toBe('forbidden');
    expect(t.branches.heads.size).toBe(0);
  });
});

describe('CloseMaintenanceLineAction', () => {
  it('closes once, audited with the comment, holding the line’s row', async () => {
    const t = setup();
    const release = await t.cut();
    const { line } = await t.start.handle({
      actor: publisher,
      releaseId: release.id,
    });
    const closed = await t.close.handle({
      actor: publisher,
      id: line.id,
      comment: 'End of support.',
    });
    expect(closed.line).toMatchObject({
      closedAt: expect.any(Date),
      closedBy: { kind: 'user', id: 'sample-publisher' },
    });
    expect(t.lines.locked).toEqual([{ id: line.id, mode: 'update' }]);
    expect(t.audit.events.at(-1)).toMatchObject({
      action: 'maintenance-line.close',
      subject: { type: 'maintenance-line', id: line.id },
      comment: 'End of support.',
    });
    await expect(
      t.close.handle({ actor: publisher, id: line.id }),
    ).rejects.toMatchObject({
      code: 'invalid-state',
      meta: { state: 'closed' },
    });
    expect(await codeOf(t.close.handle({ actor: publisher, id: 'nope' }))).toBe(
      'not-found',
    );
  });

  it('needs release.publish', async () => {
    const t = setup();
    const release = await t.cut();
    const { line } = await t.start.handle({
      actor: publisher,
      releaseId: release.id,
    });
    expect(await codeOf(t.close.handle({ actor: READER, id: line.id }))).toBe(
      'forbidden',
    );
    expect(t.lines.rows[0]?.closedAt).toBeNull();
  });
});

describe('releases from a line', () => {
  it('cuts a release from the line’s head, of its product, listed under the line', async () => {
    const t = setup();
    const base = await t.cut();
    const { line } = await t.start.handle({
      actor: publisher,
      releaseId: base.id,
    });
    const fixed = new FakeSnapshot({ config });
    t.repo.branches.set(line.branch, fixed);
    const release = await t.cut({
      revision: '2.1.1',
      maintenanceLine: line.id,
    });
    expect(release.commit).toBe(fixed.commit);
    expect(t.tags.tags.get('release/tuggers/2.1.1')?.commit).toBe(fixed.commit);
    expect(t.audit.events.at(-1)?.data).toMatchObject({
      maintenanceLine: line.id,
      branch: line.branch,
    });
    // Its outputs are planned as any release's (#249).
    expect(t.jobs.jobs.at(-1)).toMatchObject({
      payload: { releaseId: release.id },
      key: release.id,
    });
    expect(
      await t.lineReleases.handle({ actor: publisher, id: line.id, page }),
    ).toEqual({ total: 1, items: [release] });
    expect(
      await t.lineReleases
        .handle({ actor: publisher, id: 'nope', page })
        .catch((e: unknown) => e instanceof NotFoundError),
    ).toBe(true);
  });

  it('refuses another product and an unknown line, writing nothing', async () => {
    const t = setup();
    const base = await t.cut();
    const { line } = await t.start.handle({
      actor: publisher,
      releaseId: base.id,
    });
    expect(
      await codeOf(
        t.cut({
          product: 'lifters',
          revision: '1',
          maintenanceLine: line.id,
        }),
      ),
    ).toBe('invalid-product');
    expect(
      await codeOf(t.cut({ revision: '3', maintenanceLine: 'nope' })),
    ).toBe('unknown-maintenance-line');
    expect(t.releases.rows).toHaveLength(1);
    expect(t.lines.released.size).toBe(0);
  });
});

describe('reading lines', () => {
  it('lists newest first, filtered, and reads one with its head; needs content.read.draft', async () => {
    const t = setup();
    const first = await t.start.handle({
      actor: publisher,
      releaseId: (await t.cut()).id,
    });
    const second = await t.start.handle({
      actor: publisher,
      releaseId: (await t.cut({ revision: '2.2' })).id,
    });
    await t.close.handle({ actor: publisher, id: first.line.id });
    const all = await t.list.handle({ actor: publisher, filter: {}, page });
    expect(all.total).toBe(2);
    expect(
      (
        await t.list.handle({
          actor: publisher,
          filter: { state: 'open' },
          page,
        })
      ).items.map((v) => v.line.id),
    ).toEqual([second.line.id]);
    expect(
      await t.get.handle({ actor: publisher, id: second.line.id }),
    ).toEqual({ line: second.line, head: second.line.baseCommit });
    expect(await codeOf(t.get.handle({ actor: publisher, id: 'nope' }))).toBe(
      'not-found',
    );
    expect(
      await codeOf(t.list.handle({ actor: READER, filter: {}, page })),
    ).toBe('forbidden');
  });
});
