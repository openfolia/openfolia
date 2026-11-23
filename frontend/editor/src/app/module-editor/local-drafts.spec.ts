import { UNCONFIRMED } from '../permissions/unconfirmed';
import { clearDraft, draftKey, readDraft, writeDraft } from './local-drafts';

const SUBJECT = { changeSetId: 'cs1', lang: 'de', moduleId: 'm1' };
const DRAFT = {
  doc: { type: 'doc', content: [] },
  version: 1,
  baseCommit: 'c1',
  at: '2026-01-01T00:00:00Z',
};

describe('local drafts', () => {
  afterEach(() => localStorage.clear());

  it('keeps a draft per person', () => {
    expect(writeDraft('u1', SUBJECT, DRAFT)).toBe(true);
    expect(readDraft('u1', SUBJECT)).toEqual(DRAFT);
    expect(readDraft('u2', SUBJECT)).toBeNull();
  });

  it('keeps nothing under the placeholder of an unconfirmed sign-in, nor reads it back (#716)', () => {
    const waiting = `${UNCONFIRMED}x`;
    expect(writeDraft(waiting, SUBJECT, DRAFT)).toBe(false);
    expect(localStorage.length).toBe(0);
    // Even a draft someone stored under such a key is nobody's.
    localStorage.setItem(draftKey(waiting, SUBJECT), JSON.stringify(DRAFT));
    expect(readDraft(waiting, SUBJECT)).toBeNull();
    clearDraft(waiting, SUBJECT);
    expect(localStorage.length).toBe(1);
  });
});
