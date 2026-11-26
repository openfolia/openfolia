import {
  defineAuditActions,
  registerAuditActions,
} from './audit-action-registry.js';

const things = defineAuditActions('things', ['thing.create', 'thing.delete']);
const others = defineAuditActions('others', ['other.create']);

describe('registerAuditActions', () => {
  it('lists each group’s actions in the order given, with their group', () => {
    expect(registerAuditActions([things, others])).toEqual([
      { action: 'thing.create', group: 'things' },
      { action: 'thing.delete', group: 'things' },
      { action: 'other.create', group: 'others' },
    ]);
  });

  it('refuses an action registered twice, so no group takes over another’s', () => {
    expect(() =>
      registerAuditActions([
        things,
        defineAuditActions('rival', ['thing.delete']),
      ]),
    ).toThrow(
      'The audit action "thing.delete" is registered by things and by rival',
    );
    expect(() => registerAuditActions([things, things])).toThrow(
      'The audit action "thing.create" is registered by things and by things',
    );
    expect(() =>
      registerAuditActions([
        defineAuditActions('twice', ['thing.create', 'thing.create']),
      ]),
    ).toThrow(
      'The audit action "thing.create" is registered by twice and by twice',
    );
  });

  it('freezes a component’s actions as they are defined', () => {
    expect(Object.isFrozen(things)).toBe(true);
    expect(() =>
      (things.actions as unknown as string[]).push('thing.steal'),
    ).toThrow(TypeError);
  });

  it('freezes what it lists', () => {
    const registered = registerAuditActions([things]);
    expect(Object.isFrozen(registered)).toBe(true);
    expect(registered.every((a) => Object.isFrozen(a))).toBe(true);
  });
});
