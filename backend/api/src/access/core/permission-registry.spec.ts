import {
  definePermissions,
  registerPermissions,
} from './permission-registry.js';

const reading = definePermissions('reading', [
  {
    key: 'thing.read',
    labelKey: 'editor.admin.permissions.thingRead',
    description: 'Read things.',
    read: true,
  },
]);
const admin = definePermissions('admin', [
  {
    key: 'thing.admin',
    labelKey: 'editor.admin.permissions.thingAdmin',
    description: 'Administer things.',
    global: true,
  },
]);

describe('registerPermissions', () => {
  it('lists each group’s permissions in the order given, with their group', () => {
    expect(registerPermissions([reading, admin])).toEqual([
      { ...reading.permissions[0], group: 'reading' },
      { ...admin.permissions[0], group: 'admin' },
    ]);
  });

  it('refuses a key registered twice, so no group replaces or widens another’s', () => {
    const widened = definePermissions('other', [
      {
        key: 'thing.read',
        labelKey: 'editor.admin.permissions.thingRead',
        description: 'Read things, everywhere.',
        global: true,
      },
    ]);
    expect(() => registerPermissions([reading, admin, widened])).toThrow(
      'The permission "thing.read" is registered by reading and by other',
    );
    expect(() =>
      registerPermissions([
        definePermissions('twice', [
          ...reading.permissions,
          ...reading.permissions,
        ]),
      ]),
    ).toThrow(
      'The permission "thing.read" is registered by twice and by twice',
    );
  });

  it('refuses the same group’s keys twice', () => {
    expect(() => registerPermissions([reading, reading])).toThrow(
      'The permission "thing.read" is registered by reading and by reading',
    );
  });

  it('refuses a global or read flag that is not true', () => {
    const odd = { key: 'thing.odd', labelKey: 'x', description: 'Odd.' };
    for (const flag of ['global', 'read'])
      expect(() =>
        registerPermissions([
          definePermissions('odd', [
            { ...odd, [flag]: false } as unknown as typeof odd,
          ]),
        ]),
      ).toThrow(
        `The permission "thing.odd" of odd has ${flag} set to something other than true`,
      );
  });

  it('freezes what it lists', () => {
    const registered = registerPermissions([reading]);
    expect(Object.isFrozen(registered)).toBe(true);
    expect(Object.isFrozen(registered[0])).toBe(true);
  });
});
