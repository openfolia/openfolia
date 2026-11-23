import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import angular from 'angular-eslint';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';

import plugin from './plugin.mjs';

const rules = { 'openfolia/no-html-text': 'error' };

function lintTemplate(template) {
  return new Linter({ configType: 'flat' }).verify(
    template,
    [
      {
        files: ['**/*.html'],
        languageOptions: { parser: angular.templateParser },
        plugins: { openfolia: plugin },
        rules,
      },
    ],
    { filename: 'x.component.html' },
  );
}

function lintCode(code) {
  return new Linter({ configType: 'flat' }).verify(
    code,
    [
      {
        files: ['**/*.ts'],
        languageOptions: { parser: tseslint.parser },
        plugins: { openfolia: plugin },
        rules,
      },
    ],
    { filename: 'x.page.ts' },
  );
}

describe('openfolia/no-html-text', () => {
  it('refuses a template binding that shows a value as HTML', () => {
    for (const template of [
      '<span [innerHTML]="text"></span>',
      '<span [innerHtml]="text"></span>',
      '<div [outerHTML]="t(\'editor.x\', { name })"></div>',
    ]) {
      const messages = lintTemplate(template);
      assert.equal(messages.length, 1, template);
      assert.match(messages[0].message, /shows its value as HTML/);
    }
  });

  it('allows text bindings and an explained exception', () => {
    for (const template of [
      '<span>{{ text }}</span>',
      '<span [textContent]="text"></span>',
      '<z-alert-dialog-description [zDescription]="text" />',
      '<!-- eslint-disable-next-line openfolia/no-html-text -- escaped -->\n<span [innerHTML]="html"></span>',
    ]) {
      assert.deepEqual(lintTemplate(template), [], template);
    }
  });

  it('refuses a string zContent, a host binding and DOM writes of HTML', () => {
    for (const code of [
      "dialogs.create({ zContent: this.t('editor.x.description', { name }) });",
      "dialogs.create({ zContent: t('editor.x') });",
      "sheets.create({ zContent: transloco.translate('editor.x', { name }) });",
      "dialogs.create({ zContent: 'Remove <b>' + name + '</b>?' });",
      'dialogs.create({ zContent: `Remove ${name}?` });',
      "dialogs.create({ zContent: ok ? this.t('editor.a') : this.t('editor.b') });",
      "dialogs.create({ 'zContent': 'Remove?' });",
      "const host = { '[innerHTML]': 'html()' };",
      "const host = { '[innerHtml]': 'html()' };",
      "class A { @HostBinding('innerHTML') html = ''; }",
      "renderer.setProperty(el, 'innerHTML', name);",
      'Object.assign(el, { innerHTML: name });',
      'el.innerHTML = name;',
      "el['outerHTML'] = name;",
      "el.insertAdjacentHTML('beforeend', name);",
    ]) {
      assert.equal(lintCode(code).length, 1, code);
    }
  });

  it('allows a template or component zContent, plain-text descriptions and reading HTML', () => {
    for (const code of [
      'dialogs.create({ zContent: this.panel() });',
      'dialogs.create({ zContent: RenameFormComponent });',
      'dialogs.create({ zContent: this.template });',
      "dialogs.confirm({ zDescription: this.t('editor.x.description', { name }) });",
      "dialogs.confirm({ zDescriptionHtml: { key: 'editor.x', params: { name } } });",
      'const written = out.body.innerHTML;',
      'el.textContent = name;',
      "renderer.setProperty(el, 'textContent', name);",
      "class A { @HostBinding('class') cls = ''; }",
    ]) {
      assert.deepEqual(lintCode(code), [], code);
    }
  });
});
