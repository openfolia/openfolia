// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  inlineParts,
  markdownText,
  parseSummary,
  summaryMarkdown,
  summaryPaths,
  summaryText,
} from '@/scripts/release-summary.mjs';

const where = { repoUrl: 'https://github.com/acme/app', version: 'v0.1.0' };

describe('a release summary, read as text', () => {
  it('reads paragraphs and bullets, a bullet going on over an indented line', () => {
    const blocks = parseSummary(
      'First line\nsame paragraph.\n\n- one\n- two\n  goes on\n\nAfter.\n',
    );
    expect(blocks).toEqual([
      { paragraph: [{ text: 'First line same paragraph.' }] },
      { list: [[{ text: 'one' }], [{ text: 'two goes on' }]] },
      { paragraph: [{ text: 'After.' }] },
    ]);
    expect(parseSummary('')).toEqual([]);
    expect(parseSummary('\n\n  \n')).toEqual([]);
  });

  it('pairs backticks into code, and leaves an unpaired one as text', () => {
    expect(inlineParts('run `pnpm demo:start` once')).toEqual([
      { text: 'run ' },
      { code: 'pnpm demo:start' },
      { text: ' once' },
    ]);
    expect(inlineParts('a ` alone')).toEqual([{ text: 'a ` alone' }]);
  });

  it('links a bare https address and a path of the repository, nothing else', () => {
    expect(
      inlineParts(
        'See https://docs.example.org/guide (or deploy/README.md#upgrades, CONTRIBUTING.md).',
      ),
    ).toEqual([
      { text: 'See ' },
      {
        url: 'https://docs.example.org/guide',
        text: 'https://docs.example.org/guide',
      },
      { text: ' (or ' },
      {
        path: 'deploy/README.md',
        anchor: '#upgrades',
        text: 'deploy/README.md#upgrades',
      },
      { text: ', ' },
      { path: 'CONTRIBUTING.md', anchor: null, text: 'CONTRIBUTING.md' },
      { text: ').' },
    ]);
    for (const text of [
      'javascript:alert(1)',
      'http://example.org',
      'data:text/html,x',
      '[x](javascript:alert(1))',
      '<a href="javascript:x">x</a>',
      'https://user:pw@example.org',
      '../secrets.txt',
      '/etc/passwd',
      '.github/release.yml',
      'PDF/UA-1, EN/DE, and/or, Node.js, v0.0.1, e.g., openfolia.yaml',
      '`deploy/README.md` in code',
    ])
      expect(
        inlineParts(text).some((p) => 'url' in p || 'path' in p),
        text,
      ).toBe(false);
  });

  it('cuts an address at a closing bracket it does not open, and at the sentence', () => {
    expect(
      inlineParts('(https://en.wikipedia.org/wiki/A_(b)).')[1],
    ).toMatchObject({ url: 'https://en.wikipedia.org/wiki/A_(b)' });
    expect(inlineParts('at https://example.org.')[1]).toMatchObject({
      url: 'https://example.org/',
      text: 'https://example.org',
    });
  });

  it('cuts a long run of punctuation after an address in linear time', () => {
    const start = performance.now();
    inlineParts(`https://a.com/${'.)'.repeat(100000)}`);
    inlineParts(`https://a.com/${')'.repeat(200000)}`);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it('cuts an address at a closing square or curly bracket it does not open', () => {
    expect(inlineParts('[see https://example.org/a]')[1]).toMatchObject({
      url: 'https://example.org/a',
    });
  });

  it('keeps an empty pair of backticks and an empty bullet out of the parts', () => {
    expect(inlineParts('a `` b')).toEqual([{ text: 'a `` b' }]);
    expect(parseSummary('- ')).toEqual([]);
    expect(parseSummary('- \n  more')).toEqual([
      { list: [[{ text: 'more' }]] },
    ]);
    expect(parseSummary('- one\n- \n- two')).toEqual([
      { list: [[{ text: 'one' }], [{ text: 'two' }]] },
    ]);
  });

  it('lists the paths it links to', () => {
    expect(
      summaryPaths(
        parseSummary('deploy/README.md\n\n- CONTRIBUTING.md, deploy/README.md'),
      ),
    ).toEqual(['deploy/README.md', 'CONTRIBUTING.md']);
  });
});

describe('a release summary in Markdown', () => {
  it('builds its links, its code as code', () => {
    expect(
      summaryMarkdown(
        parseSummary(
          'Read deploy/README.md and https://example.org/a_(b).\n\n- `pnpm check` first',
        ),
        where,
      ),
    ).toBe(
      'Read [deploy/README.md](https://github.com/acme/app/blob/v0.1.0/deploy/README.md) and [https://example.org/a\\_(b)](https://example.org/a_%28b%29).\n\n- `pnpm check` first',
    );
  });

  it('keeps markup as text: no HTML, emphasis, link, heading, list or mention', () => {
    const markdown = summaryMarkdown(
      parseSummary(
        [
          '# Heading <script>x</script> <!-- release v9.9.9 -->',
          '',
          '1. not a list, *not emphasis*, [x](javascript:alert(1)), ![i](https://x/i.png)',
          '',
          '- http://plain.example and www.example.org stay text, @someone is no mention',
        ].join('\n'),
      ),
      where,
    );
    expect(markdown).not.toMatch(/<script|<!--|^#|^1\./m);
    expect(markdown).toContain('\\# Heading &lt;script&gt;');
    expect(markdown).toContain('1\\. not a list, \\*not emphasis\\*');
    expect(markdown).toContain('\\[x\\](javascript:alert(1))');
    expect(markdown).toContain('!\\[i\\]([https://x/i.png](https://x/i.png))');
    expect(markdown).toContain('http\\://plain.example and www\\.example.org');
    expect(markdown).toContain(' someone is no mention');
    expect(markdownText('mail a@b.org')).toBe('mail a\\@b.org');
    // After an unpaired backtick or an underscore, too.
    expect(markdownText('a `@user b')).toBe('a \\`user b');
    expect(markdownText('see _www.x.com and _WWW.x.com')).toBe(
      'see \\_www\\.x.com and \\_WWW\\.x.com',
    );
    expect(markdownText('see #12 and o/r#3')).toBe('see \\#12 and o/r\\#3');
  });

  it('reads as plain text for the feed', () => {
    expect(
      summaryText(parseSummary('One `code` deploy/README.md.\n\n- a\n- b')),
    ).toBe('One code deploy/README.md.\n\n- a\n- b');
  });
});

describe('the summaries in release-notes/', () => {
  const dir = join(import.meta.dirname, '../../release-notes');
  const files = existsSync(dir) ? readdirSync(dir) : [];

  it('are named by a version, English beside each German one', () => {
    for (const name of files) {
      expect(name).toMatch(/^v\d+\.\d+\.\d+(\.de)?\.md$/);
      if (name.endsWith('.de.md'))
        expect(files).toContain(name.replace(/\.de\.md$/, '.md'));
    }
  });

  it('link only to files the repository holds', () => {
    for (const name of files)
      for (const path of summaryPaths(
        parseSummary(readFileSync(join(dir, name), 'utf8')),
      ))
        expect(existsSync(join(dir, '..', path)), `${name}: ${path}`).toBe(
          true,
        );
  });
});
