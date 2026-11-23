// The demo's people (#441): an author, a reviewer and an admin, invented for the films. Their
// names are what the films show (sign-in, comments, approvals, the history), so they are kept
// here, in one place, and nowhere else.

/** By role in the films: the user ID the API knows them by, their name and address. */
export const DEMO_PEOPLE = {
  author: {
    id: 'demo-author',
    name: 'Mira Sand',
    email: 'mira.sand@example.com',
  },
  reviewer: {
    id: 'demo-reviewer',
    name: 'Jonas Feld',
    email: 'jonas.feld@example.com',
  },
  admin: {
    id: 'demo-admin',
    name: 'Ada Linde',
    email: 'ada.linde@example.com',
  },
};

/**
 * The roles and users the demo's database is seeded with (the shape of the API's `db-seed`
 * file): writing, reviewing, and everything (`permissions`: the API's whole list, read from its
 * build, so a permission added later is the admin's too).
 */
export function demoSeed(permissions) {
  const { author, reviewer, admin } = DEMO_PEOPLE;
  return {
    roles: [
      {
        id: 'author',
        name: 'Author',
        permissions: ['content.read', 'content.read.draft', 'content.edit'],
        scope: {},
      },
      {
        id: 'reviewer',
        name: 'Reviewer',
        permissions: ['content.read', 'content.read.draft', 'content.review'],
        scope: {},
      },
      {
        id: 'admin',
        name: 'Admin',
        permissions: [...permissions],
        scope: {},
      },
    ],
    users: [
      { ...author, roles: ['author'] },
      { ...reviewer, roles: ['author', 'reviewer'] },
      { ...admin, roles: ['admin'] },
    ],
  };
}
