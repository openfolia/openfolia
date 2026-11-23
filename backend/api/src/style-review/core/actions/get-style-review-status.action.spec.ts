import { actorWith } from '../../../../tests/fakes/actors.js';
import { FakeStyleReviewer } from '../../../../tests/fakes/fake-style-reviewer.js';
import { ForbiddenError } from '../../../base/core/errors.js';
import { GetStyleReviewStatusAction } from './get-style-review-status.action.js';

const editor = actorWith(['content.read', 'content.edit']);

describe('GetStyleReviewStatusAction', () => {
  it('says the review is set up when a reviewer is configured', async () => {
    const action = new GetStyleReviewStatusAction(new FakeStyleReviewer());
    await expect(action.handle({ actor: editor })).resolves.toEqual({
      configured: true,
    });
  });

  it('says it is not set up without one', async () => {
    const none = Object.assign(new FakeStyleReviewer(), { configured: false });
    const action = new GetStyleReviewStatusAction(none);
    await expect(action.handle({ actor: editor })).resolves.toEqual({
      configured: false,
    });
  });

  it('needs content.edit, as asking for a review does', async () => {
    const action = new GetStyleReviewStatusAction(new FakeStyleReviewer());
    await expect(
      action.handle({ actor: actorWith(['content.read']) }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
