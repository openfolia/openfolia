import type { ChangeSetOption } from './change-set-session';
import { ownDraftOf } from './own-draft';

const option = (
  id: string,
  over: Partial<ChangeSetOption> = {},
): ChangeSetOption => ({
  id,
  title: id,
  description: null,
  state: 'draft',
  branch: `change-sets/${id}`,
  baseRef: 'main',
  authorId: 'me',
  createdAt: '2026-11-01T10:00:00Z',
  pending: false,
  branchMissing: false,
  ...over,
});

describe('ownDraftOf (#589)', () => {
  it('keeps the chosen revision when it is the person’s own draft', () => {
    const options = [
      option('newer', { createdAt: '2026-11-05T10:00:00Z' }),
      option('chosen'),
    ];
    expect(ownDraftOf(options, 'chosen', 'me')?.id).toBe('chosen');
  });

  it('else takes their newest open draft, never another’s, one in review or one without a branch', () => {
    const options = [
      option('older', { createdAt: '2026-11-01T10:00:00Z' }),
      option('newest', { createdAt: '2026-11-04T10:00:00Z' }),
      option('theirs', {
        authorId: 'other',
        createdAt: '2026-11-09T10:00:00Z',
      }),
      option('review', {
        state: 'in-review',
        createdAt: '2026-11-09T10:00:00Z',
      }),
      option('gone', {
        branchMissing: true,
        createdAt: '2026-11-09T10:00:00Z',
      }),
      option('pending', { pending: true, branch: null }),
    ];
    expect(ownDraftOf(options, 'theirs', 'me')?.id).toBe('newest');
    expect(ownDraftOf(options, null, 'me')?.id).toBe('newest');
  });

  it('finds none when the person has no open draft: one is started', () => {
    expect(
      ownDraftOf([option('theirs', { authorId: 'other' })], null, 'me'),
    ).toBeNull();
  });
});
