import {
  GROUP_MAX,
  isRoleFilter,
  mappingProblems,
  trimmedGroup,
} from './group-mappings-model';

describe('group mappings model (#592)', () => {
  it('takes a group name as the API does: 1 to 256 characters, without spaces at either end', () => {
    expect(mappingProblems({ group: 'writers', roleId: 'author' })).toEqual({});
    expect(
      mappingProblems({ group: 'cn=Writers,ou=groups', roleId: 'author' }),
    ).toEqual({});
    expect(mappingProblems({ group: '   ', roleId: 'author' })).toEqual({
      group: 'editor.admin.groupMappings.problems.group',
    });
    expect(mappingProblems({ group: 'a\u0000b', roleId: 'author' })).toEqual({
      group: 'editor.admin.groupMappings.problems.group',
    });
    expect(
      mappingProblems({ group: 'x'.repeat(GROUP_MAX), roleId: 'author' }),
    ).toEqual({});
    expect(
      mappingProblems({ group: 'x'.repeat(GROUP_MAX + 1), roleId: 'author' }),
    ).toEqual({ group: 'editor.admin.groupMappings.problems.groupLength' });
    // Checked as sent: spaces at the ends are dropped first.
    expect(
      mappingProblems({ group: ` ${'x'.repeat(GROUP_MAX)} `, roleId: 'a' }),
    ).toEqual({});
    expect(trimmedGroup('  Writers \n')).toBe('Writers');
  });

  it('needs a role', () => {
    expect(mappingProblems({ group: 'writers', roleId: '' })).toEqual({
      role: 'editor.admin.groupMappings.problems.role',
    });
  });

  it('filters by a role ID only', () => {
    expect(isRoleFilter('author')).toBe(true);
    expect(isRoleFilter('safety-approver')).toBe(true);
    expect(isRoleFilter('Author')).toBe(false);
    expect(isRoleFilter('a b')).toBe(false);
    expect(isRoleFilter('a'.repeat(65))).toBe(false);
  });
});
