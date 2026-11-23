import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  familyName,
  findViolations,
  isAllowed,
  packagesOf,
  parseLicence,
  renderNotice,
} from '@/scripts/licences-plan.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const policy = JSON.parse(
  readFileSync(path.join(ROOT, 'scripts/licence-policy.json'), 'utf8'),
);
const allowed = new Set<string>(policy.allowed);
const exceptions = new Set<string>(policy.allowedExceptions);

const entry = (name: string, version = '1.0.0', extra = {}) => ({
  name,
  versions: [version],
  paths: [`/store/${name}`],
  homepage: `https://example.org/${name}`,
  ...extra,
});

describe('parseLicence', () => {
  it('reads OR, AND and WITH with their precedence', () => {
    expect(parseLicence('MIT OR Apache-2.0 AND BSD-3-Clause')).toEqual({
      or: [
        { id: 'MIT' },
        { and: [{ id: 'Apache-2.0' }, { id: 'BSD-3-Clause' }] },
      ],
    });
    expect(
      parseLicence('(GPL-2.0-or-later WITH Classpath-exception-2.0)'),
    ).toEqual({ id: 'GPL-2.0-or-later', exception: 'Classpath-exception-2.0' });
  });

  it('refuses free text and broken expressions', () => {
    for (const text of [
      'SEE LICENSE IN LICENSE.md',
      'Apache 2.0',
      '(MIT',
      'MIT OR',
      'AND MIT',
      '',
    ]) {
      expect(() => parseLicence(text), text).toThrow(/SPDX/);
    }
  });
});

describe('isAllowed', () => {
  it('allows the permissive and the GPL-3.0-compatible licences', () => {
    for (const licence of [
      'MIT',
      'Apache-2.0',
      'LGPL-3.0-or-later',
      'MPL-2.0',
      '(MIT OR CC0-1.0)',
      'Apache-2.0 AND MIT',
      'GPL-2.0-or-later WITH Classpath-exception-2.0',
    ]) {
      expect(isAllowed(licence, allowed, exceptions), licence).toBe(true);
    }
  });

  it('refuses licences that cannot ship with AGPL-3.0-only, unknown ones and free text', () => {
    for (const licence of [
      'GPL-2.0-only',
      'SSPL-1.0',
      'BUSL-1.1',
      'CC-BY-NC-4.0',
      'UNLICENSED',
      'Unknown',
      'MIT AND GPL-2.0-only',
      'SEE LICENSE IN LICENSE',
      // A WITH can take rights away: only the reviewed exceptions pass.
      'Apache-2.0 WITH Commons-Clause',
      'MIT WITH NonCommercial',
      'GPL-2.0-only WITH Classpath-exception-2.0',
    ]) {
      expect(isAllowed(licence, allowed, exceptions), licence).toBe(false);
    }
  });

  it('needs only one allowed side of an OR', () => {
    expect(isAllowed('(GPL-2.0-only OR MIT)', allowed)).toBe(true);
  });
});

describe('packagesOf', () => {
  it('names a platform build by its package, so the notice reads the same everywhere', () => {
    expect(familyName('@img/sharp-libvips-darwin-arm64')).toBe(
      '@img/sharp-libvips',
    );
    expect(familyName('@resvg/resvg-js-linux-x64-gnu')).toBe('@resvg/resvg-js');
    expect(familyName('left-pad')).toBe('left-pad');

    const rows = packagesOf(
      {
        'MPL-2.0': [
          entry('@resvg/resvg-js', '2.6.2'),
          entry('@resvg/resvg-js-darwin-arm64', '2.6.2', {
            homepage: 'https://example.org/platform',
          }),
        ],
        MIT: [entry('b', '2.0.0'), entry('a', '10.0.0'), entry('a', '9.0.0')],
      },
      (dir: string) => dir.endsWith('darwin-arm64'),
    );
    expect(rows).toEqual([
      {
        name: '@resvg/resvg-js',
        licence: 'MPL-2.0',
        versions: ['2.6.2'],
        homepage: 'https://example.org/@resvg/resvg-js',
      },
      {
        name: 'a',
        licence: 'MIT',
        versions: ['9.0.0', '10.0.0'],
        homepage: 'https://example.org/a',
      },
      {
        name: 'b',
        licence: 'MIT',
        versions: ['2.0.0'],
        homepage: 'https://example.org/b',
      },
    ]);
  });
});

describe('findViolations', () => {
  const rows = packagesOf({
    MIT: [entry('fine')],
    'GPL-2.0-only': [entry('copyleft')],
    Unknown: [entry('mystery')],
  });

  it('lists every dependency whose licence is not allowed', () => {
    expect(findViolations(rows, policy).map((row) => row.name)).toEqual([
      'copyleft',
      'mystery',
    ]);
  });

  it('lets a reviewed exception through, for that licence only', () => {
    const excepted = {
      ...policy,
      exceptions: [
        { package: 'mystery', licence: 'Unknown', reason: 'reviewed: MIT' },
        { package: 'copyleft', licence: 'GPL-3.0-only', reason: 'old licence' },
      ],
    };
    expect(findViolations(rows, excepted).map((row) => row.name)).toEqual([
      'copyleft',
    ]);
  });
});

describe('renderNotice', () => {
  it('lists the fonts and the packages, escaping table cells', () => {
    const notice = renderNotice(
      [
        {
          name: 'pipe|name',
          licence: 'MIT',
          versions: ['1.0.0'],
          homepage: null,
        },
      ],
      { fonts: [{ name: 'Sans', licence: 'OFL-1.1', file: 'fonts/LICENSE' }] },
    );
    expect(notice).toContain('The project authors');
    expect(notice).toContain('| Sans | OFL-1.1 | `fonts/LICENSE` |');
    expect(notice).toContain('| pipe\\|name | 1.0.0 | MIT |  |');
    expect(notice.endsWith('\n')).toBe(true);
  });
});

describe('pnpm licences (the command pnpm check runs)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'licences-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (mode: string, report: object) => {
    const reportFile = path.join(dir, 'report.json');
    writeFileSync(reportFile, JSON.stringify(report));
    return spawnSync(
      process.execPath,
      [
        path.join(ROOT, 'scripts/licences.mjs'),
        mode,
        '--report',
        reportFile,
        '--notice',
        path.join(dir, 'NOTICE.md'),
      ],
      { encoding: 'utf8' },
    );
  };

  it('fails on a disallowed licence, naming the package', () => {
    const result = run('check', {
      MIT: [entry('fine')],
      'SSPL-1.0': [entry('server-side', '3.1.0')],
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('server-side@3.1.0: SSPL-1.0');
    expect(result.stderr).not.toContain('fine@');
  });

  it('fails when the notice is out of date, and passes once it is written', () => {
    const report = { MIT: [entry('fine')] };
    const stale = run('check', report);
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain('out of date');

    expect(run('write', report).status).toBe(0);
    expect(readFileSync(path.join(dir, 'NOTICE.md'), 'utf8')).toContain(
      '| fine | 1.0.0 | MIT |',
    );
    expect(run('check', report).status).toBe(0);
  });

  it('writes no notice while a licence is not allowed', () => {
    const result = run('write', { 'GPL-2.0-only': [entry('copyleft')] });
    expect(result.status).toBe(1);
    expect(() => readFileSync(path.join(dir, 'NOTICE.md'))).toThrow();
  });
});
