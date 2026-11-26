import {
  ScimInvalidPathError,
  ScimInvalidSyntaxError,
  ScimInvalidValueError,
  ScimMutabilityError,
  ScimNoTargetError,
} from './scim-errors.js';
import { ENTERPRISE_USER_SCHEMA, type JsonObject } from './scim-json.js';
import {
  applyPatch,
  patchOperationsOf,
  type PatchOperation,
} from './scim-patch.js';

const user: JsonObject = {
  id: 'jane',
  userName: 'jane',
  active: true,
  name: { givenName: 'Jane', familyName: 'Doe' },
  emails: [{ value: 'jane@example.org', type: 'work', primary: true }],
};

const patch = (resource: JsonObject, ...operations: PatchOperation[]) =>
  applyPatch(resource, operations);

describe('SCIM PATCH', () => {
  it('reads a PatchOp, operation names ignoring case', () => {
    expect(
      patchOperationsOf({
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [{ op: 'Replace', path: 'active', value: 'False' }],
      }),
    ).toEqual([{ op: 'replace', path: 'active', value: 'False' }]);
    expect(() => patchOperationsOf({ Operations: [] })).toThrow(
      ScimInvalidSyntaxError,
    );
    expect(() => patchOperationsOf({ Operations: [{ op: 'move' }] })).toThrow(
      ScimInvalidSyntaxError,
    );
    expect(() => patchOperationsOf([])).toThrow(ScimInvalidSyntaxError);
    expect(() =>
      applyPatch(
        { id: 'u' },
        patchOperationsOf({
          Operations: [{ op: 'add', value: { __proto__: 1 } }],
        }),
      ),
    ).not.toThrow();
    expect(() =>
      applyPatch(
        { id: 'u' },
        patchOperationsOf(
          JSON.parse(
            '{"Operations":[{"op":"add","value":{"__proto__":{"x":1}}}]}',
          ),
        ),
      ),
    ).toThrow(ScimInvalidValueError);
  });

  it('replaces and adds without a path, never touching the original', () => {
    const result = patch(
      user,
      { op: 'replace', value: { active: false, displayName: 'J. Doe' } },
      {
        op: 'add',
        value: { emails: [{ value: 'jd@home.example', type: 'home' }] },
      },
    );
    expect(result).toMatchObject({ active: false, displayName: 'J. Doe' });
    expect(result['emails']).toHaveLength(2);
    expect(user['active']).toBe(true);
  });

  it('replaces sub-attributes and extension attributes by path', () => {
    const result = patch(
      user,
      { op: 'replace', path: 'name.familyName', value: 'Roe' },
      {
        op: 'add',
        path: `${ENTERPRISE_USER_SCHEMA}:department`,
        value: 'Docs',
      },
      { op: 'replace', path: 'NAME.givenName', value: 'Janet' },
    );
    expect(result['name']).toEqual({ givenName: 'Janet', familyName: 'Roe' });
    expect(result[ENTERPRISE_USER_SCHEMA]).toEqual({ department: 'Docs' });
  });

  it('changes the values a value filter selects, and adds one it does not find', () => {
    const changed = patch(user, {
      op: 'replace',
      path: 'emails[type eq "work"].value',
      value: 'jane@new.example',
    });
    expect(changed['emails']).toEqual([
      { value: 'jane@new.example', type: 'work', primary: true },
    ]);
    const added = patch(user, {
      op: 'add',
      path: 'emails[type eq "home"].value',
      value: 'jd@home.example',
    });
    expect(added['emails']).toEqual([
      ...(user['emails'] as unknown[]),
      { type: 'home', value: 'jd@home.example' },
    ]);
    expect(() =>
      patch(user, {
        op: 'replace',
        path: 'emails[type eq "home"]',
        value: { value: 'x' },
      }),
    ).toThrow(ScimNoTargetError);
  });

  it('removes attributes, filtered values and listed members', () => {
    const group: JsonObject = {
      id: 'g',
      displayName: 'Writers',
      members: [{ value: 'a' }, { value: 'b' }, { value: 'c' }],
    };
    expect(
      patch(group, { op: 'remove', path: 'members[value eq "b"]' })['members'],
    ).toEqual([{ value: 'a' }, { value: 'c' }]);
    expect(
      patch(group, {
        op: 'remove',
        path: 'members',
        value: [{ value: 'a' }, { value: 'c' }],
      })['members'],
    ).toEqual([{ value: 'b' }]);
    expect(patch(group, { op: 'remove', path: 'members' })).not.toHaveProperty(
      'members',
    );
    expect(
      patch(group, {
        op: 'add',
        path: 'members',
        value: [{ value: 'a' }, { value: 'd' }],
      })['members'],
    ).toEqual([{ value: 'a' }, { value: 'b' }, { value: 'c' }, { value: 'd' }]);
    expect(
      patch(user, { op: 'remove', path: 'name.givenName' })['name'],
    ).toEqual({
      familyName: 'Doe',
    });
  });

  it('refuses read-only attributes, a remove without a path and a path that does not parse', () => {
    expect(() =>
      patch(user, { op: 'replace', path: 'id', value: 'x' }),
    ).toThrow(ScimMutabilityError);
    expect(() => patch(user, { op: 'replace', value: { meta: {} } })).toThrow(
      ScimMutabilityError,
    );
    expect(() => patch(user, { op: 'add', path: 'groups', value: [] })).toThrow(
      ScimMutabilityError,
    );
    expect(() => patch(user, { op: 'remove' })).toThrow(ScimNoTargetError);
    expect(() =>
      patch(user, { op: 'add', path: 'emails[type eq', value: 1 }),
    ).toThrow(ScimInvalidPathError);
    expect(() =>
      patch(user, { op: 'add', path: 'constructor', value: 1 }),
    ).toThrow(ScimInvalidValueError);
    expect(() => patch(user, { op: 'add', value: 'not an object' })).toThrow(
      ScimInvalidValueError,
    );
  });
});

describe('SCIM PATCH run again', () => {
  it('leaves its operations as they were: a contended change runs them twice', () => {
    const operations: PatchOperation[] = [
      { op: 'add', path: 'emails', value: [{ type: 'work', value: 'a@b.c' }] },
      { op: 'replace', path: 'emails[type eq "work"].type', value: 'home' },
    ];
    const first = applyPatch({ id: 'u' }, operations);
    expect(applyPatch({ id: 'u' }, operations)).toEqual(first);
    expect(first['emails']).toEqual([{ type: 'home', value: 'a@b.c' }]);
  });
});

describe('SCIM PATCH filters', () => {
  it('refuses a filter longer than one may be', () => {
    expect(() =>
      patch(
        { id: 'g', members: [] },
        {
          op: 'remove',
          path: `members[${'value eq "x" or '.repeat(200)}value eq "y"]`,
        },
      ),
    ).toThrow(ScimInvalidPathError);
  });
});

describe('SCIM PATCH bodies', () => {
  it('refuses an object with more attributes than a SCIM resource has', () => {
    const value = Object.fromEntries(
      Array.from({ length: 5000 }, (_, i) => [`k${i}`, 1]),
    );
    expect(() =>
      applyPatch(
        { id: 'u' },
        patchOperationsOf({ Operations: [{ op: 'add', value }] }),
      ),
    ).toThrow(ScimInvalidValueError);
  });
});
