import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseEnvExample,
  renderSettings,
} from '../scripts/lib/env-example.mjs';

describe('parseEnvExample', () => {
  it('reads sections, settings and the comment above each', () => {
    const { sections, problems } = parseEnvExample(
      [
        '# Server',
        '',
        '# Where the content is.',
        '# A bare repository.',
        'CONTENT_DIR=/data',
        '# Both ports.',
        'PORT_A=',
        'PORT_B=',
        '',
        '# Tools',
        '# Read from the shell.',
        '',
        '# The base branch.',
        'BASE=',
      ].join('\n'),
    );
    expect(problems).toEqual([]);
    expect(
      sections.map((s) => [s.title, s.intro, s.settings.map((x) => x.name)]),
    ).toEqual([
      ['Server', '', ['CONTENT_DIR', 'PORT_A', 'PORT_B']],
      ['Tools', 'Read from the shell.', ['BASE']],
    ]);
    expect(sections[0]?.settings).toMatchObject([
      {
        example: '/data',
        description: 'Where the content is.\nA bare repository.',
      },
      { description: 'Both ports.' },
      { description: 'Both ports.' },
    ]);
  });

  it('refuses a setting without a comment, and one listed twice', () => {
    const { problems } = parseEnvExample(
      '# Section\n\nUNDESCRIBED=\n\n# A.\nTWICE=\n# B.\nTWICE=\n',
    );
    expect(problems).toEqual([
      '.env.example:3: UNDESCRIBED has no comment describing it',
      '.env.example:8: TWICE is listed twice (also line 6)',
    ]);
  });

  it('finds every setting of the repository’s .env.example described', () => {
    const text = readFileSync(
      join(import.meta.dirname, '../../../.env.example'),
      'utf8',
    );
    const parsed = parseEnvExample(text);
    expect(parsed.problems).toEqual([]);
    const names = parsed.sections.flatMap((s) => s.settings.map((x) => x.name));
    for (const name of text.matchAll(/^([A-Z][A-Z0-9_]*)=/gm))
      expect(names).toContain(name[1]);
    expect(names).toContain('DOCS_SITE_URL');
  });
});

describe('renderSettings', () => {
  it('gives each setting a heading and its description, a shared one by reference', () => {
    const body = renderSettings(
      parseEnvExample('# S\n\n# Both, <in> {braces}.\nA_B=\nC_D=x|y\n'),
    );
    expect(body).toContain('### A_B\n\nBoth, &lt;in&gt; &#123;braces&#125;.');
    expect(body).toContain('### C_D\n\nSee `A_B`.');
    expect(body).toContain('| [<code>C_<wbr />D</code>](#c_d) | `x\\|y` |');
  });
});
