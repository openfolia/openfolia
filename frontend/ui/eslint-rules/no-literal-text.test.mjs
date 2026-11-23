import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import angular from 'angular-eslint';
import { Linter } from 'eslint';

import plugin from './plugin.mjs';

function lint(template, options) {
  const linter = new Linter({ configType: 'flat' });
  return linter.verify(
    template,
    [
      {
        files: ['**/*.html'],
        languageOptions: { parser: angular.templateParser },
        plugins: { openfolia: plugin },
        rules: {
          'openfolia/no-literal-text': options ? ['error', options] : 'error',
        },
      },
    ],
    { filename: 'x.component.html' },
  );
}

describe('openfolia/no-literal-text', () => {
  it('refuses literal text, text attributes and string literals shown as text', () => {
    for (const template of [
      '<button>Save</button>',
      '<p>Page {{ n }}</p>',
      '<button aria-label="Close"></button>',
      '<of-empty-state title="Nothing here" />',
      "<p>{{ open ? 'Open' : 'Closed' }}</p>",
      `<button [attr.aria-label]="'Account: ' + name"></button>`,
      '<of-list-frame emptyTitle="No modules" />',
      `<of-toast [actionLabel]="'Undo'" />`,
      '<of-safety-notice hazard="Hot surface" />',
      // A key that is not translated shows as the key.
      "<p>{{ 'ui.dialog.close' }}</p>",
      `<of-empty-state [title]="'ui.states.empty.title'" />`,
      "<p>{{ ('ui.dialog.close' | uppercase) }}</p>",
    ]) {
      assert.equal(lint(template).length, 1, template);
    }
  });

  it('allows keys, symbols, bindings, comparisons and attributes that are not texts', () => {
    for (const template of [
      "<button>{{ 'ui.dialog.close' | transloco }}</button>",
      `<button [attr.aria-label]="'ui.dialog.close' | transloco"></button>`,
      "<p>{{ 'ui.listFrame.pageOf' | transloco: { page: 1, last: 2 } }}</p>",
      '<span>· / → 42</span>',
      '<p>{{ name }}</p>',
      "<ng-icon [name]=\"theme === 'dark' ? 'lucideMoon' : 'lucideSun'\" />",
      '<div class="flex gap-2" data-slot="list-scroller" role="region"></div>',
      "<p>{{ (open ? 'ui.a.open' : 'ui.a.closed') | transloco }}</p>",
      "<p>{{ label() || ('ui.dialog.close' | transloco) }}</p>",
      "<p>{{ t('ui.dialog.close') }}</p>",
      "<p>{{ labels['draft'] | transloco }}</p>",
      '<of-module-tree [emptyTitle]="title()" />',
    ]) {
      assert.deepEqual(lint(template), [], template);
    }
  });

  it('takes an allow-list for words that stay as they are', () => {
    assert.deepEqual(lint('<kbd>Ctrl</kbd>', { allow: ['Ctrl'] }), []);
  });
});
