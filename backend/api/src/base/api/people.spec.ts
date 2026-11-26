import { peopleIn } from './people.js';

describe('peopleIn', () => {
  it('finds the users a document names in its data and meta, not its services', () => {
    expect(
      peopleIn({
        data: [
          { attributes: { author: { kind: 'user', id: 'ada' }, by: null } },
          { attributes: { author: { kind: 'service', id: 'ci' } } },
        ],
        meta: {
          review: { approvals: [{ approver: { kind: 'user', id: 'bo' } }] },
        },
        links: { self: { kind: 'user', id: 'nobody' } },
      }),
    ).toEqual(['ada', 'bo']);
  });
});
