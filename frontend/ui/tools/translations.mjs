/**
 * The checks every translation scope passes (`i18n.test.mjs` here and in each app): the shipped
 * languages have exactly the source language's keys, each message is valid ICU with the same
 * arguments as the source, and every key is used in the code (and every key used exists).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import MessageFormat from '@messageformat/core';
import { parse } from '@messageformat/parser';

export const SOURCE_LANGUAGE = 'en';

/** `{ a: { b: 'x' } }` → `Map { 'a.b' => 'x' }`. */
export function flatten(tree, prefix = '', out = new Map()) {
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object') flatten(value, path, out);
    else out.set(path, value);
  }
  return out;
}

/** The languages of a scope's folder and their flat messages. */
export function readScope(dir) {
  const languages = new Map();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const tree = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    languages.set(file.replace(/\.json$/, ''), flatten(tree));
  }
  return languages;
}

/**
 * The text a person reads in an ICU message: its literal parts, every branch of a plural or
 * select, one per line, without the argument names (`{dir}`) or the branch keys.
 */
export function readableText(message) {
  const parts = [];
  const walk = (tokens) => {
    for (const token of tokens) {
      if (token.type === 'content') parts.push(token.value);
      for (const c of token.cases ?? []) walk(c.tokens);
      parts.push('\n');
    }
  };
  walk(parse(message));
  return parts.join('');
}

/** The argument names of an ICU message (`{name}`, `{n, plural, …}`), sorted. */
export function argumentsOf(message) {
  const names = new Set();
  const walk = (tokens) => {
    for (const token of tokens) {
      if (token.type === 'content' || token.type === 'octothorpe') continue;
      names.add(token.arg);
      for (const c of token.cases ?? []) walk(c.tokens);
    }
  };
  walk(parse(message));
  return [...names].sort();
}

/** Problems with the languages of one scope, as sentences; none means it passes. */
export function checkLanguages(languages) {
  const problems = [];
  const source = languages.get(SOURCE_LANGUAGE);
  if (!source) return [`no ${SOURCE_LANGUAGE}.json`];
  for (const [language, messages] of languages) {
    for (const key of source.keys()) {
      if (!messages.has(key)) problems.push(`${language}: "${key}" is missing`);
    }
    for (const [key, message] of messages) {
      if (!source.has(key)) {
        problems.push(
          `${language}: "${key}" is not in ${SOURCE_LANGUAGE}.json`,
        );
        continue;
      }
      if (typeof message !== 'string' || message.trim() === '') {
        problems.push(`${language}: "${key}" is empty`);
        continue;
      }
      try {
        new MessageFormat(language).compile(message);
      } catch (error) {
        problems.push(
          `${language}: "${key}" is not valid ICU: ${error.message}`,
        );
        continue;
      }
      if (message.includes('{{')) {
        problems.push(`${language}: "${key}" uses {{ }}: use ICU {name}`);
      }
      const expected = argumentsOf(source.get(key)).join(', ');
      const actual = argumentsOf(message).join(', ');
      if (expected !== actual) {
        problems.push(
          `${language}: "${key}" has the arguments [${actual}], ${SOURCE_LANGUAGE} [${expected}]`,
        );
      }
    }
  }
  return problems;
}

/** Every source file (`.ts`, `.html`) under the directories, specs left out. */
export function sourceFiles(dirs) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|html)$/.test(entry) && !/\.spec\.ts$/.test(entry))
        files.push(path);
    }
  };
  dirs.forEach(walk);
  return files;
}

/**
 * The keys of `scope` the code names: string literals that are a whole key (`'ui.toast.undo'`).
 * Keys are always written out in full (README), so this finds every use.
 */
export function usedKeys(scope, files) {
  const pattern = new RegExp(
    `['"\`](${scope}\\.[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)+)['"\`]`,
    'g',
  );
  const used = new Set();
  for (const file of files) {
    // A key named only in a comment is not a use.
    const code = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
      .replace(/<!--[\s\S]*?-->/g, '');
    for (const match of code.matchAll(pattern)) {
      used.add(match[1]);
    }
  }
  return used;
}

/** Unused keys of the source language, and used keys it does not have. */
export function checkUsage(scope, languages, files) {
  const source = languages.get(SOURCE_LANGUAGE) ?? new Map();
  const used = usedKeys(scope, files);
  const keys = new Set([...source.keys()].map((k) => `${scope}.${k}`));
  return {
    unused: [...keys].filter((k) => !used.has(k)).sort(),
    unknown: [...used].filter((k) => !keys.has(k)).sort(),
  };
}
