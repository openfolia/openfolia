// The demo content (#441): an invented car, the Fenna of a made-up maker, in two body styles,
// petrol and electric, for left- and right-hand-drive markets; documented in English, German and
// French. The files are in
// `content/` as a person would write them; this builds a bare content repository from them, with
// a believable history:
//
//   1. the English source (two modules in an earlier wording, `content/history/`),
//   2. the French translation of the first owner modules (`FRENCH_FIRST`), made from that source,
//   3. the earlier wording revised (so those two French modules are outdated for a while),
//   4. the German translation of everything, made from the revised source,
//   5. the rest of the French translation, and the two outdated modules brought up to date.
//
// So every translation is complete and current at the end, and a release cut on the demo has no
// translation warnings (the Releases film, #446, cuts one on camera).
//
// The manual titles and the configured labels (#731) are in all three languages in `content/`;
// the history adds them as it adds the modules: English in 1, French in 2, German in 4, each
// with its translation record, so they are up to date in the translation status.
//
// Every file is read with the content model's parser and checked with its validator, then
// printed canonically, so the repository holds exactly what the API itself would write. Images
// are written in the modules as `demo-image:<name>` and stored as `assets/<sha256>`. Commit dates
// count back from today, on weekdays only, so the history never looks stale.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  mapLabels,
  markConfigCurrent,
  markManifestCurrent,
  parseConfig,
  parseManifest,
  parseModule,
  parseTerm,
  printConfig,
  printManifest,
  printModule,
  printTerm,
  printTranslationRecord,
  translationRecordOf,
  validateManifest,
  validateModule,
  validateTerm,
} from '@openfolia/content-model';
import { DEMO_PEOPLE } from './people.mjs';

/** The demo content's source files. */
export const CONTENT_DIR = join(import.meta.dirname, 'content');
export const SOURCE_LANG = 'en';
/** The translation made in one go, and the one made in two stages. */
export const COMPLETE_LANG = 'de';
export const STAGED_LANG = 'fr';
/** The modules the first stage of the French translation has. */
export const FRENCH_FIRST = [
  'about-this-manual',
  'changing-a-wheel',
  'quick-start-intro',
  'safety-airbags',
  'safety-child-seats',
  'secure-vehicle',
  'setting-the-clock',
  'starting-and-stopping',
  'switch-off',
  'warning-lights',
  'warning-triangle',
];
/** The product (a value of the product facet), as releases name it. */
export const PRODUCT = 'fenna';

const IMAGE = /demo-image:([a-z0-9-]+)/g;

const listFiles = (dir, ext) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith(ext))
        .sort()
    : [];

/**
 * Every picture in `content/images/` (PNG, drawn from `images/source/*.svg` by
 * `render-images.mjs`), by name: its bytes and its `sha256:` reference.
 */
export function demoImages(dir = CONTENT_DIR) {
  return Object.fromEntries(
    listFiles(join(dir, 'images'), '.png').map((file) => {
      const bytes = readFileSync(join(dir, 'images', file));
      const hash = createHash('sha256').update(bytes).digest('hex');
      return [basename(file, '.png'), { bytes, hash, ref: `sha256:${hash}` }];
    }),
  );
}

/** Fails with every error-level issue of `what`, so a broken file never reaches a repository. */
function assertValid(what, issues) {
  const errors = issues.filter((issue) => issue.severity === 'error');
  if (errors.length > 0) {
    throw new Error(
      `${what}: ${errors.map((e) => `${e.code} ${e.message}${e.at ? ` (${e.at})` : ''}`).join('; ')}`,
    );
  }
}

/**
 * The demo content, read and checked: the configuration, the modules by language (the current
 * files, and the earlier wording of some English ones), the manuals, the terms, the images and
 * the safety symbols.
 */
export function readDemoContent(dir = CONTENT_DIR) {
  const config = parseConfig(readFileSync(join(dir, 'openfolia.yaml'), 'utf8'));
  const images = demoImages(dir);
  const readModule = (path, lang) => {
    const id = basename(path, '.adoc');
    const text = readFileSync(path, 'utf8').replace(IMAGE, (_, name) => {
      const image = images[name];
      if (!image) throw new Error(`${path}: no image ${name} in images/`);
      return image.ref;
    });
    const module = parseModule(text, { id });
    if (module.meta.lang !== lang) {
      throw new Error(`${path}: lang is ${module.meta.lang}, not ${lang}`);
    }
    assertValid(path, validateModule(module, config));
    return module;
  };
  const languages = [config.languages.source, ...config.languages.targets];
  const modules = Object.fromEntries(
    languages.map((lang) => {
      const folder = join(dir, 'modules', lang);
      return [
        lang,
        Object.fromEntries(
          listFiles(folder, '.adoc').map((file) => [
            basename(file, '.adoc'),
            readModule(join(folder, file), lang),
          ]),
        ),
      ];
    }),
  );
  const historyDir = join(dir, 'history', 'modules', SOURCE_LANG);
  const earlier = Object.fromEntries(
    listFiles(historyDir, '.adoc').map((file) => [
      basename(file, '.adoc'),
      readModule(join(historyDir, file), SOURCE_LANG),
    ]),
  );
  const manuals = Object.fromEntries(
    listFiles(join(dir, 'manuals'), '.yaml').map((file) => {
      const id = basename(file, '.yaml');
      const manifest = parseManifest(
        readFileSync(join(dir, 'manuals', file), 'utf8'),
        { id },
      );
      assertValid(`manuals/${file}`, validateManifest(manifest, config));
      return [id, manifest];
    }),
  );
  const terms = Object.fromEntries(
    listFiles(join(dir, 'terms'), '.yaml').map((file) => {
      const id = basename(file, '.yaml');
      const term = parseTerm(readFileSync(join(dir, 'terms', file), 'utf8'), {
        id,
      });
      assertValid(`terms/${file}`, validateTerm(term, config));
      return [id, term];
    }),
  );
  const symbols = Object.fromEntries(
    listFiles(join(dir, 'symbols'), '.svg').map((file) => [
      basename(file, '.svg'),
      readFileSync(join(dir, 'symbols', file)),
    ]),
  );
  return { config, modules, earlier, manuals, terms, images, symbols };
}

/** `text` (one, or one per language) holding only the versions in `languages`. */
function onlyIn(text, languages) {
  if (typeof text === 'string') return text;
  const kept = Object.fromEntries(
    Object.entries(text).filter(([lang]) => languages.includes(lang)),
  );
  const langs = Object.keys(kept);
  return langs.length === 1 && langs[0] === SOURCE_LANG
    ? kept[SOURCE_LANG]
    : kept;
}

/** A manifest with its title and groups' titles only in `languages`. */
function manifestIn(manifest, languages) {
  const entries = (list) =>
    list.map((entry) =>
      'entries' in entry
        ? {
            ...entry,
            title: onlyIn(entry.title, languages),
            entries: entries(entry.entries),
          }
        : entry,
    );
  return {
    ...manifest,
    title: onlyIn(manifest.title, languages),
    entries: entries(manifest.entries),
  };
}

/**
 * The configuration and the manuals with their labels and titles in `languages`, each language
 * past the source one recorded as translated at `commits[lang]` (`markConfigCurrent`,
 * `markManifestCurrent`). Written before each commit of the history that brings a language.
 */
function textsIn({ config, manuals }, languages, commits) {
  let shown = mapLabels(config, (_, text) => onlyIn(text, languages));
  let manifests = Object.values(manuals).map((m) => manifestIn(m, languages));
  for (const lang of languages) {
    if (lang === SOURCE_LANG) continue;
    shown = markConfigCurrent(shown, lang, commits[lang]).config;
    manifests = manifests.map(
      (m) => markManifestCurrent(m, lang, SOURCE_LANG, commits[lang]).manifest,
    );
  }
  return { config: shown, manifests };
}

/**
 * `count` weekdays before `now`, at `hour` o'clock: commit dates that look like a real team's
 * (never a weekend), counted from the day the repository is made.
 */
export function weekdaysAgo(count, hour, now = new Date()) {
  const day = new Date(now);
  day.setHours(hour, 0, 0, 0);
  let left = count;
  while (left > 0) {
    day.setDate(day.getDate() - 1);
    const weekday = day.getDay();
    if (weekday !== 0 && weekday !== 6) left -= 1;
  }
  return day;
}

/**
 * Builds the demo content repository at `target` (bare; it must not exist or be empty).
 * Resolves to the commits of its history, oldest first.
 */
export function buildDemoRepo(target, { now = new Date() } = {}) {
  if (existsSync(target) && readdirSync(target).length > 0) {
    throw new Error(`${target} already exists and is not empty`);
  }
  const content = readDemoContent();
  const work = mkdtempSync(join(tmpdir(), 'openfolia-demo-'));
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
  const git = (args, extra = {}) =>
    execFileSync('git', ['-C', work, ...args], {
      encoding: 'utf8',
      env: { ...env, ...extra },
    }).trim();
  const write = (path, data) => {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), data);
  };
  const commit = (message, person, date) => {
    git(['add', '-A']);
    const who = {
      GIT_AUTHOR_NAME: person.name,
      GIT_AUTHOR_EMAIL: person.email,
      GIT_COMMITTER_NAME: person.name,
      GIT_COMMITTER_EMAIL: person.email,
      GIT_AUTHOR_DATE: date.toISOString(),
      GIT_COMMITTER_DATE: date.toISOString(),
    };
    git(['commit', '-q', '-m', message], who);
    return git(['rev-parse', 'HEAD']);
  };
  const { config, modules, earlier, manuals, terms, images, symbols } = content;
  const source = modules[SOURCE_LANG];
  const moduleFile = (module) =>
    `modules/${module.meta.lang}/${module.id}.adoc`;
  const recordFile = (lang, id) => `modules/${lang}/${id}.translation.yaml`;
  try {
    git(['init', '-q', '-b', 'main']);

    const writeTexts = (languages, commits) => {
      const texts = textsIn({ config, manuals }, languages, commits);
      write('openfolia.yaml', printConfig(texts.config));
      for (const manifest of texts.manifests) {
        write(`manuals/${manifest.id}.yaml`, printManifest(manifest));
      }
    };

    // 1. The English source, two modules in their earlier wording.
    writeTexts([SOURCE_LANG], {});
    for (const [id, term] of Object.entries(terms)) {
      write(`terms/${id}.yaml`, printTerm(term));
    }
    for (const [id, bytes] of Object.entries(symbols)) {
      write(`symbols/${id}.svg`, bytes);
    }
    for (const image of Object.values(images)) {
      write(`assets/${image.hash}`, image.bytes);
    }
    const firstSource = { ...source, ...earlier };
    for (const module of Object.values(firstSource)) {
      write(moduleFile(module), printModule(module));
    }
    const first = commit(
      'Add the owner documentation of the Fenna',
      DEMO_PEOPLE.author,
      weekdaysAgo(24, 10, now),
    );

    // 2. The first stage of the French translation, made from that source, with the labels and
    // titles.
    writeTexts([SOURCE_LANG, STAGED_LANG], { [STAGED_LANG]: first });
    for (const id of FRENCH_FIRST) {
      write(
        moduleFile(modules[STAGED_LANG][id]),
        printModule(modules[STAGED_LANG][id]),
      );
      write(
        recordFile(STAGED_LANG, id),
        printTranslationRecord(translationRecordOf(firstSource[id], first)),
      );
    }
    const partial = commit(
      'Add the French translation of the first owner modules',
      DEMO_PEOPLE.admin,
      weekdaysAgo(17, 14, now),
    );

    // 3. The earlier wording revised.
    for (const id of Object.keys(earlier)) {
      write(moduleFile(source[id]), printModule(source[id]));
    }
    const revised = commit(
      'Clarify starting and setting the clock',
      DEMO_PEOPLE.author,
      weekdaysAgo(12, 11, now),
    );

    // 4. The complete translation, made from the revised source, with the labels and titles.
    writeTexts([SOURCE_LANG, STAGED_LANG, COMPLETE_LANG], {
      [STAGED_LANG]: first,
      [COMPLETE_LANG]: revised,
    });
    for (const [id, module] of Object.entries(modules[COMPLETE_LANG])) {
      write(moduleFile(module), printModule(module));
      write(
        recordFile(COMPLETE_LANG, id),
        printTranslationRecord(translationRecordOf(source[id], revised)),
      );
    }
    const complete = commit(
      'Add the German translation',
      DEMO_PEOPLE.admin,
      weekdaysAgo(8, 15, now),
    );

    // 5. The rest of the French translation, and the revised modules translated again, all from
    // the revised source.
    for (const [id, module] of Object.entries(modules[STAGED_LANG])) {
      if (FRENCH_FIRST.includes(id) && !Object.hasOwn(earlier, id)) continue;
      write(moduleFile(module), printModule(module));
      write(
        recordFile(STAGED_LANG, id),
        printTranslationRecord(translationRecordOf(source[id], revised)),
      );
    }
    const rest = commit(
      'Complete the French translation',
      DEMO_PEOPLE.admin,
      weekdaysAgo(4, 10, now),
    );

    execFileSync('git', ['clone', '-q', '--bare', work, target], { env });
    execFileSync('git', ['-C', target, 'remote', 'remove', 'origin'], { env });
    return {
      dir: target,
      commits: { first, partial, revised, complete, rest },
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
