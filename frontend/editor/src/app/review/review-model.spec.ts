import { describe, expect, it } from 'vitest';

import {
  expectedAfter,
  selfApprovalOpen,
  transitionStates,
  type ChangeSet,
  type ReviewMeta,
  type SelfApproval,
} from './review-model';

const changeSet = (base?: 'current' | 'rewritten'): ChangeSet =>
  ({
    type: 'ChangeSet',
    id: 'cs1',
    attributes: {
      title: 'Charging',
      description: null,
      state: 'approved',
      author: { kind: 'user', id: 'a' },
      baseRef: 'main',
      baseCommit: 'c',
      branch: 'change-sets/cs1',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
    meta: base ? { branchMissing: false, base: { state: base } } : {},
  }) as unknown as ChangeSet;

const publisher = {
  id: 'p',
  kind: 'user',
  permissions: new Set(['release.publish']),
};

describe('transitionStates: merge', () => {
  it('is offered for an approved change set on a current base', () => {
    expect(
      transitionStates(publisher, changeSet('current'), null, '', false).merge,
    ).toEqual({ kind: 'enabled' });
  });

  it('is blocked with the reason when its base was rewritten (#471)', () => {
    expect(
      transitionStates(publisher, changeSet('rewritten'), null, '', false)
        .merge,
    ).toEqual({
      kind: 'disabled',
      reason: 'editor.changeSet.rewritten.mergeBlocked',
    });
  });
});

describe('transitionStates: an author and self-approval (#588)', () => {
  const author = {
    id: 'a',
    kind: 'user',
    permissions: new Set(['content.edit', 'content.review', 'content.approve']),
  };
  const inReview = {
    ...changeSet(),
    attributes: { ...changeSet().attributes, state: 'in-review' },
  } as ChangeSet;
  const review = (selfApproval: SelfApproval): ReviewMeta => ({
    required: ['review', 'sign-off/safety'],
    granted: [],
    pending: ['review', 'sign-off/safety'],
    approvals: [],
    lapsed: [],
    selfApproved: false,
    selfApproval,
    yours: true,
  });
  const states = (rule: SelfApproval) =>
    transitionStates(author, inReview, review(rule), 'Why.', false);

  it('blocks approve and sign-off for the author with never, as four eyes did', () => {
    const s = states('never');
    expect(s.approve).toEqual({
      kind: 'disabled',
      reason: 'editor.review.blocked.own',
    });
    expect(s['sign-off']).toEqual({
      kind: 'disabled',
      reason: 'editor.review.blocked.own',
    });
    expect(selfApprovalOpen(author, inReview, review('never'))).toBe(false);
  });

  it('offers approve with review, but not the sign-off', () => {
    const s = states('review');
    expect(s.approve).toEqual({ kind: 'enabled' });
    expect(s['sign-off']).toEqual({
      kind: 'disabled',
      reason: 'editor.review.blocked.ownSignOff',
    });
    expect(selfApprovalOpen(author, inReview, review('review'))).toBe(true);
  });

  it('offers both with review-and-sign-off, and never return', () => {
    const s = states('review-and-sign-off');
    expect(s.approve).toEqual({ kind: 'enabled' });
    expect(s['sign-off']).toEqual({ kind: 'enabled' });
    expect(s.return).toEqual({
      kind: 'disabled',
      reason: 'editor.review.blocked.own',
    });
  });

  it('marks the author’s own approval as self when it is shown at once', () => {
    const after = expectedAfter('approve', author, inReview, review('review'));
    expect(after.review?.selfApproved).toBe(true);
    expect(after.review?.approvals).toMatchObject([
      { requirement: 'review', self: true },
    ]);
  });
});

describe('transitionStates: a writer who did not start it (#597)', () => {
  // Wrote a fix someone else carried forward: not the recorded author, but the API says it is theirs.
  const writer = {
    id: 'w',
    kind: 'user',
    permissions: new Set(['content.review', 'content.approve']),
  };
  const inReview = {
    ...changeSet(),
    attributes: { ...changeSet().attributes, state: 'in-review' },
  } as ChangeSet;
  const review = (selfApproval: SelfApproval, yours: boolean): ReviewMeta => ({
    required: ['review', 'sign-off/safety'],
    granted: [],
    pending: ['review', 'sign-off/safety'],
    approvals: [],
    lapsed: [],
    selfApproved: false,
    selfApproval,
    yours,
  });

  it('blocks approve, sign-off and return for them with never', () => {
    const s = transitionStates(
      writer,
      inReview,
      review('never', true),
      'Why.',
      false,
    );
    const own = { kind: 'disabled', reason: 'editor.review.blocked.own' };
    expect(s.approve).toEqual(own);
    expect(s['sign-off']).toEqual(own);
    expect(s.return).toEqual(own);
  });

  it('offers approve as their own with review, shown at once as self', () => {
    const meta = review('review', true);
    expect(
      transitionStates(writer, inReview, meta, 'Why.', false).approve,
    ).toEqual({ kind: 'enabled' });
    expect(selfApprovalOpen(writer, inReview, meta)).toBe(true);
    const after = expectedAfter('approve', writer, inReview, meta);
    expect(after.review?.approvals).toMatchObject([{ self: true }]);
  });

  it('treats a reviewer who wrote none of it as anyone else', () => {
    const s = transitionStates(
      writer,
      inReview,
      review('never', false),
      'Why.',
      false,
    );
    expect(s.approve).toEqual({ kind: 'enabled' });
    expect(s.return).toEqual({ kind: 'enabled' });
  });
});
