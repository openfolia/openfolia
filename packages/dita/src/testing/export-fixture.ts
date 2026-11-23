import type {
  ImportDocument,
  Manifest,
  Module,
  ProjectConfig,
} from '@openfolia/content-model';
import { convertDita, type DitaConversion } from '../lib/convert.js';
import {
  type DitaExport,
  type DitaExportInput,
  exportDita,
} from '../lib/export/export.js';
import { fixtureConfig, fixtureFiles } from './fixture.js';

/** The garden pump fixture imported: the content a DITA export is tested on. */
export async function importedFixture(): Promise<{
  config: ProjectConfig;
  conversion: DitaConversion;
  document: ImportDocument;
}> {
  const config = fixtureConfig();
  const conversion = await convertDita(fixtureFiles(), config);
  return { config, conversion, document: conversion.document };
}

/** The input exporting a manual of an imported project takes, its modules and files from the import. */
export function exportInput(
  config: ProjectConfig,
  conversion: DitaConversion,
  manualId: string,
  overrides: Partial<DitaExportInput> = {},
): DitaExportInput {
  const { document } = conversion;
  const manifest = document.manuals.find((m) => m.id === manualId) as
    Manifest | undefined;
  if (!manifest) throw new Error(`No manual ${manualId}`);
  const modules = new Map<string, Module>(
    document.modules.map((m) => [`${m.meta.lang}/${m.id}`, m as Module]),
  );
  return {
    config,
    manifest,
    languages: [config.languages.source, ...config.languages.targets],
    variants: manifest.variants,
    module: (id, lang) => modules.get(`${lang}/${id}`),
    asset: (ref) =>
      conversion.assets.has(ref) ? { extension: '.png' } : undefined,
    symbol: (id) =>
      config.safetySymbols.some((s) => s.id === id)
        ? { extension: '.png' }
        : undefined,
    ...overrides,
  };
}

/** An export's files as an archive holds them: the XML encoded, stored files and symbols' artwork put in. */
export function packageFiles(
  exported: DitaExport,
  conversion: DitaConversion,
): Map<string, Uint8Array> {
  const symbolArt = fixtureFiles().get('images/hot-surface.png') as Uint8Array;
  const files = new Map<string, Uint8Array>();
  for (const file of exported.files) {
    if ('text' in file) {
      files.set(file.path, new TextEncoder().encode(file.text));
    } else if ('asset' in file) {
      files.set(file.path, conversion.assets.get(file.asset) as Uint8Array);
    } else {
      files.set(file.path, symbolArt);
    }
  }
  return files;
}

export { exportDita };
