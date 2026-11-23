import {
  attributesOf,
  directRoleIds,
  draftOf,
  EMPTY_ROLE,
  type RoleItem,
  roleIdOf,
  type UserItem,
  roleKind,
  roleProblems,
  sameRole,
  scopeOf,
  userIdOf,
  userProblems,
} from './admin-model';

const role: RoleItem = {
  type: 'Role',
  id: 'author',
  attributes: {
    name: 'Author',
    description: null,
    permissions: ['content.read', 'content.edit'],
    scope: { languages: ['en'], facets: { line: ['a', 'b'] } },
  },
  meta: { holders: 2 },
} as RoleItem;

describe('admin model', () => {
  it('edits only the roles given directly, not those the groups give (#37)', () => {
    const user = {
      type: 'User',
      id: 'pat',
      attributes: { name: 'Pat', email: null, deactivatedAt: null },
      relationships: {
        roles: {
          data: [
            { type: 'Role', id: 'admin' },
            { type: 'Role', id: 'author' },
          ],
        },
      },
      meta: { permissions: [], groupRoleIds: ['author'] },
    } as unknown as UserItem;
    expect(directRoleIds(user)).toEqual(['admin']);
  });

  it('calls a role reading when it only reads content', () => {
    expect(roleKind(['content.read', 'content.read.draft'])).toBe('reading');
    expect(roleKind(['content.read', 'content.edit'])).toBe('editing');
  });

  it('makes IDs from names and email addresses', () => {
    expect(roleIdOf('Safety approver')).toBe('safety-approver');
    expect(roleIdOf('2nd line')).toBe('nd-line');
    expect(roleIdOf('')).toBe('');
    expect(userIdOf('Jane Doe', 'Jane.Doe@example.org')).toBe('jane.doe');
    expect(userIdOf('Jane Doe', '')).toBe('jane-doe');
    expect(userIdOf('Jane Doe', '..@example.org')).toBe('jane-doe');
  });

  it('turns a stored role into a draft and back, leaving empty dimensions out', () => {
    const draft = draftOf(role);
    expect(draft.facets).toEqual({ line: ['a', 'b'] });
    expect(attributesOf({ ...draft, name: '  Lead   author ' })).toEqual({
      name: 'Lead author',
      description: null,
      permissions: ['content.read', 'content.edit'],
      scope: { languages: ['en'], facets: { line: ['a', 'b'] } },
    });
    expect(scopeOf({ ...draft, languages: [], facets: { line: [] } })).toEqual(
      {},
    );
  });

  it('sees a draft as unchanged whatever the order of its permissions', () => {
    const draft = draftOf(role);
    expect(
      sameRole(draft, {
        ...draft,
        permissions: ['content.edit', 'content.read'],
      }),
    ).toBe(true);
    expect(sameRole(draft, { ...draft, maxAudience: 'operator' })).toBe(false);
  });

  it('names what is missing in a role', () => {
    expect(roleProblems(EMPTY_ROLE, true)).toEqual({
      id: 'editor.admin.roles.problems.id',
      name: 'editor.admin.roles.problems.name',
      permissions: 'editor.admin.roles.problems.permissions',
    });
    // A stored role keeps its ID.
    expect(roleProblems(draftOf(role), false)).toEqual({});
    expect(
      roleProblems({ ...draftOf(role), description: 'x'.repeat(501) }, false),
    ).toEqual({ description: 'editor.admin.roles.problems.description' });
  });

  it('asks a new user for an email address, an existing one only for a valid one', () => {
    const user = { id: 'jane', name: 'Jane', email: '', roleIds: [] };
    expect(userProblems(user, true)).toEqual({
      email: 'editor.admin.users.problems.email',
    });
    expect(userProblems(user, false)).toEqual({});
    expect(userProblems({ ...user, email: 'jane@' }, false)).toEqual({
      email: 'editor.admin.users.problems.email',
    });
    expect(
      userProblems({ ...user, id: 'Jane!', email: 'jane@example.org' }, true),
    ).toEqual({ id: 'editor.admin.users.problems.id' });
  });
});
