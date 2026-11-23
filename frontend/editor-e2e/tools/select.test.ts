import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ALL, selectSpecs, tagsOf, touched } from './select.ts';

const specs = {
  'review.spec.ts':
    "test.describe('review @area:review @api:change-sets @api:comments', …)",
  'releases.spec.ts':
    "test.describe('releases @area:releases @api:releases', …)",
  'shell.spec.ts': "test.describe('shell @area:shell @narrow', …)",
};

test('maps a changed file to what it touches', () => {
  assert.equal(
    touched('frontend/editor/src/app/review/review.page.ts'),
    '@area:review',
  );
  assert.equal(
    touched('frontend/editor/src/app/checks/checks.page.ts'),
    '@area:review',
  );
  assert.equal(
    touched('backend/api/src/releases/core/cut.ts'),
    '@api:releases',
  );
  assert.equal(
    touched('frontend/editor-e2e/specs/review.spec.ts'),
    'spec:review.spec.ts',
  );
  // Shared code: every flow.
  assert.equal(touched('frontend/editor/src/app/api/api-client.ts'), ALL);
  assert.equal(touched('frontend/ui/src/segmented/segmented.ts'), ALL);
  assert.equal(touched('backend/api/src/base/api/json-api.ts'), ALL);
  assert.equal(touched('frontend/editor-e2e/src/fixtures.ts'), ALL);
  assert.equal(touched('packages/content-model/src/index.ts'), ALL);
  // Nothing the browser runs.
  assert.equal(
    touched('frontend/editor/src/app/review/review.page.spec.ts'),
    undefined,
  );
  assert.equal(touched('backend/api/tests/releases.e2e.spec.ts'), undefined);
  assert.equal(touched('docs/agent-rules.md'), undefined);
  assert.equal(touched('scripts/check.mjs'), undefined);
  assert.equal(touched('frontend/editor-e2e/tools/select.ts'), undefined);
});

test('reads the tags of a spec file', () => {
  assert.deepEqual(
    [...tagsOf(specs['review.spec.ts'])],
    ['@area:review', '@api:change-sets', '@api:comments'],
  );
});

test('selects the specs sharing a tag with the change, or that changed', () => {
  assert.deepEqual(
    selectSpecs(['frontend/editor/src/app/review/x.ts'], specs),
    ['review.spec.ts'],
  );
  assert.deepEqual(selectSpecs(['backend/api/src/comments/core/y.ts'], specs), [
    'review.spec.ts',
  ]);
  assert.deepEqual(
    selectSpecs(['frontend/editor-e2e/specs/shell.spec.ts'], specs),
    ['shell.spec.ts'],
  );
  assert.deepEqual(selectSpecs(['docs/agent-rules.md'], specs), []);
});

test('runs every spec for a change it cannot place', () => {
  assert.deepEqual(
    selectSpecs(['frontend/ui/src/button.ts', 'docs/x.md'], specs),
    ['releases.spec.ts', 'review.spec.ts', 'shell.spec.ts'],
  );
});

test('runs every spec for an API component or area no spec is tagged with', () => {
  assert.deepEqual(selectSpecs(['backend/api/src/variants/core/x.ts'], specs), [
    'releases.spec.ts',
    'review.spec.ts',
    'shell.spec.ts',
  ]);
  assert.deepEqual(
    selectSpecs(['frontend/editor-e2e/specs/helpers.ts'], specs),
    ['releases.spec.ts', 'review.spec.ts', 'shell.spec.ts'],
  );
});
