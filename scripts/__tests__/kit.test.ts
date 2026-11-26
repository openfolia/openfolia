// The agent kit (scripts/kit/): its file list kept whole and free of this project's own names,
// its config file read the same way everywhere, and the installer's merges. The kit's commands
// themselves run in an installed copy in scripts/kit/smoke.mjs (`workflow:kit-smoke`).
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  KIT_DEFAULTS,
  guardConfig,
  parseKitConfig,
  readKitConfig,
} from '@/.claude/hooks/kit-config.mjs';
import {
  KIT_FILES,
  KIT_IGNORES,
  KIT_PACKAGE_SCRIPTS,
} from '@/scripts/kit/files.mjs';
import {
  install,
  mergedIgnores,
  mergedScripts,
  mergedSettings,
} from '@/scripts/kit/install.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'kit-test-'));
  dirs.push(dir);
  return dir;
}

/** Every file the kit copies, relative to the root. */
function kitFiles(): string[] {
  const walk = (rel: string): string[] =>
    statSync(path.join(ROOT, rel)).isDirectory()
      ? readdirSync(path.join(ROOT, rel)).flatMap((name) =>
          walk(path.join(rel, name)),
        )
      : [rel];
  return KIT_FILES.flatMap(walk);
}

describe('the kit`s files', () => {
  const files = kitFiles();

  it('are all here', () => {
    expect(files.length).toBeGreaterThan(KIT_FILES.length);
  });

  it('import only each other and node`s own modules', () => {
    const kit = new Set(files);
    const outside: string[] = [];
    for (const file of files.filter((f) => f.endsWith('.mjs'))) {
      const text = readFileSync(path.join(ROOT, file), 'utf8');
      for (const [, spec] of text.matchAll(
        /^\s*(?:import|export)\s[^'"]*?from\s+'([^']+)'/gm,
      )) {
        if (spec.startsWith('node:')) continue;
        const target = path.normalize(path.join(path.dirname(file), spec));
        if (!spec.startsWith('.') || !kit.has(target))
          outside.push(`${file} → ${spec}`);
      }
    }
    expect(outside).toEqual([]);
  });

  it('name nothing of this project: its name, its folders, its issue numbers', () => {
    const own =
      /openfolia|\bccms|backend\/|frontend\/|api:serve|api:setup|editor-e2e|pglite|typst|\(#\d+/i;
    const hits = files
      .filter((file) => !/\.(png|jpe?g|svg|ico)$/.test(file))
      .flatMap((file) =>
        readFileSync(path.join(ROOT, file), 'utf8')
          .split('\n')
          .map((line, i) => [file, i + 1, line] as const)
          .filter(([, , line]) => own.test(line))
          .map(([f, n, line]) => `${f}:${n}: ${line.trim()}`),
      );
    expect(hits).toEqual([]);
  });

  it('are what this repository runs: its package.json scripts and .gitignore', () => {
    const pkg = JSON.parse(
      readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
    );
    for (const [name, command] of Object.entries(KIT_PACKAGE_SCRIPTS))
      expect(pkg.scripts[name], name).toBe(command);
    const ignored = readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split(
      '\n',
    );
    for (const line of KIT_IGNORES) expect(ignored, line).toContain(line);
  });
});

describe('kit.config.json', () => {
  it('is this repository`s, valid, and the guard reads the same', () => {
    const config = readKitConfig(ROOT);
    expect(config.mainBranch).toBe('main');
    expect(config.ownPort).toBe(3100);
    expect(guardConfig(ROOT)).toEqual(config);
  });

  it('takes the defaults for what it leaves out, and a section`s keys one by one', () => {
    expect(parseKitConfig(null)).toEqual(KIT_DEFAULTS);
    const config = parseKitConfig(
      JSON.stringify({ mainBranch: 'trunk', slot: { setup: ['make', 'env'] } }),
    );
    expect(config.mainBranch).toBe('trunk');
    expect(config.slot).toEqual({
      ...KIT_DEFAULTS.slot,
      setup: ['make', 'env'],
    });
    // A list replaces the default one whole.
    const brief = parseKitConfig(JSON.stringify({ slot: { brief: ['- x'] } }));
    expect(brief.slot.brief).toEqual(['- x']);
  });

  it('refuses what it doesn`t know or can`t use, saying what', () => {
    for (const [text, problem] of [
      ['{', /not JSON/],
      ['[]', /not an object/],
      ['{"mainBrnach":"x"}', /unknown key\(s\) mainBrnach/],
      ['{"slot":{"setupp":[]}}', /unknown key\(s\) slot.setupp/],
      ['{"slot":"x"}', /slot must be an object/],
      ['{"mainBranch":"-x"}', /mainBranch must be a branch name/],
      ['{"mainBranch":"a b"}', /mainBranch must be a branch name/],
      ['{"mainBranch":".x"}', /mainBranch must be a branch name/],
      ['{"mainBranch":"a..b"}', /mainBranch must be a branch name/],
      ['{"mainBranch":"a/"}', /mainBranch must be a branch name/],
      ['{"mainBranch":"a.lock"}', /mainBranch must be a branch name/],
      ['{"ownPort":65500}', /ownPort/],
      ['{"handover":"x.md"}', /unknown key\(s\) handover/],
      ['{"check":[]}', /check/],
      ['{"check":[{"targets":["test"],"affectedEnv":"lower"}]}', /check/],
      ['{"slot":{"setup":"pnpm x"}}', /slot.setup/],
      ['{"slot":{"databasesScript":"/abs.mjs"}}', /slot.databasesScript/],
      ['{"slot":{"bucketScript":"../x.ts"}}', /slot.bucketScript/],
    ] as const) {
      expect(() => parseKitConfig(text), text).toThrow(problem);
    }
  });

  it('the guard falls back to the defaults on a file it can`t use; the scripts stop', () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, 'kit.config.json'), '{"mainBranch": 1}');
    expect(() => readKitConfig(dir)).toThrow(/mainBranch/);
    expect(guardConfig(dir)).toEqual(KIT_DEFAULTS);
    expect(readKitConfig(tempDir())).toEqual(KIT_DEFAULTS);
  });
});

describe('the installer', () => {
  const kitSettings = {
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'guard' }] },
      ],
    },
    permissions: { allow: ['Bash(a)', 'Bash(b)'] },
  };

  it('merges the guard`s hooks and the permissions once, keeping the repository`s own', () => {
    const own = {
      hooks: {
        PreToolUse: [
          { matcher: 'Edit', hooks: [{ type: 'command', command: 'mine' }] },
        ],
      },
      permissions: { allow: ['Bash(b)', 'Bash(c)'] },
      env: { A: '1' },
    };
    const once = mergedSettings(own, kitSettings);
    expect(once.hooks.PreToolUse.map((g) => g.hooks[0].command)).toEqual([
      'mine',
      'guard',
    ]);
    expect(once.permissions.allow).toEqual(['Bash(b)', 'Bash(c)', 'Bash(a)']);
    expect(once.env).toEqual({ A: '1' });
    expect(mergedSettings(once, kitSettings)).toEqual(once);
  });

  it('adds the scripts it lacks and names the ones it has otherwise', () => {
    const { scripts, clashes } = mergedScripts({ check: 'make check', x: 'y' });
    expect(scripts.check).toBe('make check');
    expect(scripts['merge:pr']).toBe(KIT_PACKAGE_SCRIPTS['merge:pr']);
    expect(scripts.x).toBe('y');
    expect(clashes).toEqual(['check']);
  });

  it('adds the .gitignore lines it lacks, once', () => {
    const text = mergedIgnores('node_modules/\n.review/\n');
    expect(text.startsWith('node_modules/\n.review/\n\n# Agent kit')).toBe(
      true,
    );
    expect(text.match(/\.review\//g)).toHaveLength(1);
    expect(mergedIgnores(text)).toBe(text);
  });

  it('installs into a repository, keeping its config, and again changes nothing of its own', () => {
    const repo = tempDir();
    writeFileSync(path.join(repo, 'package.json'), '{"name":"x"}\n');
    install(repo, ROOT);
    for (const file of kitFiles())
      expect(readFileSync(path.join(repo, file), 'utf8'), file).toBe(
        readFileSync(path.join(ROOT, file), 'utf8'),
      );
    expect(
      JSON.parse(readFileSync(path.join(repo, 'kit.config.json'), 'utf8')),
    ).toEqual(KIT_DEFAULTS);
    writeFileSync(
      path.join(repo, 'kit.config.json'),
      '{"mainBranch":"trunk"}\n',
    );
    mkdirSync(path.join(repo, 'docs'), { recursive: true });
    const before = ['package.json', '.gitignore', '.claude/settings.json'].map(
      (f) => readFileSync(path.join(repo, f), 'utf8'),
    );
    install(repo, ROOT);
    expect(readFileSync(path.join(repo, 'kit.config.json'), 'utf8')).toBe(
      '{"mainBranch":"trunk"}\n',
    );
    expect(
      ['package.json', '.gitignore', '.claude/settings.json'].map((f) =>
        readFileSync(path.join(repo, f), 'utf8'),
      ),
    ).toEqual(before);
  });

  it('refuses a folder without a package.json', () => {
    expect(() => install(tempDir(), ROOT)).toThrow(/no package.json/);
  });
});
