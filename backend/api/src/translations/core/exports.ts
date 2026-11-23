import {
  languageDirection,
  type Manifest,
  type Module,
  type PageDesign,
  type ProjectConfig,
  textIn,
} from '@openfolia/content-model';
import {
  wordCount,
  writeXliff,
  xliffUnitsOf,
  xliffUnitsOfConfig,
  xliffUnitsOfDesign,
  xliffUnitsOfManifest,
  type XliffModule,
} from '@openfolia/xliff';
import type { Actor } from '../../access/core/actor.js';
import { allows, ANYWHERE, moduleTarget } from '../../access/core/allows.js';
import type { Permission } from '../../access/core/permissions.js';
import type { ReadableContent } from '../../content/core/readable-content.js';
import {
  CONFIG_KEY,
  CONFIG_ORIGINAL,
  CONFIG_TITLE,
  configTranslationStatus,
  isConfigKey,
  translatesConfigIn,
} from './config-translations.js';
import {
  designIdOf,
  designKey,
  designTranslationStatus,
  managesDesignIn,
  manualDesignId,
  readDesign,
} from './design-translations.js';
import {
  managesManualIn,
  manualIdOf,
  manualKey,
  manualTranslationStatus,
  readManifest,
  seesManualTranslation,
} from './manual-translations.js';
import {
  inFolder,
  manualModules,
  readModule,
  unitsAtProvider,
} from './statuses.js';
import type {
  ExportSubject,
  TranslationJob,
  TranslationJobUnit,
} from './translation-job.js';
import type {
  Languages,
  TranslationJobFilter,
  TranslationJobs,
} from './translation-jobs.js';
import { readTranslation, translationStatus } from './translation-status.js';

/**
 * The languages `actor` manages translations into: those of every role
 * holding `translation.manage` (`'all'` when one of them restricts no
 * language). What an export may name as target languages.
 */
export function managedLanguages(actor: Actor): readonly string[] | 'all' {
  const languages = new Set<string>();
  for (const { permissions, scope } of actor.roles) {
    if (!permissions.includes('translation.manage')) continue;
    if (scope.languages === undefined) return 'all';
    for (const lang of scope.languages) languages.add(lang);
  }
  return [...languages];
}

/** Whether `actor` manages translations into every one of `languages`. */
export function managesAll(
  actor: Actor,
  languages: readonly string[],
): boolean {
  const managed = managedLanguages(actor);
  return managed === 'all' || languages.every((lang) => managed.includes(lang));
}

/**
 * The languages of the roles holding `permission` whose scope restricts
 * nothing but languages (`'all'` when one restricts nothing at all).
 */
function languagesOnly(actor: Actor, permission: Permission): Languages {
  const languages = new Set<string>();
  for (const { permissions, scope } of actor.roles) {
    if (!permissions.includes(permission)) continue;
    const { languages: some, ...rest } = scope;
    if (Object.values(rest).some((value) => value !== undefined)) continue;
    if (some === undefined) return 'all';
    for (const lang of some) languages.add(lang);
  }
  return [...languages];
}

/** Which translation jobs `actor` may see (`seesJob`). */
export function jobReaders(actor: Actor): TranslationJobFilter {
  return {
    reader: { kind: actor.kind, id: actor.id },
    managed: languagesOnly(actor, 'translation.manage'),
    readable: languagesOnly(actor, 'content.read'),
    draftReadable: languagesOnly(actor, 'content.read.draft'),
    drafts: allows(actor, 'content.read.draft', ANYWHERE),
  };
}

/**
 * The source-language modules `subject` names, as the reader sees them,
 * each once (a module a manual reaches through several module references
 * too), in the order found. Modules the reader may not see, or that do not
 * exist or cannot be read, are left out without a word.
 */
export async function subjectModules(
  snapshot: ReadableContent,
  subject: ExportSubject,
  config: ProjectConfig,
): Promise<Module[]> {
  const source = config.languages.source;
  if (subject.type === 'folder') {
    return (await snapshot.modules(source)).flatMap((entry) =>
      'module' in entry && inFolder(entry.module.meta, subject.folder, config)
        ? [entry.module]
        : [],
    );
  }
  if (
    subject.type === 'designs' ||
    subject.type === 'manuals' ||
    subject.type === 'config'
  ) {
    return [];
  }
  const ids =
    subject.type === 'manual'
      ? [...(await manualModules(snapshot, subject.manualId, source))]
      : [...new Set(subject.moduleIds)];
  const modules: Module[] = [];
  for (const id of ids) {
    const module = await readModule(snapshot, id, source);
    if (module) modules.push(module);
  }
  return modules;
}

/**
 * What a delta export of `modules` into `languages` sends: per language,
 * the units of each module whose translation is `outdated` or `missing`
 * and that no open job holds (`at-provider` already). A module counts in
 * a language only where the reader would see a translation in it
 * (`readTranslation`) and `actor` may manage translations of it there
 * (`translation.manage` on the module in that language, every dimension of
 * the scope).
 */
export async function deltaUnits(
  snapshot: ReadableContent,
  actor: Actor,
  jobs: TranslationJobs,
  modules: readonly Module[],
  languages: readonly string[],
): Promise<TranslationJobUnit[]> {
  const config = await snapshot.config();
  const units: TranslationJobUnit[] = [];
  for (const lang of languages) {
    const atProvider = await unitsAtProvider(jobs, lang);
    for (const module of modules) {
      if (
        !allows(
          actor,
          'translation.manage',
          moduleTarget({ ...module.meta, lang }, config),
        )
      ) {
        continue;
      }
      const found = await readTranslation(snapshot, module, lang);
      if (!found) continue;
      const status = translationStatus({
        source: module,
        lang,
        translated: found.translated,
        record: found.record,
        atProvider: atProvider.get(`${lang}/${module.id}`) ?? new Set(),
      });
      const due = new Set(
        status.blocks
          .filter((b) => b.state === 'outdated' || b.state === 'missing')
          .map((b) => b.blockId),
      );
      if (due.size === 0) continue;
      for (const unit of xliffUnitsOf(module, due)) {
        units.push({
          lang,
          moduleId: module.id,
          blockId: unit.blockId,
          sourceHash: unit.sourceHash,
          words: wordCount(unit, config.languages.source),
        });
      }
    }
  }
  return units;
}

/**
 * The page designs `subject` names (#568), each once: a manual's design (as the reader reads
 * the manual; none for the built-in design), or the designs listed. Designs that do not exist
 * or cannot be read are left out without a word; designs carry no audience, so every reader of
 * the commit reads them.
 */
export async function subjectDesigns(
  snapshot: ReadableContent,
  subject: ExportSubject,
  config: ProjectConfig,
): Promise<PageDesign[]> {
  const ids =
    subject.type === 'designs'
      ? [...new Set(subject.designIds)]
      : subject.type === 'manual'
        ? [await manualDesignId(snapshot, subject.manualId, config)].filter(
            (id): id is string => id !== undefined,
          )
        : [];
  const designs: PageDesign[] = [];
  for (const id of ids) {
    const design = await readDesign(snapshot, id);
    if (design) designs.push(design);
  }
  return designs;
}

/**
 * What a delta export of `designs`' region text (#568) into `languages` sends: per language,
 * each design's units that are `outdated` or `missing` (`designTranslationStatus`) and that no
 * open job holds, keyed by the design's key (`designKey`) and the unit's (`<slot>.<block>`).
 * A language counts only where `actor` manages the translation of designs into it
 * (`managesDesignIn`).
 */
export async function deltaDesignUnits(
  snapshot: ReadableContent,
  actor: Actor,
  jobs: TranslationJobs,
  designs: readonly PageDesign[],
  languages: readonly string[],
): Promise<TranslationJobUnit[]> {
  const config = await snapshot.config();
  const source = config.languages.source;
  const units: TranslationJobUnit[] = [];
  for (const lang of languages) {
    if (!managesDesignIn(actor, lang)) continue;
    const atProvider = await unitsAtProvider(jobs, lang);
    for (const design of designs) {
      const key = designKey(design.id);
      const status = designTranslationStatus({
        design,
        lang,
        source,
        atProvider: atProvider.get(`${lang}/${key}`) ?? new Set(),
      });
      const due = new Set(
        (status?.blocks ?? [])
          .filter((b) => b.state === 'outdated' || b.state === 'missing')
          .map((b) => b.blockId),
      );
      if (due.size === 0) continue;
      for (const unit of xliffUnitsOfDesign(design, source, due)) {
        units.push({
          lang,
          moduleId: key,
          blockId: unit.blockId,
          sourceHash: unit.sourceHash,
          words: wordCount(unit, source),
        });
      }
    }
  }
  return units;
}

/** A manual of an export (#656): its ID and its manifest as the reader reads it. */
export interface SubjectManual {
  readonly id: string;
  readonly manifest: Manifest;
}

/**
 * The manuals whose own text (#656: cover images' alternative text) `subject` names, each once:
 * a manual's own, or the manuals listed, as the reader reads them. Manuals they may not see, or
 * that do not exist or cannot be read, are left out without a word.
 */
export async function subjectManuals(
  snapshot: ReadableContent,
  subject: ExportSubject,
): Promise<SubjectManual[]> {
  const ids =
    subject.type === 'manuals'
      ? [...new Set(subject.manualIds)]
      : subject.type === 'manual'
        ? [subject.manualId]
        : [];
  const manuals: SubjectManual[] = [];
  for (const id of ids) {
    const manifest = await readManifest(snapshot, id);
    if (manifest) manuals.push({ id, manifest });
  }
  return manuals;
}

/**
 * What a delta export of `manuals`' own text (#656) into `languages` sends: per language, each
 * manual's units that are `outdated` or `missing` (`manualTranslationStatus`) and that no open
 * job holds, keyed by the manual's key (`manualKey`) and the unit's (`coverImage.…`). A language
 * counts only where the reader reads the manual in it (`seesManualTranslation`) and `actor`
 * manages its translation there (`managesManualIn`).
 */
export async function deltaManualUnits(
  snapshot: ReadableContent,
  actor: Actor,
  jobs: TranslationJobs,
  manuals: readonly SubjectManual[],
  languages: readonly string[],
): Promise<TranslationJobUnit[]> {
  const config = await snapshot.config();
  const source = config.languages.source;
  const units: TranslationJobUnit[] = [];
  for (const lang of languages) {
    const atProvider = await unitsAtProvider(jobs, lang);
    for (const { id, manifest } of manuals) {
      if (
        !(await seesManualTranslation(snapshot, manifest, lang)) ||
        !(await managesManualIn(actor, snapshot, manifest, lang))
      ) {
        continue;
      }
      const key = manualKey(id);
      const status = manualTranslationStatus({
        manualId: id,
        manifest,
        lang,
        source,
        atProvider: atProvider.get(`${lang}/${key}`) ?? new Set(),
      });
      const due = new Set(
        (status?.blocks ?? [])
          .filter((b) => b.state === 'outdated' || b.state === 'missing')
          .map((b) => b.blockId),
      );
      if (due.size === 0) continue;
      for (const unit of xliffUnitsOfManifest(manifest, source, due)) {
        units.push({
          lang,
          moduleId: key,
          blockId: unit.blockId,
          sourceHash: unit.sourceHash,
          words: wordCount(unit, source),
        });
      }
    }
  }
  return units;
}

/**
 * Whether `subject` takes the project labels (#731): `config`, or a manual's (its title page
 * shows them) the reader reads. A manual they may not see, or that cannot be read, takes none.
 */
export async function subjectTakesConfig(
  snapshot: ReadableContent,
  subject: ExportSubject,
): Promise<boolean> {
  if (subject.type === 'config') return true;
  if (subject.type !== 'manual') return false;
  return (await readManifest(snapshot, subject.manualId)) !== undefined;
}

/**
 * What a delta export of the project labels (#731) into `languages` sends: per language, the
 * labels that are `outdated` or `missing` (`configTranslationStatus`) and that no open job
 * holds, keyed `config.project` (`CONFIG_KEY`) and by the unit's key (`ConfigUnitKey`). A
 * language counts only where `actor` manages the labels' translation into it
 * and may change the configuration (`translatesConfigIn`): the import needs both. Every reader
 * of the commit reads the configuration.
 */
export async function deltaConfigUnits(
  snapshot: ReadableContent,
  actor: Actor,
  jobs: TranslationJobs,
  languages: readonly string[],
): Promise<TranslationJobUnit[]> {
  const config = await snapshot.config();
  const source = config.languages.source;
  const units: TranslationJobUnit[] = [];
  for (const lang of languages) {
    if (!translatesConfigIn(actor, lang)) continue;
    const atProvider = await unitsAtProvider(jobs, lang);
    const status = configTranslationStatus({
      config,
      lang,
      atProvider: atProvider.get(`${lang}/${CONFIG_KEY}`) ?? new Set(),
    });
    const due = new Set(
      (status?.blocks ?? [])
        .filter((b) => b.state === 'outdated' || b.state === 'missing')
        .map((b) => b.blockId),
    );
    if (due.size === 0) continue;
    for (const unit of xliffUnitsOfConfig(config, due)) {
      units.push({
        lang,
        moduleId: CONFIG_KEY,
        blockId: unit.blockId,
        sourceHash: unit.sourceHash,
        words: wordCount(unit, source),
      });
    }
  }
  return units;
}

/**
 * The XLIFF document of `job` in `lang`, made from the job's commit
 * (`snapshot`) as the reader sees it: each module of the job's units in
 * that language that the reader sees in the source language, would see a
 * translation of, and manages translations of (as `deltaUnits` decides),
 * with the job's units of it, each `<file>` naming the source's and the
 * target's text direction; and each page design of the job's units (#568) that is still there,
 * where the reader manages the translation of designs into `lang` (`managesDesignIn`), as a
 * `<file id="design.<id>">` of its own; and each manual of the job's units (#656) the reader
 * still reads in `lang` and manages the translation of there (as `deltaManualUnits` decides), as
 * a `<file id="manual.<id>">`; and the project labels of the job's units (#731), where the reader
 * manages their translation into `lang` and may change the configuration (`translatesConfigIn`), as
 * `<file id="config.project" original="openfolia.yaml">`. Undefined when none is left.
 */
export async function jobDocument(
  snapshot: ReadableContent,
  actor: Actor,
  job: TranslationJob,
  lang: string,
  units: readonly TranslationJobUnit[],
): Promise<string | undefined> {
  const config = await snapshot.config();
  const source = config.languages.source;
  const byModule = new Map<string, Set<string>>();
  for (const unit of units) {
    const blocks = byModule.get(unit.moduleId) ?? new Set<string>();
    blocks.add(unit.blockId);
    byModule.set(unit.moduleId, blocks);
  }
  const files: XliffModule[] = [];
  for (const [moduleId, blocks] of byModule) {
    if (isConfigKey(moduleId)) {
      // The project labels (#731), in a file of their own.
      const found = translatesConfigIn(actor, lang)
        ? xliffUnitsOfConfig(config, blocks)
        : [];
      if (found.length === 0) continue;
      files.push({
        moduleId,
        title: CONFIG_TITLE,
        original: CONFIG_ORIGINAL,
        units: found,
      });
      continue;
    }
    const designId = designIdOf(moduleId);
    if (designId !== undefined) {
      // A page design's region text (#568), in a file of its own.
      const design = managesDesignIn(actor, lang)
        ? await readDesign(snapshot, designId)
        : undefined;
      const found = design ? xliffUnitsOfDesign(design, source, blocks) : [];
      if (!design || found.length === 0) continue;
      files.push({
        moduleId,
        title: design.name,
        original: `design/${designId}.yaml`,
        units: found,
      });
      continue;
    }
    const manualId = manualIdOf(moduleId);
    if (manualId !== undefined) {
      // A manual's own text (#656), in a file of its own.
      const manifest = await readManifest(snapshot, manualId);
      const found =
        manifest &&
        (await seesManualTranslation(snapshot, manifest, lang)) &&
        (await managesManualIn(actor, snapshot, manifest, lang))
          ? xliffUnitsOfManifest(manifest, source, blocks)
          : [];
      if (!manifest || found.length === 0) continue;
      files.push({
        moduleId,
        title: textIn(manifest.title, source, source),
        original: `manuals/${manualId}.yaml`,
        units: found,
      });
      continue;
    }
    const module = await readModule(snapshot, moduleId, source);
    if (
      !module ||
      !allows(
        actor,
        'translation.manage',
        moduleTarget({ ...module.meta, lang }, config),
      ) ||
      !(await readTranslation(snapshot, module, lang))
    ) {
      continue;
    }
    const found = xliffUnitsOf(module, blocks);
    if (found.length === 0) continue;
    files.push({
      moduleId,
      title: module.meta.title,
      original: `modules/${source}/${moduleId}.adoc`,
      units: found,
    });
  }
  if (files.length === 0) return undefined;
  return writeXliff({
    srcLang: source,
    trgLang: lang,
    // Each side's direction, as the configuration gives it (#458).
    srcDir: languageDirection(source, config),
    trgDir: languageDirection(lang, config),
    meta: { job: job.id, commit: job.commit },
    modules: files,
  });
}
