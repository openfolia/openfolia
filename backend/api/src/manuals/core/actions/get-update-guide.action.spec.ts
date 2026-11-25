import { parseManifest, ProjectConfig } from '@openfolia/content-model';
import { actorWith, READER } from '../../../../tests/fakes/actors.js';
import {
  config as baseConfig,
  manifest,
  module,
  readable,
} from '../../../../tests/fakes/fake-content.js';
import { NotFoundError } from '../../../base/core/errors.js';
import { GetUpdateGuideAction } from './get-update-guide.action.js';

const config = ProjectConfig.parse({
  ...baseConfig,
  moduleTypes: [
    { id: 'concept', label: 'Concept' },
    { id: 'procedure', label: 'Procedure' },
  ],
  audiences: [
    { id: 'public', label: { en: 'Public', de: 'Öffentlich' } },
    { id: 'internal', label: 'Internal' },
  ],
  variantAttributes: [
    ...baseConfig.variantAttributes,
    { id: 'software', label: 'Software', kind: 'version' },
  ],
});

const guide = parseManifest(
  `schemaVersion: 1
kind: update-guide
title: Update guide
variants:
  - model: small
guide:
  attribute: software
  versions: ["1.0", "2.0", "3.0"]
  steps:
    - { module: backup, version: "3.0", phase: before }
    - { module: install, version: "2.0", phase: during, when: model in (large) }
    - { module: backup, version: "2.0", phase: before, level: public }
    - { module: secret, version: "2.0", phase: after }
`,
  { id: 'update' },
);
const secret = {
  ...module('secret'),
  meta: { ...module('secret').meta, type: 'procedure' },
};
const content = {
  config,
  manifests: [guide, manifest('op', ['backup'])],
  modules: [
    module('backup', 'en', 'Back up.'),
    module('install', 'en', 'Install.'),
    secret,
  ],
};
const action = new GetUpdateGuideAction();

describe('GetUpdateGuideAction (#906)', () => {
  it('gives the versions, levels, options and every step, by version and phase', async () => {
    const view = await action.handle({
      actor: READER,
      snapshot: readable(content),
      id: 'update',
      lang: 'de',
    });
    expect(view).toMatchObject({
      id: 'update',
      lang: 'de',
      title: 'Update guide',
      attribute: { id: 'software', label: 'Software' },
      versions: ['1.0', '2.0', '3.0'],
      // Every configured level (the guide is for every audience), in the guide's language.
      levels: [
        { id: 'public', label: 'Öffentlich' },
        { id: 'internal', label: 'Internal' },
      ],
      options: [
        {
          id: 'model',
          label: 'Model',
          values: [
            { id: 'small', label: 'Small' },
            { id: 'large', label: 'Large' },
          ],
        },
      ],
    });
    expect(
      view.steps.map((s) => [s.id, s.version, s.phase, s.level, s.condition]),
    ).toEqual([
      ['backup--2', '2.0', 'before', 'public', null],
      ['install', '2.0', 'during', null, 'model in (large)'],
      ['secret', '2.0', 'after', null, null],
      ['backup', '3.0', 'before', null, null],
    ]);
    expect(view.steps[1]?.when).toEqual({
      op: 'in',
      attr: 'model',
      values: ['large'],
    });
    expect(JSON.stringify(view.steps[0]?.blocks)).toContain('Back up.');
  });

  it('leaves out a step whose module the reader may not see, even by name', async () => {
    // A reader of concepts only.
    const publicReader = actorWith(['content.read'], {
      moduleTypes: ['concept'],
    });
    const view = await action.handle({
      actor: publicReader,
      snapshot: readable(content, publicReader),
      id: 'update',
      lang: 'en',
    });
    expect(view.steps.map((s) => s.id)).toEqual([
      'backup--2',
      'install',
      'backup',
    ]);
    expect(JSON.stringify(view)).not.toContain('secret');
  });

  it.each([
    ['an unknown manual', 'nope', 'en'],
    ['a manual of another kind', 'op', 'en'],
    ['an unconfigured language', 'update', 'fr'],
  ])('is not found for %s', async (_case, id, lang) => {
    await expect(
      action.handle({ actor: READER, snapshot: readable(content), id, lang }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
