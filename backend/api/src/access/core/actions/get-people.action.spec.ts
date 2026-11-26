import { actorWith } from '../../../../tests/fakes/actors.js';
import { FakeDeactivatedUsers } from '../../../../tests/fakes/fake-deactivated-users.js';
import { GetPeopleAction } from './get-people.action.js';

const actor = actorWith([]);

describe('GetPeopleAction', () => {
  it('says of each user named, once and by ID, whether they are deactivated', async () => {
    const users = new FakeDeactivatedUsers(['ada']);
    expect(
      await new GetPeopleAction(users).handle({
        actor,
        userIds: ['bo', 'ada', 'nobody', 'bo'],
      }),
    ).toEqual([
      { id: 'ada', deactivated: true },
      { id: 'bo', deactivated: false },
      { id: 'nobody', deactivated: false },
    ]);
    expect(users.asked).toEqual([['ada', 'bo', 'nobody']]);
  });

  it('reads nothing for nobody, nor for what is no user ID', async () => {
    const users = new FakeDeactivatedUsers();
    const action = new GetPeopleAction(users);
    expect(await action.handle({ actor, userIds: [] })).toEqual([]);
    expect(await action.handle({ actor, userIds: ['No ID'] })).toEqual([
      { id: 'No ID', deactivated: false },
    ]);
    expect(users.asked).toEqual([]);
  });

  it('is refused without an actor', async () => {
    await expect(
      new GetPeopleAction(new FakeDeactivatedUsers()).handle({
        actor: undefined as never,
        userIds: ['ada'],
      }),
    ).rejects.toThrow('There is no actor');
  });
});
