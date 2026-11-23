import type { RoleItem } from './admin-model';
import {
  assignableToService,
  expiryOf,
  serviceAccountIdOf,
  serviceAccountProblems,
  type ServiceTokenItem,
  tokenState,
} from './service-accounts-model';

const role = (permissions: string[]) =>
  ({
    type: 'Role',
    id: 'r',
    attributes: { name: 'R', description: null, permissions, scope: {} },
    meta: { holders: 0 },
  }) as RoleItem;

const token = (
  expiresAt: string,
  revokedAt: string | null = null,
): ServiceTokenItem => ({
  type: 'ServiceToken',
  id: '0123456789abcdef',
  attributes: {
    name: 'portal build',
    createdAt: '2026-11-01T10:00:00.000Z',
    expiresAt,
    lastUsedAt: null,
    revokedAt,
  },
  relationships: {
    serviceAccount: { data: { type: 'ServiceAccount', id: 'portal' } },
  },
});

describe('service accounts model', () => {
  it('never offers a role with admin.roles to a service account', () => {
    expect(assignableToService(role(['content.read']))).toBe(true);
    expect(assignableToService(role(['content.read', 'admin.roles']))).toBe(
      false,
    );
  });

  it('makes an ID from the name and checks a draft', () => {
    expect(serviceAccountIdOf('Portal build')).toBe('portal-build');
    const draft = {
      id: 'portal-build',
      name: 'Portal',
      description: '',
      roleIds: [],
    };
    expect(serviceAccountProblems(draft, true)).toEqual({});
    expect(
      serviceAccountProblems(
        {
          ...draft,
          id: 'Portal Build',
          name: ' ',
          description: 'x'.repeat(501),
        },
        true,
      ),
    ).toEqual({
      id: 'editor.admin.serviceAccounts.problems.id',
      name: 'editor.admin.serviceAccounts.problems.name',
      description: 'editor.admin.serviceAccounts.problems.description',
    });
    // An existing account's ID is not changed, so not checked.
    expect(serviceAccountProblems({ ...draft, id: '' }, false)).toEqual({});
  });

  it('tells an active token from an expired and a revoked one', () => {
    const now = new Date('2026-11-18T12:00:00.000Z');
    expect(tokenState(token('2026-12-01T00:00:00.000Z'), now)).toBe('active');
    expect(tokenState(token('2026-11-18T12:00:00.000Z'), now)).toBe('expired');
    expect(
      tokenState(
        token('2026-12-01T00:00:00.000Z', '2026-11-10T00:00:00.000Z'),
        now,
      ),
    ).toBe('revoked');
  });

  it('dates the expiry the chosen number of days ahead', () => {
    expect(expiryOf(90, new Date('2026-11-18T12:00:00.000Z'))).toBe(
      '2027-02-16T12:00:00.000Z',
    );
  });
});
