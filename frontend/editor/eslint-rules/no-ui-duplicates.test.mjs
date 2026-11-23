import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { Linter } from 'eslint';

import plugin from './plugin.mjs';
import { uiComponentNames } from './no-ui-duplicates.mjs';

function lint(filename) {
  const linter = new Linter();
  return linter.verify(
    '',
    [
      {
        files: ['**/*.ts'],
        plugins: { openfolia: plugin },
        rules: { 'openfolia/no-ui-duplicates': 'error' },
      },
    ],
    { filename },
  );
}

describe('openfolia/no-ui-duplicates', () => {
  it('finds the components of the UI library', () => {
    assert.ok(uiComponentNames().includes('button'));
    assert.ok(!uiComponentNames().includes('showcase'));
  });

  it('refuses an app file named like a UI component', () => {
    for (const file of [
      'button.component.ts',
      'button.ts',
      'widgets/button.directive.ts',
    ]) {
      const messages = lint(`src/app/${file}`);
      assert.equal(messages.length, 1, file);
      assert.match(messages[0].message, /already exists in frontend\/ui/);
    }
  });

  it('allows app-specific components, specs and unrelated files', () => {
    for (const file of [
      'home.page.ts',
      'toolbar.component.ts',
      'button.component.spec.ts',
    ]) {
      assert.equal(lint(`src/app/${file}`).length, 0, file);
    }
  });

  it('lists nothing for a directory without components', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ui-'));
    mkdirSync(join(dir, 'ui'));
    assert.deepEqual(uiComponentNames(new URL(`file://${dir}/`)), []);
  });
});
