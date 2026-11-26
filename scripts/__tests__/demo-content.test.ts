import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compareConfigWithRecord,
  compareManifestWithRecord,
  compareWithRecord,
  type Manifest,
  type Module,
  parseConfig,
  parseManifest,
  parseModule,
  parseTerm,
  parseTranslationRecord,
  resolveManual,
  translatableUnits,
  validateManifest,
  validateModule,
  validateTerm,
} from '@openfolia/content-model';
import { compilePdf, renderTypst } from '@openfolia/render-typst';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildDemoRepo,
  COMPLETE_LANG,
  FRENCH_FIRST,
  STAGED_LANG,
  readDemoContent,
  SOURCE_LANG,
  weekdaysAgo,
} from '@/scripts/demo/content.mjs';
import { DEMO_PEOPLE, demoSeed } from '@/scripts/demo/people.mjs';

/** The demo content (#441), built into a bare repository once and read back from Git. */
let dir: string;
let repo: string;
let commits: Record<string, string>;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
const show = (path: string, ref = 'main') => git('show', `${ref}:${path}`);
/** The files at `main`, listed once. */
let files: Set<string>;
const exists = (path: string) => files.has(path);
const moduleAt = (lang: string, id: string) =>
  exists(`modules/${lang}/${id}.adoc`)
    ? parseModule(show(`modules/${lang}/${id}.adoc`), { id })
    : undefined;
const unitIds = (module: Module) =>
  translatableUnits(module).map((unit) => unit.blockId);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'openfolia-demo-test-'));
  repo = join(dir, 'content.git');
  ({ commits } = buildDemoRepo(repo, {
    // A Monday: the history counts back over weekends.
    now: new Date('2026-11-23T09:00:00'),
  }));
  files = new Set(git('ls-tree', '-r', '--name-only', 'main').split('\n'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('the demo content', () => {
  it('is about thirty modules, three manuals and an update guide, terms, images and snippets', () => {
    const content = readDemoContent();
    const source = Object.values(content.modules[SOURCE_LANG]);
    expect(source.length).toBeGreaterThanOrEqual(30);
    expect(Object.keys(content.manuals).sort()).toEqual([
      'owners',
      'quick-start',
      'service',
      // An update guide (#906): the portal's and the editor's real data.
      'software-update',
    ]);
    expect(Object.keys(content.terms).length).toBeGreaterThanOrEqual(5);
    expect(Object.keys(content.images).length).toBeGreaterThanOrEqual(3);
    const types = new Set(source.map((m) => m.meta.type));
    expect([...types].sort()).toEqual([
      'concept',
      'procedure',
      'reference',
      'safety',
      'snippet',
    ]);
    const blocks = JSON.stringify(source.map((m) => m.blocks));
    for (const type of ['variant', 'moduleRef', 'safety', 'table', 'image']) {
      expect(blocks).toContain(`"type":"${type}"`);
    }
  });

  it('has an owner update guide, with the technician steps in the service manual (#926)', () => {
    const { manuals } = readDemoContent();
    const guide = manuals['software-update'] as Manifest;
    const service = manuals['service'] as Manifest;
    expect(guide.audience).toBe('owner');
    const steps = guide.guide?.steps ?? [];
    for (const id of ['update-diagnostic-tester', 'update-calibrate-camera']) {
      expect(steps.map((s) => s.module)).not.toContain(id);
      expect(service.entries.map((e) => e.module)).toContain(id);
    }
    expect(steps.some((s) => s.level)).toBe(false);
    // Every version after the first (the oldest, which has nothing to install) still has a step.
    for (const v of (guide.guide?.versions ?? []).slice(1)) {
      expect(steps.map((s) => s.version)).toContain(v);
    }
  });

  it('is in English and German in full, with the same blocks in each', () => {
    const { modules } = readDemoContent();
    const source = modules[SOURCE_LANG];
    const complete = modules[COMPLETE_LANG];
    expect(Object.keys(complete).sort()).toEqual(Object.keys(source).sort());
    for (const [id, module] of Object.entries(source)) {
      expect([id, unitIds(complete[id])]).toEqual([id, unitIds(module)]);
    }
  });

  it('is in French in full too, with the same blocks, its first stage a part of it', () => {
    const { modules } = readDemoContent();
    const source = modules[SOURCE_LANG];
    const french = modules[STAGED_LANG];
    expect(Object.keys(french).sort()).toEqual(Object.keys(source).sort());
    for (const [id, module] of Object.entries(source)) {
      expect([id, unitIds(french[id])]).toEqual([id, unitIds(module)]);
    }
    expect(FRENCH_FIRST.length).toBeGreaterThan(5);
    expect(FRENCH_FIRST.length).toBeLessThan(Object.keys(source).length / 2);
    for (const id of FRENCH_FIRST) expect(french[id]).toBeDefined();
  });

  it('reads back from Git, every file valid', () => {
    const config = parseConfig(show('openfolia.yaml'));
    expect(config.languages).toEqual({
      source: SOURCE_LANG,
      targets: [COMPLETE_LANG, STAGED_LANG],
    });
    for (const id of ['owners', 'service', 'quick-start']) {
      parseManifest(show(`manuals/${id}.yaml`), { id });
    }
    const terms = [...files].filter((f) => f.startsWith('terms/'));
    expect(terms.length).toBeGreaterThan(0);
    for (const file of terms) parseTerm(show(file), { id: file.slice(6, -5) });
    // Every image a module names is in the repository.
    const named = git(
      'grep',
      '-h',
      '-o',
      '-E',
      'sha256:[0-9a-f]{64}',
      'main',
      '--',
      '*.adoc',
    ).split('\n');
    expect(named.length).toBeGreaterThan(5);
    for (const ref of named) {
      expect([ref, exists(`assets/${ref.slice(7)}`)]).toEqual([ref, true]);
    }
  });

  it('has a history on weekdays, by the demo people, with real translation states', () => {
    const log = git('log', '--format=%H %an %ad', '--date=iso', 'main')
      .split('\n')
      .reverse();
    expect(log.map((line) => line.split(' ')[0])).toEqual([
      commits['first'],
      commits['partial'],
      commits['revised'],
      commits['complete'],
      commits['rest'],
    ]);
    const names = Object.values(DEMO_PEOPLE).map((p) => p.name);
    for (const line of log) {
      expect(names.some((name) => line.includes(name))).toBe(true);
      const day = new Date(line.split(' ').slice(-3).join(' ')).getDay();
      expect([0, 6]).not.toContain(day);
    }
    const states = (lang: string, id: string) => {
      const source = moduleAt(SOURCE_LANG, id) as Module;
      const record = parseTranslationRecord(
        show(`modules/${lang}/${id}.translation.yaml`),
      );
      return new Set(compareWithRecord(source, record).map((b) => b.state));
    };
    // German: up to date everywhere.
    for (const id of [
      'starting-and-stopping',
      'tyre-pressures',
      'setting-the-clock',
    ]) {
      expect([id, ...states(COMPLETE_LANG, id)]).toEqual([id, 'up-to-date']);
    }
    // French: its first stage was made before two modules were revised, so those were outdated
    // until the second stage; it did not have the tyre pressures yet.
    const before = (id: string) =>
      new Set(
        compareWithRecord(
          parseModule(
            show(`modules/${SOURCE_LANG}/${id}.adoc`, commits['complete']),
            { id },
          ),
          parseTranslationRecord(
            show(
              `modules/${STAGED_LANG}/${id}.translation.yaml`,
              commits['complete'],
            ),
          ),
        ).map((b) => b.state),
      );
    expect(before('starting-and-stopping').has('outdated')).toBe(true);
    expect(before('setting-the-clock').has('outdated')).toBe(true);
    expect(
      git(
        'ls-tree',
        '--name-only',
        commits['complete'],
        `modules/${STAGED_LANG}/`,
      ),
    ).not.toContain('tyre-pressures.adoc');
    // The labels and the manual titles (#731): in every language, translated and recorded.
    const config = parseConfig(show('openfolia.yaml'));
    const owners = parseManifest(show('manuals/owners.yaml'), { id: 'owners' });
    for (const lang of [COMPLETE_LANG, STAGED_LANG]) {
      expect(
        new Set(compareConfigWithRecord(config, lang).map((u) => u.state)),
      ).toEqual(new Set(['up-to-date']));
      expect(
        compareManifestWithRecord(owners, lang, SOURCE_LANG).map(
          (u) => u.state,
        ),
      ).toEqual(['up-to-date']);
    }
    expect(config.audiences[0]?.label).toEqual({
      en: 'Owners',
      de: 'Fahrzeughalter',
      fr: 'Propriétaires',
    });
    // The first commit had the English ones only.
    const firstConfig = parseConfig(show('openfolia.yaml', commits['first']));
    expect(firstConfig.audiences[0]?.label).toBe('Owners');
    expect(
      parseManifest(show('manuals/owners.yaml', commits['first']), {
        id: 'owners',
      }).title,
    ).toBe("Owner's manual");
  });

  it('counts commit dates back over weekends', () => {
    const friday = new Date('2026-11-20T09:00:00');
    expect(weekdaysAgo(1, 10, friday).getDay()).toBe(4);
    const monday = new Date('2026-11-23T09:00:00');
    expect(weekdaysAgo(1, 10, monday).getDay()).toBe(5);
    expect(weekdaysAgo(5, 10, monday).getDate()).toBe(16);
  });

  it('seeds an author, a reviewer and an admin holding every permission', () => {
    const seed = demoSeed(['content.read', 'release.publish']);
    expect(seed.users.map((u) => u.id)).toEqual([
      DEMO_PEOPLE.author.id,
      DEMO_PEOPLE.reviewer.id,
      DEMO_PEOPLE.admin.id,
    ]);
    expect(seed.roles.find((r) => r.id === 'admin')?.permissions).toEqual([
      'content.read',
      'release.publish',
    ]);
  });
});

describe('the release checks on the demo', () => {
  // A release cut on the demo shows no warning (the Releases film, #446): every module is in
  // every language, every translation current with its source, and no file has a warning.
  it('find no translation missing or outdated, and no warning in any file', () => {
    const { config, modules, manuals, terms } = readDemoContent();
    for (const lang of config.languages.targets) {
      for (const id of Object.keys(modules[SOURCE_LANG])) {
        expect([lang, id, exists(`modules/${lang}/${id}.adoc`)]).toEqual([
          lang,
          id,
          true,
        ]);
        const record = parseTranslationRecord(
          show(`modules/${lang}/${id}.translation.yaml`),
        );
        const states = compareWithRecord(
          moduleAt(SOURCE_LANG, id) as Module,
          record,
        ).map((b) => b.state);
        expect([lang, id, [...new Set(states)]]).toEqual([
          lang,
          id,
          ['up-to-date'],
        ]);
      }
    }
    const warnings = [
      ...Object.values(modules).flatMap((byId) =>
        Object.values(byId).flatMap((m) => validateModule(m, config)),
      ),
      ...Object.values(manuals).flatMap((m) => validateManifest(m, config)),
      ...Object.values(terms).flatMap((t) => validateTerm(t, config)),
    ].filter((issue) => issue.severity !== 'info');
    expect(warnings).toEqual([]);
  }, 60_000);
});

describe('one demo module through PDF output', () => {
  // The module the acceptance test follows: a procedure with two snippets, an image and term
  // links.
  const MODULE = 'changing-a-wheel';
  const TITLES: Record<string, string> = {
    en: 'Changing a wheel',
    de: 'Rad wechseln',
    fr: 'Changer une roue',
  };
  const MANUAL_TITLES: Record<string, string> = {
    en: 'Quick start guide',
    de: 'Kurzanleitung',
    fr: 'Guide de démarrage rapide',
  };

  it.each(Object.keys(TITLES))(
    'renders it as a PDF in %s',
    (lang) => {
      const config = parseConfig(show('openfolia.yaml'));
      const manifest: Manifest = {
        ...parseManifest(show('manuals/quick-start.yaml'), {
          id: 'quick-start',
        }),
        entries: [{ module: MODULE }],
      };
      const { manual, issues } = resolveManual({
        manifest,
        variant: { body: 'estate', drive: 'electric', market: 'eu' },
        lang,
        config,
        loadModule: (id, l) => moduleAt(l, id),
        loadTerm: (id) =>
          exists(`terms/${id}.yaml`)
            ? parseTerm(show(`terms/${id}.yaml`), { id })
            : undefined,
      });
      // In its own language, with nothing missing: not even the snippet it includes.
      expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
      expect(issues.map((i) => i.code)).not.toContain('missing-translation');
      const rendered = renderTypst(manual, {
        symbolPath: (id) => `symbols/${id}.svg`,
      });
      expect(rendered.source).toContain(JSON.stringify(TITLES[lang]));
      // The manual's own title in the manual's language (#731).
      expect(manual.title).toBe(MANUAL_TITLES[lang]);
      expect(rendered.source).toContain(JSON.stringify(MANUAL_TITLES[lang]));
      const files: Record<string, Uint8Array> = {};
      for (const asset of rendered.assets) {
        const hash = asset.replace(/^sha256:/, '');
        files[`assets/${hash}`] = execFileSync('git', [
          '-C',
          repo,
          'show',
          `main:assets/${hash}`,
        ]);
      }
      for (const path of rendered.symbols) {
        files[path] = execFileSync('git', ['-C', repo, 'show', `main:${path}`]);
      }
      expect(rendered.assets.length).toBe(1);
      const pdf = compilePdf({ source: rendered.source, files });
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
      expect(pdf.length).toBeGreaterThan(10_000);
    },
    60_000,
  );
});
