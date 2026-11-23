import {
  parseConfig,
  parseManifest,
  parseModule,
  parseTerm,
  parseTranslationRecord,
  validateManifest,
  validateModule,
} from '@openfolia/content-model';
import { describe, expect, it } from 'vitest';
import { ScaleContent } from '@/scripts/perf/content.mjs';
import { PROFILES } from '@/scripts/perf/profiles.mjs';
import { Random } from '@/scripts/perf/random.mjs';

/** A profile small enough for a unit test; the media are stand-ins (no blob store here). */
const tiny = {
  ...PROFILES.small,
  seed: 'unit-test',
  modules: 60,
  snippets: 6,
  manuals: 5,
  bigManualModules: 30,
  translated: { de: 0.6, fr: 0.3 },
  terms: 20,
};
const file = (i: number, contentType: string, name: string) => ({
  sha256: i.toString(16).padStart(64, '0'),
  size: 1000 + i,
  contentType,
  fileName: name,
});
const media = {
  images: Array.from({ length: 20 }, (_, i) =>
    file(i + 1, 'image/png', `p${i}.png`),
  ),
  pdfs: [file(100, 'application/pdf', 'sheet.pdf')],
  attachments: [file(101, 'text/csv', 'values.csv')],
};

type Change = { path: string; content: string };

function build() {
  const content = new ScaleContent(tiny, media);
  const first = content.initialFiles() as Change[];
  const translations = [
    ...content.initialTranslations(() => 'a'.repeat(40)),
  ].flatMap((c: { changes: Change[] }) => c.changes);
  const history = Array.from({ length: 200 }, (_, i) =>
    content.historyCommit(i, 'b'.repeat(40)),
  );
  return { content, first, translations, history };
}

describe('the scale generator', () => {
  it('makes the same files from the same seed', () => {
    const a = build();
    const b = build();
    expect(b.first).toEqual(a.first);
    expect(b.translations).toEqual(a.translations);
    expect(b.history).toEqual(a.history);
  });

  it('writes only files the content model reads back without an error', () => {
    const { first, translations, history } = build();
    const config = parseConfig(
      first.find((f) => f.path === 'openfolia.yaml')?.content ?? '',
    );
    const files = new Map<string, string>();
    for (const change of [
      ...first,
      ...translations,
      ...history.flatMap((c: { changes: Change[] }) => c.changes),
    ]) {
      files.set(change.path, change.content);
    }
    let modules = 0;
    for (const [path, text] of files) {
      const module = /^modules\/([a-z]+)\/([a-z0-9-]+)\.adoc$/.exec(path);
      if (module) {
        const parsed = parseModule(text, { id: module[2] ?? '' });
        expect(parsed.id, path).toBe(module[2]);
        expect(parsed.meta.lang, path).toBe(module[1]);
        expect(
          validateModule(parsed, config).filter((i) => i.severity === 'error'),
          path,
        ).toEqual([]);
        modules += 1;
      } else if (path.endsWith('.translation.yaml')) {
        expect(() => parseTranslationRecord(text), path).not.toThrow();
      } else if (path.startsWith('manuals/')) {
        const manual = parseManifest(text, { id: path.slice(8, -5) });
        expect(
          validateManifest(manual, config).filter(
            (i) => i.severity === 'error',
          ),
          path,
        ).toEqual([]);
      } else if (path.startsWith('terms/')) {
        expect(
          () => parseTerm(text, { id: path.slice(6, -5) }),
          path,
        ).not.toThrow();
      }
    }
    expect(modules).toBeGreaterThan(tiny.modules);
  });

  it('puts the big manual first, with its modules, and every manual names modules that exist', () => {
    // Before any history: the history adds modules to manuals.
    const content = new ScaleContent(tiny, media);
    const names = (
      entries: { module?: string; entries?: unknown[] }[],
    ): string[] =>
      entries.flatMap((e) =>
        e.module ? [e.module] : names((e.entries ?? []) as never),
      );
    const big = content.manuals.get(content.bigManualId);
    expect(names(big.entries)).toHaveLength(tiny.bigManualModules);
    for (const manual of content.manuals.values()) {
      for (const id of names(manual.entries))
        expect(content.modules.has(id), id).toBe(true);
    }
  });
});

describe('Random', () => {
  it('repeats its sequence for a seed and forks independently', () => {
    const a = new Random('x');
    const b = new Random('x');
    expect(Array.from({ length: 5 }, () => a.next())).toEqual(
      Array.from({ length: 5 }, () => b.next()),
    );
    expect(new Random('x').fork('one').next()).not.toBe(
      new Random('x').fork('two').next(),
    );
  });
});
