import { actorWith } from '../../../tests/fakes/actors.js';
import { readPermissionAt } from './released.js';

const MAIN = 'a'.repeat(40);
const TAGGED = 'b'.repeat(40);
const DRAFT = 'c'.repeat(40);
const refs = {
  branches: [
    { name: 'main', commit: MAIN },
    { name: 'draft', commit: DRAFT },
  ],
  tags: [{ name: 'v1', commit: TAGGED }],
};

describe('readPermissionAt', () => {
  it('reads released commits with content.read, others only with content.read.draft', () => {
    const editor = actorWith(['content.edit']);
    const drafter = actorWith(['content.read.draft']);
    for (const commit of [MAIN, TAGGED]) {
      expect(readPermissionAt(editor, commit, refs)).toBe('content.read');
      expect(readPermissionAt(drafter, commit, refs)).toBe('content.read');
    }
    // A draft, also an earlier commit of `main` (not in any ref).
    for (const commit of [DRAFT, 'd'.repeat(40)]) {
      expect(readPermissionAt(editor, commit, refs)).toBeUndefined();
      expect(readPermissionAt(drafter, commit, refs)).toBe(
        'content.read.draft',
      );
    }
  });
});
