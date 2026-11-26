import { scimSetUp } from '../../../../tests/fakes/scim-set-up.js';
import {
  ScimInvalidValueError,
  ScimMutabilityError,
  ScimRequestError,
} from '../scim-errors.js';
import { type PatchOperation, userOperationsOf } from '../scim-patch.js';
import { type ScimUser, userResource } from '../scim-resources.js';

const CORE = 'urn:ietf:params:scim:schemas:core:2.0:User';
const GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const ENTERPRISE = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';

const person = {
  schemas: [CORE],
  userName: 'jane.doe@example.org',
  externalId: 'E-1',
  name: { givenName: 'Jane', familyName: 'Doe' },
  emails: [{ value: 'jane.doe@example.org', type: 'work', primary: true }],
};
const userId = 'jane.doe';

async function provisioned() {
  const s = scimSetUp();
  const actor = s.directory;
  await s.createUser.handle({ actor, body: person });
  const patch = (...operations: PatchOperation[]) =>
    s.patchUser.handle({ actor, userId, operations });
  const put = (body: object) => s.replaceUser.handle({ actor, userId, body });
  return { ...s, actor, patch, put };
}

describe('one attribute, however it is spelled', () => {
  /** `{ [name]: value }`, the core attribute `name`, in each spelling. */
  const spellings = (name: string, value: unknown): [string, object][] => [
    ['its name', { [name]: value }],
    ['another case', { [name.toUpperCase()]: value }],
    ['the core schema as a container', { [CORE]: { [name]: value } }],
    [
      'the container in another case',
      { [CORE.toUpperCase()]: { [name.toUpperCase()]: value } },
    ],
    ['the core schema before it', { [`${CORE}:${name}`]: value }],
    [
      'the prefix in another case',
      { [`${CORE.toLowerCase()}:${name.toUpperCase()}`]: value },
    ],
  ];
  const paths = (name: string) => [
    name,
    name.toUpperCase(),
    `${CORE}:${name}`,
    `${CORE.toLowerCase()}:${name.toUpperCase()}`,
  ];

  it.each(spellings('active', false))(
    'deactivates by PUT, PATCH without a path and PATCH of the schema: %s',
    async (_name, body) => {
      const s = await provisioned();
      const put = await s.put({ ...person, ...body });
      expect(put.deactivatedAt).toBeInstanceOf(Date);
      expect(Object.keys(userResource(put)).join()).not.toMatch(/urn:/i);
      for (const op of ['add', 'replace'] as const) {
        const t = await provisioned();
        const patched = await t.patch({ op, value: body });
        expect(patched.deactivatedAt).toBeInstanceOf(Date);
        const u = await provisioned();
        const whole = await u.patch({ op, path: CORE, value: body });
        expect(whole.deactivatedAt).toBeInstanceOf(Date);
      }
    },
  );

  it.each(paths('active'))('deactivates by a PATCH of %s', async (path) => {
    for (const value of [false, 'False']) {
      const s = await provisioned();
      const user = await s.patch({ op: 'replace', path, value });
      expect(user.deactivatedAt).toBeInstanceOf(Date);
    }
  });

  it('never keeps a password, wherever it is', async () => {
    const other = 'urn:example:params:scim:schemas:extension:hr:2.0:User';
    const stored = (user: ScimUser) =>
      JSON.stringify([user, userResource(user)]);
    const places: object[] = [
      ...spellings('password', 's3cret').map(([, body]) => body),
      { [ENTERPRISE]: { Password: 's3cret', department: 'D' } },
      { [`${ENTERPRISE}:password`]: 's3cret' },
      { [other]: { password: 's3cret', badge: 1 } },
      { [`${other}:password`]: 's3cret' },
      { [`${other}:password`]: { value: 's3cret' } },
      { [other]: { login: { PASSWORD: 's3cret' } } },
      { name: { familyName: 'Doe', password: 's3cret' } },
      { phoneNumbers: [{ value: '1', password: 's3cret' }] },
    ];
    for (const place of places) {
      const s = await provisioned();
      expect(stored(await s.put({ ...person, ...place }))).not.toContain(
        's3cret',
      );
      const t = await provisioned();
      expect(
        stored(await t.patch({ op: 'replace', value: place })),
      ).not.toContain('s3cret');
      const u = scimSetUp();
      const made = await u.createUser.handle({
        actor: u.directory,
        body: { ...person, ...place },
      });
      expect(stored(made)).not.toContain('s3cret');
      expect(JSON.stringify(u.audit.events)).not.toContain('s3cret');
    }
    for (const path of [
      ...paths('password'),
      `${ENTERPRISE}:password`,
      `${other}:password`,
      'name.password',
      'emails[type eq "work"].password',
    ]) {
      const s = await provisioned();
      const user = await s.patch({ op: 'add', path, value: 's3cret' });
      expect(stored(user)).not.toContain('s3cret');
    }
  });

  it('refuses read-only attributes in each spelling', async () => {
    const s = await provisioned();
    for (const name of ['id', 'meta', 'groups']) {
      for (const [, body] of spellings(name, 'x')) {
        await expect(s.patch({ op: 'replace', value: body })).rejects.toThrow(
          ScimMutabilityError,
        );
        await expect(
          s.patch({ op: 'add', path: CORE, value: body }),
        ).rejects.toThrow(ScimRequestError);
        // A PUT ignores them, as by their names.
        const user = await s.put({ ...person, ...body });
        expect(user.userId).toBe(userId);
        expect(user.attributes).not.toHaveProperty(name);
      }
      for (const path of paths(name)) {
        await expect(
          s.patch({ op: 'replace', path, value: 'x' }),
        ).rejects.toThrow(ScimMutabilityError);
      }
    }
  });

  it('refuses two spellings that disagree, and takes two that agree', async () => {
    const s = await provisioned();
    const disagreeing: object[] = [
      { active: true, [CORE]: { active: false } },
      { active: true, [`${CORE}:active`]: false },
      { active: true, ACTIVE: false },
      { [CORE]: { active: true, Active: false } },
      { [CORE]: { active: true }, [CORE.toLowerCase()]: { active: false } },
      { active: null, [CORE]: { active: false } },
      { displayName: 'A', DisplayName: 'B' },
      {
        [ENTERPRISE]: { department: 'A' },
        [`${ENTERPRISE}:department`]: 'B',
      },
      { emails: [{ value: 'a@example.org', VALUE: 'b@example.org' }] },
      { ' displayName': 'A', displayName: 'B' },
    ];
    for (const body of disagreeing) {
      await expect(s.put({ ...person, ...body })).rejects.toThrow(
        ScimInvalidValueError,
      );
      await expect(s.patch({ op: 'replace', value: body })).rejects.toThrow(
        ScimInvalidValueError,
      );
    }
    await expect(s.put({ ...person, [CORE]: 'x' })).rejects.toThrow(
      ScimInvalidValueError,
    );
    const user = await s.put({
      ...person,
      displayName: 'J',
      DISPLAYNAME: 'J',
      [CORE]: { displayName: 'J' },
    });
    expect(user.attributes).toMatchObject({ displayName: 'J' });
    expect(Object.keys(user.attributes).join()).not.toMatch(/urn:/i);
  });

  it('refuses a path or a name of the core schemas that names no attribute', async () => {
    const s = await provisioned();
    for (const path of [
      `${CORE}.active`,
      `${CORE}:`,
      `${CORE}[type eq "x"].active`,
      'urn:ietf:params:scim:schemas:core:2.1:User:active',
    ]) {
      await expect(
        s.patch({ op: 'replace', path, value: false }),
      ).rejects.toMatchObject({ scimType: 'invalidPath' });
      await expect(s.put({ ...person, [path]: false })).rejects.toThrow(
        ScimInvalidValueError,
      );
    }
    await expect(s.patch({ op: 'remove', path: CORE })).rejects.toMatchObject({
      scimType: 'noTarget',
    });
    const misplaced: object[] = [
      { [CORE]: { [CORE]: { title: 'x' } } },
      { [CORE]: { [`${CORE}:title`]: 'x' } },
      { [CORE]: { [ENTERPRISE]: { department: 'x' } } },
      { [ENTERPRISE]: { [`${CORE}:title`]: 'x' } },
      { [ENTERPRISE]: { [`${ENTERPRISE}:department`]: 'x' } },
      { 'urn:scim:schemas:core:1.0': { title: 'x' } },
    ];
    for (const body of misplaced) {
      await expect(s.put({ ...person, ...body })).rejects.toThrow(
        ScimInvalidValueError,
      );
      await expect(s.patch({ op: 'replace', value: body })).rejects.toThrow(
        ScimInvalidValueError,
      );
    }
  });

  it('bounds what the containers are merged to, quickly', async () => {
    const s = await provisioned();
    const keys = (n: number, prefix: string) =>
      Object.fromEntries(
        Array.from({ length: n }, (_, i) => [`${prefix}${i}`, 1]),
      );
    const body = (schema: string) =>
      Object.fromEntries(
        Array.from({ length: 90 }, (_, i) => [
          ' '.repeat(i) + schema,
          keys(95, `k${i}x`),
        ]),
      );
    const start = process.threadCpuUsage();
    for (const schema of [CORE, ENTERPRISE]) {
      await expect(s.put({ ...person, ...body(schema) })).rejects.toThrow(
        ScimInvalidValueError,
      );
      await expect(s.patch({ op: 'add', value: body(schema) })).rejects.toThrow(
        ScimInvalidValueError,
      );
    }
    await expect(
      s.createGroup.handle({
        actor: s.actor,
        body: { displayName: 'G', ...body(GROUP) },
      }),
    ).rejects.toThrow(ScimInvalidValueError);
    const { user, system } = process.threadCpuUsage(start);
    expect((user + system) / 1000).toBeLessThan(2000);
    // As many as fit, then a PATCH with the server's own beside them.
    await s.put({ ...person, ...keys(90, 'extra') });
    const gone = await s.patch({ op: 'replace', path: 'active', value: false });
    expect(gone.deactivatedAt).toBeInstanceOf(Date);
  });

  it('reads group bodies and patches the same way', async () => {
    const s = scimSetUp();
    const actor = s.directory;
    for (const n of ['ann', 'bob']) {
      await s.createUser.handle({ actor, body: { userName: n } });
    }
    const group = await s.createGroup.handle({
      actor,
      body: {
        [GROUP]: { displayName: 'Writers', externalId: 'W' },
        [`${GROUP}:members`]: [{ value: 'ann' }],
      },
    });
    expect(group).toMatchObject({ displayName: 'Writers', externalId: 'W' });
    expect(group.members.map((m) => m.userId)).toEqual(['ann']);
    const patched = await s.patchGroup.handle({
      actor,
      groupId: group.id,
      operations: [
        { op: 'replace', value: { [GROUP]: { displayName: 'Authors' } } },
        { op: 'add', path: `${GROUP}:members`, value: [{ value: 'bob' }] },
        {
          op: 'remove',
          path: `${GROUP.toLowerCase()}:members[value eq "ann"]`,
        },
      ],
    });
    expect(patched.displayName).toBe('Authors');
    expect(patched.members.map((m) => m.userId)).toEqual(['bob']);
    await expect(
      s.replaceGroup.handle({
        actor,
        groupId: group.id,
        body: {
          displayName: 'A',
          members: [{ value: 'ann' }],
          [GROUP]: { members: [] },
        },
      }),
    ).rejects.toThrow(ScimInvalidValueError);
  });

  it('takes what directories send: short names and the enterprise extension, in each form', async () => {
    const s = await provisioned();
    await s.patch(
      {
        op: 'add',
        value: {
          title: 'Writer',
          'name.givenName': 'Joan',
          'emails[type eq "work"].display': 'Work',
          [`${ENTERPRISE}:department`]: 'Docs',
        },
      },
      { op: 'replace', path: `${ENTERPRISE}:employeeNumber`, value: '7' },
      { op: 'add', path: ENTERPRISE, value: { division: 'D' } },
      { op: 'add', value: { [ENTERPRISE]: { costCenter: 'C' } } },
    );
    const user = await s.scim.findUser(userId);
    expect(user?.attributes).toEqual({
      title: 'Writer',
      name: { givenName: 'Joan', familyName: 'Doe' },
      emails: [{ ...person.emails[0], display: 'Work' }],
      [ENTERPRISE]: {
        department: 'Docs',
        employeeNumber: '7',
        division: 'D',
        costCenter: 'C',
      },
    });
    expect(s.admin.user(userId)?.name).toBe('Joan Doe');
    await s.patch({ op: 'remove', path: ENTERPRISE });
    expect((await s.scim.findUser(userId))?.attributes).not.toHaveProperty([
      ENTERPRISE,
    ]);
  });

  it('keeps someone as active as they are when a PUT or a removal leaves active out', async () => {
    const s = await provisioned();
    await s.patch({ op: 'replace', path: 'active', value: false });
    expect((await s.put(person)).deactivatedAt).toBeInstanceOf(Date);
    const operations: PatchOperation[] = [
      { op: 'remove', path: 'active' },
      { op: 'replace', path: 'active', value: null },
    ];
    for (const operation of operations) {
      expect((await s.patch(operation)).deactivatedAt).toBeInstanceOf(Date);
    }
    expect((await s.put({ ...person, active: true })).deactivatedAt).toBeNull();
  });

  it('has one primary address: a new one takes over, two in a body are refused', async () => {
    const s = await provisioned();
    const other = { value: 'j@example.org', type: 'home', primary: true };
    const added = await s.patch({ op: 'add', path: 'emails', value: [other] });
    expect(s.admin.user(userId)?.email).toBe('j@example.org');
    expect(added.attributes['emails']).toEqual([
      { ...person.emails[0], primary: false },
      other,
    ]);
    await s.patch({
      op: 'replace',
      path: 'emails[type eq "work"].primary',
      value: 'True',
    });
    expect(s.admin.user(userId)?.email).toBe('jane.doe@example.org');
    await expect(
      s.put({ ...person, emails: [...person.emails, other] }),
    ).rejects.toThrow(ScimInvalidValueError);
    // As some directories send it.
    await s.put({
      ...person,
      emails: [
        { value: 'jane.doe@example.org', type: 'work', primary: 'False' },
        { ...other, primary: 'True' },
      ],
    });
    expect(s.admin.user(userId)?.email).toBe('j@example.org');
  });
});

describe('the address lock', () => {
  const elsewhere = [{ value: 'someone@else.example', type: 'work' }];
  async function signedIn() {
    const s = await provisioned();
    s.identities.withPassword.add(userId);
    return s;
  }

  it('holds whatever groups the directory takes the user out of, or puts them back in', async () => {
    const s = await signedIn();
    s.admin.putRole({
      id: 'approver',
      name: 'Approver',
      description: null,
      permissions: ['content.read', 'content.approve'],
      scope: {},
    });
    await s.unit.run((tx) => s.mappings.insert(tx, 'Approvers', 'approver'));
    const group = await s.createGroup.handle({
      actor: s.actor,
      body: { displayName: 'Approvers', members: [{ value: userId }] },
    });
    const held = () =>
      s.unit.run(async (tx) => [
        ...(await s.admin.heldPermissions(tx, userId)),
      ]);
    expect(await held()).toContain('content.approve');
    const members = (op: 'add' | 'remove') =>
      s.patchGroup.handle({
        actor: s.actor,
        groupId: group.id,
        operations: [{ op, path: 'members', value: [{ value: userId }] }],
      });
    await members('remove');
    expect(await held()).toEqual([]);
    for (const emails of [elsewhere, []]) {
      await expect(s.put({ ...person, emails })).rejects.toMatchObject({
        code: 'scim-address-locked',
      });
    }
    await members('add');
    expect(await held()).toContain('content.approve');
    expect(s.admin.user(userId)?.email).toBe('jane.doe@example.org');
  });

  it('holds through a deactivation, a DELETE and provisioning again', async () => {
    const s = await signedIn();
    await s.put({ ...person, emails: elsewhere, active: false });
    expect(s.admin.user(userId)?.email).toBe('jane.doe@example.org');
    await expect(
      s.put({ ...person, emails: elsewhere, active: true }),
    ).rejects.toMatchObject({ code: 'scim-address-locked' });
    await s.put({ ...person, active: true });
    expect(s.admin.user(userId)).toMatchObject({
      email: 'jane.doe@example.org',
      deactivatedAt: null,
    });
    await s.deleteUser.handle({ actor: s.actor, userId });
    await s.createUser.handle({ actor: s.actor, body: person });
    await expect(s.put({ ...person, emails: elsewhere })).rejects.toMatchObject(
      { code: 'scim-address-locked' },
    );
    expect(s.admin.user(userId)?.email).toBe('jane.doe@example.org');
  });

  it('never holds up deprovisioning, nor other changes once the address was changed in the editor', async () => {
    const s = await signedIn();
    await s.unit.run((tx) =>
      s.admin.updateUser(tx, userId, {
        name: 'Jane Doe',
        email: 'jane@example.org',
      }),
    );
    // The directory still has the old address: it changes the title, not the address.
    await s.put({ ...person, title: 'Writer' });
    expect(s.admin.user(userId)?.email).toBe('jane@example.org');
    expect((await s.scim.findUser(userId))?.attributes).toMatchObject({
      title: 'Writer',
    });
    // Then it has the new one too.
    await s.put({ ...person, emails: [{ value: 'jane@example.org' }] });
    const gone = await s.put({ ...person, emails: elsewhere, active: false });
    expect(gone.deactivatedAt).toBeInstanceOf(Date);
    expect(s.admin.user(userId)?.email).toBe('jane@example.org');
    // The address it was not given is not kept as the directory's: it is refused again.
    await expect(
      s.put({ ...person, emails: elsewhere, active: true }),
    ).rejects.toMatchObject({ code: 'scim-address-locked' });
  });

  it('reads the ways in, not the second step (#611): one left open locks by the first factor it came after', async () => {
    const open = async (s: Awaited<ReturnType<typeof provisioned>>) => {
      await s.unit.run((tx) =>
        s.pending.create(
          tx,
          {
            hash: 'c'.repeat(64),
            userId,
            step: 'set-up',
            provider: 'email-code',
            via: 'code',
            expiresAt: new Date(Date.now() + 60_000),
          },
          new Date(),
        ),
      );
    };
    // The first factor was right: a way in already, whether or not the second step is taken.
    const s = await provisioned();
    await open(s);
    await s.unit.run((tx) => s.identities.recordCodeSignIn(tx, userId));
    await expect(s.put({ ...person, emails: elsewhere })).rejects.toMatchObject(
      { code: 'scim-address-locked' },
    );
    expect(s.pending.open.size).toBe(1);
    await s.put({ ...person, emails: elsewhere, active: false });
    expect(s.admin.user(userId)?.email).toBe('jane.doe@example.org');
    expect(s.pending.open.size).toBe(0);
    // An open step alone is no way in, and ends with the address it was mailed to.
    const t = await provisioned();
    await open(t);
    await t.put({ ...person, emails: elsewhere });
    expect(t.admin.user(userId)?.email).toBe('someone@else.example');
    expect(t.pending.open.size).toBe(0);
  });

  it('lets the directory change the address of a user it made who never signed in', async () => {
    const s = await provisioned();
    await s.put({ ...person, emails: elsewhere });
    expect(s.admin.user(userId)?.email).toBe('someone@else.example');
  });
});

describe('a deactivation always goes through', () => {
  const twoPrimaries = [
    { value: 'a@example.org', primary: true },
    { value: 'b@example.org', primary: true },
  ];
  /** What an earlier version, or a later rule, may leave stored. */
  const stored: [string, object][] = [
    ['two primary addresses', { emails: twoPrimaries }],
    ['a core container', { [CORE]: { active: true, password: 's3cret' } }],
    [
      'a core name',
      { [`${CORE}:active`]: true, [`${CORE}:password`]: 's3cret' },
    ],
    ['no address', { emails: [{ value: 'no address' }] }],
    ['emails that are none', { emails: 'x' }],
    ['one attribute twice', { foo: 1, FOO: 2 }],
  ];
  /** What a request may send wrong beside `active: false`. */
  const sent: [string, object][] = [
    ['two primary addresses', { emails: twoPrimaries }],
    ['no address', { emails: [{ value: 'no address' }] }],
    ['emails that are none', { emails: 'x' }],
    ['two spellings that disagree', { title: 'A', TITLE: 'B' }],
    ['a container in a container', { [CORE]: { [CORE]: {} } }],
    [
      'too many attributes',
      Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`k${i}`, i])),
    ],
    ['too many bytes', { title: 'x'.repeat(20_000) }],
    ['a name that reaches a prototype', { constructor: {} }],
    ['what no text is', { title: 'a\u0000b' }],
    ['a userName that is none', { userName: 7 }],
    ["another's userName", { userName: 'bob' }],
    ["another's address", { emails: [{ value: 'bob@example.org' }] }],
  ];
  const readOnly: [string, object][] = [
    ['another id', { id: 'x' }],
    ['groups', { groups: [{ value: 'x' }] }],
  ];
  const offs: [string, object][] = [
    ['its name', { active: false }],
    ['a string', { active: 'False' }],
    ['a container', { [CORE]: { active: false } }],
    ['a prefix', { [`${CORE}:active`]: false }],
  ];
  async function ready(signedIn = false) {
    const s = await provisioned();
    await s.createUser.handle({
      actor: s.actor,
      body: { userName: 'bob', emails: [{ value: 'bob@example.org' }] },
    });
    if (signedIn) s.identities.withPassword.add(userId);
    return s;
  }
  const isGone = (s: Awaited<ReturnType<typeof ready>>) => {
    expect(s.admin.user(userId)?.deactivatedAt).toBeInstanceOf(Date);
    expect(s.admin.user(userId)?.email).toBe('jane.doe@example.org');
  };

  it.each(stored)('whatever is stored: %s', async (_name, attributes) => {
    for (const run of [
      (s: Awaited<ReturnType<typeof ready>>) =>
        s.put({ ...person, active: false }),
      (s: Awaited<ReturnType<typeof ready>>) =>
        s.patch({ op: 'replace', path: 'active', value: false }),
      (s: Awaited<ReturnType<typeof ready>>) =>
        s.patch({ op: 'replace', value: { active: false } }),
      (s: Awaited<ReturnType<typeof ready>>) =>
        s.deleteUser.handle({ actor: s.actor, userId }),
    ]) {
      const s = await ready();
      await s.unit.run((tx) =>
        s.scim.update(tx, {
          userId,
          userName: person.userName,
          externalId: null,
          attributes: { ...attributes },
        }),
      );
      const read = await s.scim.findUser(userId);
      expect(JSON.stringify(read && userResource(read))).not.toContain(
        's3cret',
      );
      await run(s);
      isGone(s);
    }
  });

  it.each(sent)('whatever a PUT sends wrong: %s', async (_name, wrong) => {
    for (const [, off] of offs) {
      for (const signedIn of [false, true]) {
        const s = await ready(signedIn);
        await s.put({ ...person, ...wrong, ...off });
        isGone(s);
        expect((await s.scim.findUser(userId))?.userName).toBe(person.userName);
      }
    }
  });

  it.each([...sent, ...readOnly])(
    'whatever a PATCH sends wrong: %s',
    async (_name, wrong) => {
      for (const [, off] of offs) {
        const s = await ready();
        await s.patch({ op: 'replace', value: { ...wrong, ...off } });
        isGone(s);
        const t = await ready();
        await t.patch(
          { op: 'replace', value: wrong },
          { op: 'replace', path: `${CORE}:active`, value: 'False' },
        );
        isGone(t);
        const u = await ready();
        await u.patch(
          { op: 'replace', path: 'active', value: false },
          { op: 'replace', path: 'no path[', value: 1 },
          { op: 'replace', path: CORE, value: wrong },
        );
        isGone(u);
      }
    },
  );

  it('whatever operations a PATCH has beside it, readable or not', () => {
    const off = { op: 'Replace', path: 'active', value: 'False' };
    const alone = [{ op: 'replace', path: 'active', value: false }];
    for (const Operations of [
      [off, { op: 'move' }],
      [7, off],
      [off, { op: 'add', OP: 'remove', path: 'title' }],
      [off, { op: 'add', path: 7 }],
      [...Array.from({ length: 1000 }, () => ({ op: 'add' })), off],
    ]) {
      expect(userOperationsOf({ Operations })).toEqual(alone);
    }
    const title = { op: 'add', path: 'title', value: 'x' };
    expect(
      userOperationsOf({ Operations: [title], operations: [off] }),
    ).toEqual(alone);
    expect(() =>
      userOperationsOf({ Operations: [title], operations: [title] }),
    ).toThrow(ScimRequestError);
    for (const body of [
      { Operations: [{ op: 'move', path: 'active', value: false }] },
      { Operations: [off, { ...off, value: true }, { op: 'move' }] },
      { Operations: [{ op: 'move' }] },
      [off],
    ]) {
      expect(() => userOperationsOf(body)).toThrow(ScimRequestError);
    }
  });

  it.each(['\\u0000', '\\ud800'])(
    'whatever a filter of a path spells: %s',
    async (escape) => {
      const s = await ready();
      const wrong: PatchOperation = {
        op: 'add',
        path: `phoneNumbers[type eq "a${escape}b"].value`,
        value: 'x',
      };
      await expect(s.patch(wrong)).rejects.toThrow(ScimRequestError);
      await s.patch(wrong, { op: 'replace', path: 'active', value: false });
      isGone(s);
    },
  );

  it('and changes nothing else of one whose request is wrong', async () => {
    const s = await ready();
    const [name, email] = ['Jane Married', 'jane.doe@example.org'];
    await s.unit.run((tx) => s.admin.updateUser(tx, userId, { name, email }));
    await s.put({ ...person, title: 'T', emails: 'x', active: false });
    isGone(s);
    expect(s.admin.user(userId)?.name).toBe(name);
    expect((await s.scim.findUser(userId))?.attributes).not.toHaveProperty(
      'title',
    );
    // Nothing more the second time.
    await s.put({ ...person, emails: 'x', active: false });
    isGone(s);
  });

  it('keeps the name of someone whose new one is none', async () => {
    const s = await ready();
    await s.put({
      emails: person.emails,
      userName: `${' '.repeat(210)}x`,
      active: false,
    });
    isGone(s);
    expect(s.admin.user(userId)?.name).toBe('Jane Doe');
  });

  it('but not when the same request says both, nor when it ends active', async () => {
    const s = await ready();
    await expect(
      s.put({ ...person, active: false, [CORE]: { active: true } }),
    ).rejects.toThrow(ScimInvalidValueError);
    await expect(
      s.patch(
        { op: 'replace', path: 'active', value: false },
        { op: 'replace', path: 'active', value: true },
        { op: 'replace', path: 'no path[', value: 1 },
      ),
    ).rejects.toThrow();
    expect(s.admin.user(userId)?.deactivatedAt).toBeNull();
    // Nor past the last admin.
    s.admin.putUser({ id: 'root', name: 'Root', email: 'root@example.org' });
    s.admin.putUser({
      id: userId,
      name: 'Jane Doe',
      email: 'jane.doe@example.org',
      roleIds: ['admin'],
    });
    await expect(
      s.put({ ...person, emails: 'x', active: false }),
    ).rejects.toMatchObject({ code: 'last-admin' });
  });
});

describe('what is judged', () => {
  const ENT_PATH = `${ENTERPRISE}:manager:displayName`;

  it('bounds what a PATCH adds up to, as a body', async () => {
    for (const prefix of ['k', 'name.k', `${ENTERPRISE}:k`]) {
      const s = await provisioned();
      const add = (n: number) =>
        s.patch(
          ...Array.from({ length: n }, (_, i) => ({
            op: 'add' as const,
            path: `${prefix}${i}`,
            value: 1,
          })),
        );
      await expect(add(150)).rejects.toThrow(ScimInvalidValueError);
      await add(50);
    }
  });

  it('judges the address a PATCH changes, not one beside it', async () => {
    const add: PatchOperation = {
      op: 'add',
      path: 'emails',
      value: [{ value: 'c@example.org', type: 'home' }],
    };
    for (const emails of [
      [
        { value: 'a@example.org', primary: true },
        { value: 'b@example.org', primary: true },
      ],
      [{ value: 'no address', type: 'work' }],
    ]) {
      const s = await provisioned();
      await s.unit.run((tx) =>
        s.scim.update(tx, {
          userId,
          userName: person.userName,
          externalId: null,
          attributes: { emails },
        }),
      );
      const user = await s.patch(add);
      expect(user.attributes['emails']).toHaveLength(emails.length + 1);
      expect(s.admin.user(userId)?.email).toBe('jane.doe@example.org');
      for (const value of ['x', [{ value: 'none', primary: true }], emails]) {
        const t = await provisioned();
        await expect(
          t.patch({ op: 'replace', path: 'emails', value }),
        ).rejects.toThrow(ScimInvalidValueError);
      }
    }
  });

  it('refuses a path on from an attribute of the enterprise extension', async () => {
    const s = await provisioned();
    await expect(
      s.patch({ op: 'add', path: ENT_PATH, value: 'x' }),
    ).rejects.toMatchObject({ scimType: 'invalidPath' });
    await expect(
      s.patch({ op: 'add', value: { [ENT_PATH]: 'x' } }),
    ).rejects.toThrow(ScimRequestError);
  });
});

describe('what directories repeat, clear and leave out', () => {
  it('writes nothing for the same attributes in another order', async () => {
    const s = await provisioned();
    const events = s.audit.events.length;
    await s.put({
      ...person,
      name: { familyName: 'Doe', givenName: 'Jane' },
      emails: [{ type: 'work', primary: true, value: person.emails[0]?.value }],
    });
    for (let i = 0; i < 3; i++) {
      await s.patch({
        op: 'add',
        path: 'emails',
        value: [
          { primary: true, value: person.emails[0]?.value, type: 'work' },
        ],
      });
    }
    expect(s.audit.events).toHaveLength(events);
    expect((await s.scim.findUser(userId))?.attributes['emails']).toEqual(
      person.emails,
    );
  });

  it('takes read-only attributes as they are, and refuses others', async () => {
    const s = await provisioned();
    const group = await s.createGroup.handle({
      actor: s.actor,
      body: { displayName: 'Writers', members: [{ value: userId }] },
    });
    const renamed = await s.patchGroup.handle({
      actor: s.actor,
      groupId: group.id,
      operations: [
        { op: 'replace', value: { id: group.id, displayName: 'Authors' } },
      ],
    });
    expect(renamed.displayName).toBe('Authors');
    await s.patch({ op: 'replace', value: { id: userId, title: 'Writer' } });
    await s.patch({ op: 'replace', path: 'id', value: userId });
    await expect(
      s.patch({ op: 'replace', value: { id: 'other', title: 'W' } }),
    ).rejects.toThrow(ScimMutabilityError);
    await expect(s.patch({ op: 'remove', path: 'id' })).rejects.toThrow(
      ScimMutabilityError,
    );
  });

  it('reads an address without a value as none', async () => {
    for (const emails of [
      [{ value: '', type: 'work' }],
      [{ value: null }],
      [{ type: 'work', primary: true }],
      [],
    ]) {
      const s = await provisioned();
      await s.put({ ...person, emails });
      expect(s.admin.user(userId)?.email).toBeNull();
    }
    const s = await provisioned();
    await s.patch({ op: 'remove', path: 'emails[type eq "work"].value' });
    expect(s.admin.user(userId)?.email).toBeNull();
  });

  it('leaves an address alone that the directory did not change', async () => {
    const s = scimSetUp();
    const actor = s.directory;
    await s.createUser.handle({ actor, body: { userName: 'x' } });
    const set = (email: string) =>
      s.unit.run((tx) => s.admin.updateUser(tx, 'x', { name: 'x', email }));
    await set('x@example.org');
    await s.patchUser.handle({
      actor,
      userId: 'x',
      operations: [{ op: 'replace', path: 'title', value: 'T' }],
    });
    await s.replaceUser.handle({ actor, userId: 'x', body: { userName: 'x' } });
    expect(s.admin.user('x')?.email).toBe('x@example.org');
    // It changes it: theirs to change while nobody signed in.
    await s.replaceUser.handle({
      actor,
      userId: 'x',
      body: { userName: 'x', emails: [{ value: 'y@example.org' }] },
    });
    expect(s.admin.user('x')?.email).toBe('y@example.org');
  });

  it('removes what is listed, all for null, and nothing by chance', async () => {
    const s = await provisioned();
    const addresses = [
      { type: 'work', locality: 'A' },
      { type: 'home', locality: 'B' },
    ];
    await s.put({ ...person, addresses, phoneNumbers: [{ value: '1' }] });
    await s.patch({
      op: 'remove',
      path: 'addresses',
      value: [{ locality: 'B', type: 'home' }],
    });
    const after = await s.patch({
      op: 'remove',
      path: 'phoneNumbers',
      value: null,
    });
    expect(after.attributes['addresses']).toEqual([addresses[0]]);
    expect(after.attributes).not.toHaveProperty('phoneNumbers');

    const group = await s.createGroup.handle({
      actor: s.actor,
      body: { displayName: 'Writers', members: [{ value: userId }] },
    });
    const members = (operation: Omit<PatchOperation, 'op'>) =>
      s.patchGroup.handle({
        actor: s.actor,
        groupId: group.id,
        operations: [{ op: 'remove', path: 'members', ...operation }],
      });
    for (const value of [[], [{ display: 'Jane Doe' }], [{ $ref: 'x' }]]) {
      await expect(members({ value })).rejects.toThrow();
    }
    expect((await members({ value: null })).members).toEqual([]);
    // Nobody is added by a filter on who is in it.
    await expect(
      s.patchGroup.handle({
        actor: s.actor,
        groupId: group.id,
        operations: [
          {
            op: 'replace',
            path: `members[value eq "${userId}"].display`,
            value: 'J',
          },
        ],
      }),
    ).rejects.toMatchObject({ scimType: 'noTarget' });
  });

  it('refuses a filtered change that would make a list of one value, and text that is none', async () => {
    const s = await provisioned();
    await expect(
      s.patch({
        op: 'add',
        path: 'name[givenName eq "Joe"].familyName',
        value: 'x',
      }),
    ).rejects.toMatchObject({ scimType: 'noTarget' });
    const gone = await s.patch({
      op: 'remove',
      path: 'name[givenName eq "Jane"]',
    });
    expect(gone.attributes).not.toHaveProperty('name');
    for (const title of ['a\u0000b', 'a\ud800b']) {
      await expect(s.put({ ...person, title })).rejects.toThrow(
        ScimInvalidValueError,
      );
      await expect(
        s.patch({ op: 'replace', path: 'title', value: title }),
      ).rejects.toThrow(ScimInvalidValueError);
    }
    await s.put({
      ...person,
      emails: [{ value: 'a@b.co', type: { toString: 1, valueOf: 1 } }],
    });
  });
});
