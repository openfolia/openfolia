import { ForbiddenError } from '../../../base/core/errors.js';
import { actorWith } from '../../../../tests/fakes/actors.js';
import { FakeOutboxFeed } from '../../../../tests/fakes/fake-outbox-feed.js';
import { GetOutboxStatusAction } from './get-outbox-status.action.js';

describe('GetOutboxStatusAction', () => {
  it('names the consumers a restore holds, as an error, for administrators', async () => {
    const feed = new FakeOutboxFeed();
    const action = new GetOutboxStatusAction(feed);
    const actor = actorWith(['admin.roles']);
    expect(await action.handle({ actor })).toEqual({
      blocked: [],
      level: 'ok',
    });
    feed.held.add('webhooks');
    feed.held.add('notifications');
    expect(await action.handle({ actor })).toEqual({
      blocked: ['notifications', 'webhooks'],
      level: 'error',
    });
  });

  it('is for administrators only', async () => {
    const action = new GetOutboxStatusAction(new FakeOutboxFeed());
    await expect(
      action.handle({ actor: actorWith(['content.read']) }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
