import { ProjectConfig } from '@openfolia/content-model';
import {
  config as baseConfig,
  module,
} from '../../../tests/fakes/fake-content.js';
import { actorWith } from '../../../tests/fakes/actors.js';
import {
  coversChanges,
  requirementsOf,
  type ReviewedChanges,
  signsOff,
} from './review-scope.js';

const withSafety = (restricted: boolean) =>
  ProjectConfig.parse({
    ...baseConfig,
    moduleTypes: [
      { id: 'concept', label: 'Concept' },
      { id: 'safety', label: 'Safety', restricted },
    ],
  });
const safetyMeta = { ...module('note').meta, type: 'safety' };
const subject = { type: 'module', lang: 'en', moduleId: 'note' } as const;

describe('requirementsOf', () => {
  it('keeps a sign-off a change set un-restricts on its own branch', () => {
    // A new safety module (head only), with openfolia.yaml changed to drop the
    // restriction on the same branch.
    const changes: ReviewedChanges = {
      sides: [
        { config: withSafety(false), subject, meta: safetyMeta },
        {
          config: withSafety(true),
          subject: { type: 'module', lang: 'en', moduleId: 'other' },
          meta: module('other').meta,
        },
      ],
      others: [],
      configs: [withSafety(true), withSafety(false)],
    };
    expect(requirementsOf(changes)).toEqual(['review', 'sign-off/safety']);
  });

  it('counts a broken module under every restricted type', () => {
    const changes: ReviewedChanges = {
      sides: [{ config: withSafety(true), subject, meta: 'unreadable' }],
      others: [],
      configs: [withSafety(true), withSafety(true)],
    };
    expect(requirementsOf(changes)).toEqual(['review', 'sign-off/safety']);
    const typed = actorWith(['content.approve'], { moduleTypes: ['safety'] });
    expect(signsOff(typed, 'safety', changes)).toBe(false);
    expect(signsOff(actorWith(['content.approve']), 'safety', changes)).toBe(
      true,
    );
  });
});

describe('restricted types come from the base and the head', () => {
  const unrestricted = withSafety(false);
  const restricted = withSafety(true);
  const approver = actorWith(['content.approve'], { moduleTypes: ['safety'] });

  it('a new module of a type restricted at the base needs its sign-off, even un-restricted at the head', () => {
    const changes: ReviewedChanges = {
      // The new module exists at the head only, read with the head's config.
      sides: [{ config: unrestricted, subject, meta: safetyMeta }],
      others: ['openfolia.yaml'],
      configs: [restricted, unrestricted],
    };
    expect(requirementsOf(changes)).toEqual(['review', 'sign-off/safety']);
    expect(signsOff(approver, 'safety', changes)).toBe(true);
  });

  it('a new module of a restricted type needs its sign-off', () => {
    const changes: ReviewedChanges = {
      sides: [{ config: restricted, subject, meta: safetyMeta }],
      others: [],
      configs: [restricted, restricted],
    };
    expect(requirementsOf(changes)).toEqual(['review', 'sign-off/safety']);
  });

  it('a change to openfolia.yaml alone needs every sign-off, from an approver of the whole type', () => {
    const two = ProjectConfig.parse({
      ...baseConfig,
      moduleTypes: [
        { id: 'concept', label: 'Concept', restricted: true },
        { id: 'safety', label: 'Safety', restricted: true },
      ],
    });
    const changes: ReviewedChanges = {
      sides: [],
      others: ['openfolia.yaml'],
      configs: [two, unrestricted],
    };
    expect(requirementsOf(changes)).toEqual([
      'review',
      'sign-off/concept',
      'sign-off/safety',
    ]);
    expect(signsOff(approver, 'safety', changes)).toBe(true);
    expect(signsOff(approver, 'concept', changes)).toBe(false);
    expect(
      signsOff(
        actorWith(['content.approve'], {
          moduleTypes: ['safety'],
          languages: ['en'],
        }),
        'safety',
        changes,
      ),
    ).toBe(false);
  });

  it('without a config change, a restricted type nothing changed needs no sign-off', () => {
    const changes: ReviewedChanges = {
      sides: [{ config: restricted, subject, meta: module('note').meta }],
      others: [],
      configs: [restricted, restricted],
    };
    expect(requirementsOf(changes)).toEqual(['review']);
  });
});

describe('coversChanges', () => {
  it('needs an unrestricted role for any other file', () => {
    const changes: ReviewedChanges = {
      sides: [],
      others: ['openfolia.yaml'],
      configs: [withSafety(false), withSafety(false)],
    };
    expect(
      coversChanges(
        actorWith(['content.review'], { languages: ['en'] }),
        'content.review',
        changes,
      ),
    ).toBe(false);
    expect(
      coversChanges(actorWith(['content.review']), 'content.review', changes),
    ).toBe(true);
  });
});
