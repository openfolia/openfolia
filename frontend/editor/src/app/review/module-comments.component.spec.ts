import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { provideZard } from '@openfolia/ui/core';

import { diffBlocks } from './block-diff';
import { ModuleCommentsComponent } from './module-comments.component';
import { ReviewComments, type Comment } from './review-comments';

const LIST = '/api/change-sets/cs1/comments';

const comment = (id: string, blockId: string, orphaned: boolean): Comment => ({
  type: 'Comment',
  id,
  attributes: {
    subject: { type: 'module', lang: 'en', moduleId: 'charging' },
    blockId,
    body: `On ${blockId}`,
    author: { kind: 'user', id: 'sample-reviewer' },
    commit: 'c'.repeat(40),
    createdAt: '2026-11-18T10:00:00.000Z',
    resolvedAt: null,
    resolvedBy: null,
  },
  relationships: {
    changeSet: { data: { type: 'ChangeSet', id: 'cs1' } },
    thread: { data: { type: 'Comment', id } },
  },
  meta: { orphaned, deleted: false, editedAt: null },
});

const page = (data: Comment[]) => ({
  data,
  meta: { page: { number: 1, size: 200, total: data.length, lastPage: 1 } },
  links: {},
});

async function render() {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideZard(),
      ReviewComments,
    ],
  });
  const comments = TestBed.inject(ReviewComments);
  comments.reset('cs1');
  const http = TestBed.inject(HttpTestingController);
  const fixture = TestBed.createComponent(ModuleCommentsComponent);
  fixture.componentRef.setInput('module', 'en/charging');
  // `gone` was there before and is removed; `typo` never was on either side.
  fixture.componentRef.setInput(
    'nodes',
    diffBlocks(
      [
        { type: 'paragraph', id: 'kept', content: [] },
        { type: 'paragraph', id: 'gone', content: [] },
      ],
      [{ type: 'paragraph', id: 'kept', content: [] }],
    ),
  );
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 0));
      await fixture.whenStable();
    }
  };
  const el = fixture.nativeElement as HTMLElement;
  return { comments, http, settle, el };
}

describe('ModuleCommentsComponent', () => {
  it('shows nothing while there is neither an orphan nor a failure', async () => {
    const t = await render();
    const loaded = t.comments.load('en/charging');
    t.http.expectOne((r) => r.url === LIST).flush(page([]));
    await loaded;
    await t.settle();
    expect(
      t.el.querySelector('[data-slot=orphans]')?.closest('[data-state]'),
    ).toHaveProperty('dataset.state', 'closed');
    expect(
      t.el
        .querySelector('[data-slot=comments-failed]')
        ?.closest('[data-state]'),
    ).toHaveProperty('dataset.state', 'closed');
  });

  it('lists orphaned threads apart, flagged, with what their block was where known', async () => {
    const t = await render();
    const loaded = t.comments.load('en/charging');
    t.http
      .expectOne((r) => r.url === LIST)
      .flush(
        page([
          comment('t1', 'kept', false),
          comment('t2', 'gone', true),
          comment('t3', 'typo', true),
        ]),
      );
    await loaded;
    await t.settle();
    const orphans = t.el.querySelector('[data-slot=orphans]')!;
    expect(orphans.closest('[data-state]')).toHaveProperty(
      'dataset.state',
      'open',
    );
    const threads = [...orphans.querySelectorAll('[data-slot=thread]')];
    expect(threads.map((x) => x.getAttribute('data-thread'))).toEqual([
      't2',
      't3',
    ]);
    expect(threads[0]?.querySelector('[data-slot=anchor]')?.textContent).toBe(
      'on: Paragraph',
    );
    expect(threads[1]?.querySelector('[data-slot=anchor]')).toBeNull();
    expect(threads.every((x) => x.querySelector('[data-slot=orphaned]'))).toBe(
      true,
    );
    expect(orphans.textContent).toContain('2 comments on removed blocks');
  });

  it('says when the threads could not be read, and reads them again on Retry', async () => {
    const t = await render();
    const loaded = t.comments.load('en/charging');
    t.http
      .expectOne((r) => r.url === LIST)
      .flush(null, { status: 503, statusText: 'Unavailable' });
    await loaded;
    await t.settle();
    const notice = t.el.querySelector('[data-slot=comments-failed]')!;
    expect(notice.closest('[data-state]')).toHaveProperty(
      'dataset.state',
      'open',
    );
    notice.querySelector('button')!.click();
    t.http.expectOne((r) => r.url === LIST).flush(page([]));
    await t.settle();
    expect(notice.closest('[data-state]')).toHaveProperty(
      'dataset.state',
      'closed',
    );
  });
});
