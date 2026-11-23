import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { provideZard } from '@openfolia/ui/core';
import { ToastService } from '@openfolia/ui/toast';

import { MeService, NOBODY } from '../permissions/me';
import { DiffCommentsComponent } from './diff-comments.component';
import { ReviewComments, type Comment } from './review-comments';

const ME = { kind: 'user' as const, id: 'sample-reviewer' };
const LIST = '/api/change-sets/cs1/comments';

function comment(
  id: string,
  thread: string,
  body: string | null,
  over: {
    author?: string;
    deleted?: boolean;
    editedAt?: string | null;
  } = {},
): Comment {
  return {
    type: 'Comment',
    id,
    attributes: {
      subject: { type: 'module', lang: 'en', moduleId: 'charging' },
      blockId: 'p1',
      body,
      author: { kind: 'user', id: over.author ?? ME.id },
      commit: 'c'.repeat(40),
      createdAt: '2026-11-18T10:00:00.000Z',
      resolvedAt: null,
      resolvedBy: null,
    },
    relationships: {
      changeSet: { data: { type: 'ChangeSet', id: 'cs1' } },
      thread: { data: { type: 'Comment', id: thread } },
    },
    meta: {
      orphaned: false,
      deleted: over.deleted ?? false,
      editedAt: over.editedAt ?? null,
    },
  };
}

const page = (data: Comment[]) => ({
  data,
  meta: { page: { number: 1, size: 200, total: data.length, lastPage: 1 } },
  links: {},
});

async function render(data: Comment[]) {
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
  comments.canWrite.set(true);
  comments.me.set(ME);
  const acting = TestBed.inject(MeService);
  acting.set({ ...NOBODY, kind: 'user', id: ME.id });
  const http = TestBed.inject(HttpTestingController);
  const toasts = TestBed.inject(ToastService);
  const fixture = TestBed.createComponent(DiffCommentsComponent);
  fixture.componentRef.setInput('module', 'en/charging');
  fixture.componentRef.setInput('blockId', 'p1');
  const loaded = comments.load('en/charging');
  http.expectOne((r) => r.url === LIST).flush(page(data));
  await loaded;
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 0));
      await fixture.whenStable();
    }
  };
  await settle();
  const el = fixture.nativeElement as HTMLElement;
  const button = (label: string, within: ParentNode = el) =>
    [...within.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === label,
    );
  /** The texts shown, a collapsed (gone) part left out. */
  const shown = () =>
    [...el.querySelectorAll('p')]
      // Not a reply's name line, nor anything folded away.
      .filter((p) => !p.matches('[data-slot=byline]'))
      .filter((p) => !p.closest('[data-state=closed]'))
      .map((p) => p.textContent?.replace(/\s+/g, ' ').trim());
  return { comments, acting, http, toasts, fixture, el, button, settle, shown };
}

describe('DiffCommentsComponent: one’s own comments', () => {
  it('offers Edit and Delete on one’s own comments only, and says “edited”', async () => {
    const t = await render([
      comment('t1', 't1', 'Mine', { editedAt: '2026-11-18T11:00:00.000Z' }),
      comment('r1', 't1', 'Theirs', { author: 'sample-author' }),
    ]);
    const own = t.el.querySelectorAll('[data-slot=own-actions]');
    expect(own.length).toBe(1);
    expect(own[0]?.textContent).toContain('Edit');
    expect(own[0]?.textContent).toContain('Delete');
    expect(t.el.querySelector('header')?.textContent).toContain('edited');
  });

  it('offers neither to who may not write', async () => {
    const t = await render([comment('t1', 't1', 'Mine')]);
    t.comments.canWrite.set(false);
    await t.settle();
    expect(t.el.querySelector('[data-slot=own-actions]')).toBeNull();
  });

  it('edits in place and sends the new text', async () => {
    const t = await render([comment('t1', 't1', 'Teh plug')]);
    t.button('Edit')?.click();
    await t.settle();
    const box = t.el.querySelector<HTMLTextAreaElement>('textarea');
    expect(box?.value).toBe('Teh plug');
    box!.value = ' The plug ';
    box!.dispatchEvent(new Event('input'));
    await t.settle();
    t.button('Save')?.click();
    await t.settle();
    // Shown at once, before the API answers.
    expect(t.el.querySelector('textarea')).toBeNull();
    expect(t.shown()).toEqual(['The plug']);
    const patch = t.http.expectOne(`${LIST}/t1`);
    expect(patch.request.method).toBe('PATCH');
    expect(patch.request.body).toEqual({
      data: { type: 'Comment', id: 't1', attributes: { body: 'The plug' } },
    });
    patch.flush({ data: comment('t1', 't1', 'The plug') });
    await t.settle();
    t.http
      .expectOne((r) => r.url === LIST)
      .flush(
        page([
          comment('t1', 't1', 'The plug', {
            editedAt: '2026-11-18T11:00:00.000Z',
          }),
        ]),
      );
    await t.settle();
    expect(t.el.querySelector('textarea')).toBeNull();
    expect(t.shown()).toEqual(['The plug']);
  });

  it('deletes with Undo: shown as deleted at once, sent only when the toast ends', async () => {
    const t = await render([
      comment('t1', 't1', 'Why?'),
      comment('r1', 't1', 'Because.', { author: 'sample-author' }),
    ]);
    t.button('Delete')?.click();
    await t.settle();
    expect(t.shown()).toEqual(['Comment deleted', 'Because.']);
    t.http.expectNone(`${LIST}/t1`);
    // Undo: it comes back, nothing is sent.
    const [undo] = t.toasts.toasts();
    t.toasts.runAction(undo!.id);
    await t.settle();
    expect(t.shown()).toEqual(['Why?', 'Because.']);
    t.http.expectNone(`${LIST}/t1`);

    t.button('Delete')?.click();
    await t.settle();
    const [toast] = t.toasts.toasts();
    t.toasts.dismiss(toast!.id);
    const sent = t.http.expectOne(`${LIST}/t1`);
    expect(sent.request.method).toBe('DELETE');
    sent.flush(null, { status: 204, statusText: 'No Content' });
    await t.settle();
    t.http
      .expectOne((r) => r.url === LIST)
      .flush(
        page([
          comment('t1', 't1', null, { deleted: true }),
          comment('r1', 't1', 'Because.', { author: 'sample-author' }),
        ]),
      );
    await t.settle();
    expect(t.shown()).toEqual(['Comment deleted', 'Because.']);
    expect(t.el.querySelector('[data-slot=own-actions]')).toBeNull();
  });

  it('folds a thread without replies away, and brings it back when the API refuses', async () => {
    const t = await render([comment('t1', 't1', 'Alone')]);
    t.button('Delete')?.click();
    await t.settle();
    expect(t.shown()).toEqual([]);
    const [toast] = t.toasts.toasts();
    t.toasts.dismiss(toast!.id);
    t.http.expectOne(`${LIST}/t1`).flush(
      {
        errors: [{ status: '409', code: 'invalid-state', title: 'Conflict' }],
      },
      { status: 409, statusText: 'Conflict' },
    );
    await t.settle();
    t.http
      .expectOne((r) => r.url === LIST)
      .flush(page([comment('t1', 't1', 'Alone')]));
    await t.settle();
    expect(t.shown()).toEqual(['Alone']);
    expect(t.toasts.toasts().some((x) => x.kind === 'error')).toBe(true);
  });

  it('sends nothing once someone else is acting', async () => {
    const t = await render([comment('t1', 't1', 'Mine')]);
    t.button('Delete')?.click();
    await t.settle();
    t.acting.set({ ...NOBODY, kind: 'user', id: 'sample-author' });
    const [toast] = t.toasts.toasts();
    t.toasts.dismiss(toast!.id);
    await t.settle();
    t.http.expectNone(`${LIST}/t1`);
    // What was read for the person before is forgotten too: theirs is read again (#716).
    expect(t.comments.loaded('en/charging')).toBe(false);
  });

  it('still sends a delete asked on a change set no longer shown', async () => {
    const t = await render([comment('t1', 't1', 'Mine')]);
    t.button('Delete')?.click();
    await t.settle();
    t.comments.reset('cs2');
    const [toast] = t.toasts.toasts();
    t.toasts.dismiss(toast!.id);
    const sent = t.http.expectOne(`${LIST}/t1`);
    expect(sent.request.method).toBe('DELETE');
    sent.flush(null, { status: 204, statusText: 'No Content' });
    await t.settle();
    // Not read again: another change set is shown.
    t.http.expectNone((r) => r.url.includes('/comments') && r.method === 'GET');
  });
});

describe('DiffCommentsComponent: eager writes', () => {
  const type = async (
    t: Awaited<ReturnType<typeof render>>,
    text: string,
  ): Promise<HTMLTextAreaElement> => {
    const box = t.el.querySelector<HTMLTextAreaElement>('textarea')!;
    box.value = text;
    box.dispatchEvent(new Event('input'));
    await t.settle();
    return box;
  };

  it('shows a new thread at once, as being sent, then as the API holds it', async () => {
    const t = await render([]);
    t.fixture.componentRef.setInput('anchor', 'on: Paragraph');
    t.comments.composing.set({ module: 'en/charging', blockId: 'p1' });
    await t.settle();
    expect(t.el.querySelector('[data-slot=composer]')).not.toBeNull();
    const box = await type(t, 'Say how far.');
    // Ctrl+Enter sends.
    box.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true }),
    );
    await t.settle();
    expect(t.el.querySelector('[data-slot=composer]')).toBeNull();
    expect(t.shown()).toEqual(['Say how far.']);
    expect(t.el.querySelector('[data-slot=sending]')).not.toBeNull();
    expect(t.el.querySelector('[data-slot=anchor]')?.textContent).toBe(
      'on: Paragraph',
    );
    const post = t.http.expectOne((r) => r.url === LIST && r.method === 'POST');
    expect(post.request.body.data.attributes).toEqual({
      body: 'Say how far.',
      blockId: 'p1',
      subject: { type: 'module', lang: 'en', moduleId: 'charging' },
    });
    post.flush(
      { data: comment('t9', 't9', 'Say how far.') },
      { status: 201, statusText: 'Created' },
    );
    await t.settle();
    t.http
      .expectOne((r) => r.url === LIST && r.method === 'GET')
      .flush(page([comment('t9', 't9', 'Say how far.')]));
    await t.settle();
    expect(t.shown()).toEqual(['Say how far.']);
    expect(t.el.querySelector('[data-slot=sending]')).toBeNull();
    expect(t.el.querySelectorAll('[data-slot=thread]').length).toBe(1);
  });

  it('keeps a refused thread as “Not sent”, sent again once by Retry or Try again', async () => {
    const t = await render([]);
    t.comments.composing.set({ module: 'en/charging', blockId: 'p1' });
    await t.settle();
    await type(t, 'Say how far.');
    t.button('Comment')?.click();
    await t.settle();
    t.http
      .expectOne((r) => r.url === LIST && r.method === 'POST')
      .flush(null, { status: 503, statusText: 'Unavailable' });
    await t.settle();
    t.http
      .expectOne((r) => r.url === LIST && r.method === 'GET')
      .flush(page([]));
    await t.settle();
    // Still there, with its text, and no box taken over.
    expect(t.shown()).toEqual(['Say how far.']);
    expect(t.el.querySelector('[data-slot=not-sent]')).not.toBeNull();
    expect(t.el.querySelector('textarea')).toBeNull();
    const error = t.toasts.toasts().find((x) => x.kind === 'error');
    expect(error?.actionLabel).toBeTruthy();
    t.toasts.runAction(error!.id);
    await t.settle();
    expect(t.el.querySelector('[data-slot=sending]')).not.toBeNull();
    // Try again on the comment now does nothing: it is being sent already.
    t.button('Try again')?.click();
    await t.settle();
    expect(
      t.http.match((r) => r.url === LIST && r.method === 'POST').length,
    ).toBe(1);
  });

  it('drops a refused thread on Discard', async () => {
    const t = await render([]);
    t.comments.composing.set({ module: 'en/charging', blockId: 'p1' });
    await t.settle();
    await type(t, 'Say how far.');
    t.button('Comment')?.click();
    await t.settle();
    t.http
      .expectOne((r) => r.url === LIST && r.method === 'POST')
      .flush(
        {
          errors: [{ status: '403', code: 'forbidden', title: 'Forbidden' }],
        },
        { status: 403, statusText: 'Forbidden' },
      );
    await t.settle();
    t.http.expectOne((r) => r.url === LIST && r.method === 'GET');
    expect(
      t.toasts.toasts().find((x) => x.kind === 'error')?.actionLabel,
    ).toBeFalsy();
    t.button('Discard')?.click();
    await t.settle();
    expect(t.el.querySelectorAll('[data-slot=thread]').length).toBe(0);
  });

  it('keeps what was typed when the same block’s new comment is asked for again', async () => {
    const t = await render([]);
    t.comments.composing.set({ module: 'en/charging', blockId: 'p1' });
    await t.settle();
    await type(t, 'Half a thought');
    t.comments.composing.set({ module: 'en/charging', blockId: 'p1' });
    await t.settle();
    expect(t.el.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(
      'Half a thought',
    );
  });

  it('keeps a thread shown while the API has taken it but the read after fails', async () => {
    const t = await render([]);
    t.comments.composing.set({ module: 'en/charging', blockId: 'p1' });
    await t.settle();
    await type(t, 'Kept.');
    t.button('Comment')?.click();
    await t.settle();
    t.http
      .expectOne((r) => r.url === LIST && r.method === 'POST')
      .flush(
        { data: comment('t9', 't9', 'Kept.') },
        { status: 201, statusText: 'Created' },
      );
    await t.settle();
    t.http
      .expectOne((r) => r.url === LIST && r.method === 'GET')
      .flush(null, { status: 500, statusText: 'Error' });
    await t.settle();
    expect(t.shown()).toEqual(['Kept.']);
  });

  it('sends nothing on Retry once someone else is acting', async () => {
    const t = await render([comment('t1', 't1', 'Why?')]);
    t.button('Resolve')?.click();
    await t.settle();
    t.http
      .expectOne(`${LIST}/t1/resolve`)
      .flush(null, { status: 503, statusText: 'Unavailable' });
    await t.settle();
    t.http.expectOne((r) => r.url === LIST && r.method === 'GET');
    t.acting.set({ ...NOBODY, kind: 'user', id: 'sample-author' });
    const error = t.toasts.toasts().find((x) => x.kind === 'error');
    t.toasts.runAction(error!.id);
    await t.settle();
    t.http.expectNone(`${LIST}/t1/resolve`);
  });

  it('resolves at once and rolls back, without Retry, when the API refuses for good', async () => {
    const t = await render([comment('t1', 't1', 'Why?')]);
    t.button('Resolve')?.click();
    await t.settle();
    expect(t.el.querySelector('header')?.textContent).toContain('Resolved');
    t.http.expectOne(`${LIST}/t1/resolve`).flush(
      {
        errors: [{ status: '409', code: 'invalid-state', title: 'Conflict' }],
      },
      { status: 409, statusText: 'Conflict' },
    );
    await t.settle();
    expect(t.el.querySelector('header')?.textContent).not.toContain('Resolved');
    const error = t.toasts.toasts().find((x) => x.kind === 'error');
    expect(error).toBeTruthy();
    expect(error?.actionLabel).toBeFalsy();
    t.http
      .expectOne((r) => r.url === LIST && r.method === 'GET')
      .flush(page([comment('t1', 't1', 'Why?')]));
  });

  it('shows a reply at once and keeps a refused one as “Not sent”', async () => {
    const t = await render([comment('t1', 't1', 'Why?')]);
    t.button('Reply')?.click();
    await t.settle();
    await type(t, 'Because.');
    t.button('Reply')?.click();
    await t.settle();
    expect(t.shown()).toEqual(['Why?', 'Because.']);
    t.http
      .expectOne((r) => r.url === LIST && r.method === 'POST')
      .flush(null, { status: 0, statusText: 'Network' });
    await t.settle();
    expect(t.shown()).toEqual(['Why?', 'Because.']);
    expect(t.el.querySelector('[data-slot=not-sent]')).not.toBeNull();
    expect(t.el.querySelector('textarea')).toBeNull();
  });
});
