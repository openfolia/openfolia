import { actorWith } from '../../../tests/fakes/actors.js';
import { allows, moduleTarget } from '../../access/core/allows.js';
import { capAudience } from './webhook-audience.js';

const AUDIENCES = ['public', 'customer', 'internal'];
const config = {
  audiences: AUDIENCES.map((id) => ({ id, label: id })),
  facets: [],
};
const at = (audience: string) =>
  moduleTarget({ lang: 'en', type: 'procedure', audience, facets: {} }, config);
const reads = (actor: ReturnType<typeof actorWith>, audience: string) =>
  allows(actor, 'content.read', at(audience));

describe('capAudience', () => {
  it('narrows every role to the limit, never widening one', () => {
    const everything = actorWith(['content.read']);
    const capped = capAudience(everything, 'customer', AUDIENCES);
    expect(AUDIENCES.map((a) => reads(capped, a))).toEqual([true, true, false]);
    const narrow = actorWith(['content.read'], { maxAudience: 'public' });
    const kept = capAudience(narrow, 'internal', AUDIENCES);
    expect(AUDIENCES.map((a) => reads(kept, a))).toEqual([true, false, false]);
  });

  it('fails closed on a level the configuration does not hold', () => {
    const capped = capAudience(actorWith(['content.read']), 'gone', AUDIENCES);
    expect(AUDIENCES.some((a) => reads(capped, a))).toBe(false);
  });

  it('keeps the actor’s identity and its other scope dimensions', () => {
    const actor = {
      ...actorWith(['content.read'], { languages: ['de'] }),
      id: 'someone',
    };
    const capped = capAudience(actor, 'public', AUDIENCES);
    expect(capped).toMatchObject({ kind: 'user', id: 'someone' });
    expect(capped.roles[0]?.scope).toEqual({
      languages: ['de'],
      maxAudience: 'public',
    });
  });
});
