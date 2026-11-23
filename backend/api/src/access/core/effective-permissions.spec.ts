import type { Actor, Role, Scope } from './actor.js';
import { effectivePermissions } from './effective-permissions.js';
import type { Permission } from './permissions.js';

const role = (id: string, permissions: Permission[], scope: Scope): Role => ({
  id,
  name: id,
  permissions,
  scope,
});
const actor = (...roles: Role[]): Actor => ({ kind: 'user', id: 'a', roles });

describe('effectivePermissions', () => {
  it('lists each held permission with the scopes of the roles holding it', () => {
    expect(
      effectivePermissions(
        actor(
          role('a', ['content.edit', 'content.read'], { languages: ['de'] }),
          role('b', ['content.edit'], { moduleTypes: ['safety'] }),
          role('c', ['content.edit'], { languages: ['de'] }),
        ),
      ),
    ).toEqual([
      { permission: 'content.read', scopes: [{ languages: ['de'] }] },
      {
        permission: 'content.edit',
        scopes: [{ languages: ['de'] }, { moduleTypes: ['safety'] }],
      },
    ]);
  });

  it('collapses to everywhere when one role is unscoped', () => {
    expect(
      effectivePermissions(
        actor(
          role('a', ['content.read'], { languages: ['de'] }),
          role('b', ['content.read'], {}),
        ),
      ),
    ).toEqual([{ permission: 'content.read', scopes: [{}] }]);
  });

  it('gives global permissions no scope', () => {
    expect(
      effectivePermissions(
        actor(role('a', ['admin.roles'], { languages: ['de'] })),
      ),
    ).toEqual([{ permission: 'admin.roles', scopes: [{}] }]);
  });

  it('is empty without roles', () => {
    expect(effectivePermissions(actor())).toEqual([]);
  });
});
