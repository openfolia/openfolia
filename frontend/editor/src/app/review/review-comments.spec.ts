import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { MeService } from '../permissions/me';
import {
  ReviewComments,
  splitModule,
  threadsFrom,
  type Comment,
} from './review-comments';

const comment = (
  id: string,
  thread: string,
  blockId = 'p1',
  body = id,
): Comment =>
  ({
    type: 'Comment',
    id,
    attributes: {
      subject: { type: 'module', lang: 'en', moduleId: 'charging' },
      blockId,
      body,
      author: { kind: 'user', id: 'sample-reviewer' },
      commit: 'c'.repeat(40),
      createdAt: '2026-11-18T10:00:00.000Z',
      resolvedAt: null,
      resolvedBy: null,
    },
    relationships: {
      changeSet: { data: { type: 'ChangeSet', id: 'cs1' } },
      thread: { data: { type: 'Comment', id: thread } },
    },
    meta: { orphaned: false, deleted: false, editedAt: null },
  }) as Comment;

const page = (data: Comment[], lastPage = 1, number = 1) => ({
  data,
  meta: { page: { number, size: 200, total: data.length, lastPage } },
  links: {},
});

describe('threadsFrom', () => {
  it('puts each reply under its thread, in order', () => {
    const threads = threadsFrom([
      comment('t1', 't1'),
      comment('r1', 't1'),
      comment('t2', 't2'),
      comment('r2', 't1'),
    ]);
    expect(threads.map((t) => t.first.id)).toEqual(['t1', 't2']);
    expect(threads[0]?.replies.map((r) => r.id)).toEqual(['r1', 'r2']);
  });

  it('splits a module key at its first slash', () => {
    expect(splitModule('en/charging')).toEqual(['en', 'charging']);
  });
});

describe('ReviewComments', () => {
  function setup() {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        ReviewComments,
      ],
    });
    const comments = TestBed.inject(ReviewComments);
    comments.reset('cs1');
    comments.me.set({ kind: 'user', id: 'sample-reviewer' });
    comments.canWrite.set(true);
    return { comments, http: TestBed.inject(HttpTestingController) };
  }
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('reads a module’s threads page by page, grouped by block, once', async () => {
    const { comments, http } = setup();
    const done = comments.load('en/charging');
    // Asked twice, read once.
    void comments.load('en/charging');
    const first = http.expectOne(
      (r) => r.url === '/api/change-sets/cs1/comments',
    );
    expect(first.request.params.get('filter[resolved]')).toBe('any');
    first.flush(page([comment('t1', 't1', 'p1')], 2));
    await settle();
    http
      .expectOne(
        (r) =>
          r.url === '/api/change-sets/cs1/comments' &&
          r.params.get('page[number]') === '2',
      )
      .flush(page([comment('t2', 't2', 'p2')], 2, 2));
    await done;
    const byBlock = comments.threadsOf('en/charging');
    expect([...byBlock.keys()]).toEqual(['p1', 'p2']);
    http.verify();
  });

  it('forgets what it read for another change set, and drops a late answer', async () => {
    const { comments, http } = setup();
    const done = comments.load('en/charging');
    const read = http.expectOne(() => true);
    comments.reset('cs2');
    read.flush(page([comment('t1', 't1')]));
    await done;
    expect(comments.threadsOf('en/charging').size).toBe(0);
  });

  it('notes a module whose threads could not be read, and reads it again on request', async () => {
    const { comments, http } = setup();
    const done = comments.load('en/charging');
    http
      .expectOne(() => true)
      .flush(null, { status: 500, statusText: 'Server Error' });
    await done;
    expect(comments.failed('en/charging')).toBe(true);
    void comments.load('en/charging');
    http.expectOne(() => true).flush(page([]));
    await settle();
    expect(comments.failed('en/charging')).toBe(false);
  });

  it('resolves and reopens a thread by its own route, then reads again', async () => {
    const { comments, http } = setup();
    comments.resolve('en/charging', 't1', false);
    const post = http.expectOne('/api/change-sets/cs1/comments/t1/resolve');
    expect(post.request.method).toBe('POST');
    post.flush({ data: comment('t1', 't1') });
    await settle();
    http.expectOne(() => true).flush(page([]));
    await settle();
    comments.resolve('en/charging', 't1', true);
    http
      .expectOne('/api/change-sets/cs1/comments/t1/reopen')
      .flush({ data: comment('t1', 't1') });
    await settle();
    http.expectOne(() => true).flush(page([]));
    await settle();
    http.verify();
  });

  it('answers a thread with a reply naming it', async () => {
    const { comments, http } = setup();
    comments.reply('en/charging', 't1', 'Done.');
    const post = http.expectOne('/api/change-sets/cs1/comments');
    expect(post.request.body).toEqual({
      data: {
        type: 'Comment',
        attributes: { body: 'Done.' },
        relationships: { thread: { data: { type: 'Comment', id: 't1' } } },
      },
    });
    post.flush(
      { data: comment('r1', 't1') },
      { status: 201, statusText: 'Created' },
    );
    await settle();
    http.expectOne(() => true).flush(page([]));
    await settle();
    http.verify();
  });

  it('drops an older read that answers after a newer one', async () => {
    const { comments, http } = setup();
    const first = comments.load('en/charging');
    const second = comments.load('en/charging', true);
    const [older, newer] = http.match(() => true);
    newer?.flush(page([comment('t2', 't2')]));
    await second;
    older?.flush(page([]));
    await first;
    expect([...comments.threadsOf('en/charging').keys()]).toEqual(['p1']);
  });

  it('keeps threads whose block is gone apart from the blocks’ threads', async () => {
    const { comments, http } = setup();
    const orphan = comment('t2', 't2', 'gone');
    const done = comments.load('en/charging');
    http
      .expectOne(() => true)
      .flush(
        page([
          comment('t1', 't1', 'p1'),
          { ...orphan, meta: { ...orphan.meta, orphaned: true } },
        ]),
      );
    await done;
    expect([...comments.threadsOf('en/charging').keys()]).toEqual(['p1']);
    expect(comments.orphansOf('en/charging').map((t) => t.first.id)).toEqual([
      't2',
    ]);
    expect(comments.loaded('en/charging')).toBe(true);
  });

  it('shows a write at once and drops it once the threads are read again', async () => {
    const { comments, http } = setup();
    const done = comments.load('en/charging');
    http.expectOne(() => true).flush(page([comment('t1', 't1')]));
    await done;
    comments.reply('en/charging', 't1', 'Soon.');
    comments.resolve('en/charging', 't1', false);
    const [thread] = comments.threadsOf('en/charging').get('p1') ?? [];
    expect(thread?.replies.map((r) => r.attributes.body)).toEqual(['Soon.']);
    expect(comments.isPending(thread!.replies[0]!)).toBe(true);
    expect(thread?.first.attributes.resolvedAt).not.toBeNull();
    expect(comments.busy('t1')).toBe(true);
    // Another change set: nothing of this one stays.
    comments.reset('cs2');
    expect(comments.threadsOf('en/charging').size).toBe(0);
  });

  it('keeps a taken write shown until a read that started after it is applied', async () => {
    const { comments, http } = setup();
    const done = comments.load('en/charging');
    http.expectOne(() => true).flush(page([comment('t1', 't1')]));
    await done;
    const replies = () =>
      (comments.threadsOf('en/charging').get('p1') ?? [])[0]?.replies.map(
        (r) => r.attributes.body,
      );
    comments.reply('en/charging', 't1', 'A');
    comments.reply('en/charging', 't1', 'B');
    const [a, b] = http.match((r) => r.method === 'POST');
    a?.flush({ data: comment('ra', 't1') }, { status: 201, statusText: '' });
    await settle();
    b?.flush({ data: comment('rb', 't1') }, { status: 201, statusText: '' });
    await settle();
    // A's read is superseded by B's: answering it changes nothing, A stays shown.
    const [readA, readB] = http.match((r) => r.method === 'GET');
    readA?.flush(page([comment('t1', 't1'), comment('ra', 't1', 'p1', 'A')]));
    await settle();
    expect(replies()).toEqual(['A', 'B']);
    readB?.flush(
      page([
        comment('t1', 't1'),
        comment('ra', 't1', 'p1', 'A'),
        comment('rb', 't1', 'p1', 'B'),
      ]),
    );
    await settle();
    expect(replies()).toEqual(['A', 'B']);
    expect(
      comments
        .threadsOf('en/charging')
        .get('p1')?.[0]
        ?.replies.some((r) => comments.isPending(r)),
    ).toBe(false);
  });
});

describe('ReviewComments and a change of person (#716)', () => {
  const person = (id: string) =>
    TestBed.inject(MeService).set({
      id,
      kind: 'user',
      name: id,
      role: '',
      permissions: new Set(['content.read', 'content.review']),
    });
  function setup() {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        ReviewComments,
      ],
    });
    person('u1');
    const comments = TestBed.inject(ReviewComments);
    comments.reset('cs1');
    return { comments, http: TestBed.inject(HttpTestingController) };
  }

  it('forgets the threads read for the previous person, and reads them again for the next', async () => {
    const { comments, http } = setup();
    const done = comments.load('en/charging');
    http.expectOne(() => true).flush(page([comment('t1', 't1')]));
    await done;
    expect(comments.loaded('en/charging')).toBe(true);

    person('u2');
    TestBed.tick();
    expect(comments.loaded('en/charging')).toBe(false);
    expect(comments.threadsOf('en/charging').size).toBe(0);
    const again = comments.load('en/charging');
    http.expectOne(() => true).flush(page([]));
    await again;
    expect(comments.loaded('en/charging')).toBe(true);
  });

  it('drops threads read for the previous person that answer after the change', async () => {
    const { comments, http } = setup();
    const done = comments.load('en/charging');
    const read = http.expectOne(() => true);
    person('u2');
    read.flush(page([comment('t1', 't1')]));
    await done;
    expect(comments.threadsOf('en/charging').size).toBe(0);
  });
});
