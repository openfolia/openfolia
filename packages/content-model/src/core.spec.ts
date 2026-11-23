import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as core from './core.js';
import * as full from './index.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The modules a file loads at run time: its imports and re-exports once TypeScript has erased
 * the type-only ones, as a bundler sees them.
 */
function runtimeImports(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    fileName: file,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const out = ts.createSourceFile('out.js', outputText, ts.ScriptTarget.ES2022);
  const specifiers: string[] = [];
  for (const statement of out.statements) {
    if (
      (ts.isImportDeclaration(statement) ||
        ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      specifiers.push(statement.moduleSpecifier.text);
    }
  }
  return specifiers;
}

/** Every module `entry` loads at run time, followed through the package's own files. */
function runtimeGraph(entry: string): { files: string[]; packages: string[] } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    for (const specifier of runtimeImports(file)) {
      if (specifier.startsWith('.')) {
        visit(resolve(dirname(file), specifier.replace(/\.js$/, '.ts')));
      } else {
        packages.add(specifier);
      }
    }
  };
  visit(entry);
  return { files: [...files], packages: [...packages] };
}

describe('@openfolia/content-model/core', () => {
  it('loads neither zod nor yaml, nor any other package', () => {
    const { packages } = runtimeGraph(resolve(here, 'core.ts'));
    expect(packages).toEqual([]);
  });

  it('follows the files it reaches (the check above sees the whole graph)', () => {
    const { files } = runtimeGraph(resolve(here, 'core.ts'));
    expect(files.map((f) => f.slice(here.length + 1))).toContain(
      'lib/normalize.ts',
    );
    // The full entry does load the schemas: the walk would notice them.
    expect(runtimeGraph(resolve(here, 'index.ts')).packages).toEqual(
      expect.arrayContaining(['zod', 'yaml']),
    );
  });

  it('holds the same values as the full entry under the same names', () => {
    for (const [name, value] of Object.entries(core)) {
      expect(full[name as keyof typeof full], name).toBe(value);
    }
  });
});
