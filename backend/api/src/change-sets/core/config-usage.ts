import {
  type Issue,
  type Manifest,
  type Module,
  parseManifest,
  parseModule,
  type PageDesign,
  parsePageDesign,
  parseTerm,
  type ProjectConfig,
  type Term,
  validateManifest,
  validateModule,
  validateTerm,
} from '@openfolia/content-model';
import { type Problem, UnprocessableProblems } from '../../base/core/errors.js';
import type { ReadableContent } from '../../content/core/readable-content.js';
import {
  type LockSubject,
  parseSubject,
  subjectKey,
  subjectName,
} from './lock.js';
import { designIssues } from './design-issues.js';
import type { DraftManifest } from './working-copy.js';

/** Content a configuration change would make invalid: the subject and the new problem. */
export interface ConfigUsage {
  readonly subject: LockSubject;
  readonly issue: Issue;
}

/** Content a configuration change is checked against. */
type CheckedFile = Module | Manifest | DraftManifest | Term | PageDesign;

/**
 * A module's, manual's, term's or page design's file as content to check
 * (`configUsages`'s `replaced`); undefined for the configuration, or a
 * file that does not parse (no content to keep valid).
 */
export function checkedFile(
  subject: LockSubject,
  bytes: Uint8Array,
): Module | Manifest | Term | PageDesign | undefined {
  // A template file (#396) names nothing of the configuration.
  if (subject.type === 'config' || subject.type === 'template') return undefined;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (subject.type === 'module') {
      const module = parseModule(text, { id: subject.moduleId });
      // A file in another language's folder is no content of this one.
      return module.meta.lang === subject.lang ? module : undefined;
    }
    switch (subject.type) {
      case 'manual':
        return parseManifest(text, { id: subject.manualId });
      case 'term':
        return parseTerm(text, { id: subject.termId });
      case 'design':
        return parsePageDesign(text, { id: subject.designId });
    }
  } catch {
    return undefined;
  }
}

/** The most usages one refusal lists; the detail says how many there are. */
export const MAX_USAGES = 100;

/**
 * Whether `to` takes away anything content can name in `from`: a
 * language, a module type, an audience, a facet or one of its values, a
 * variant attribute or value (or an attribute's kind changed), a text
 * attribute or a safety symbol (a language a term holds included). Labels, order, archiving and additions
 * never make content invalid, so only a change that narrows needs the
 * content read.
 */
export function narrows(from: ProjectConfig, to: ProjectConfig): boolean {
  const ids = (config: ProjectConfig): Set<string> =>
    new Set([
      ...[config.languages.source, ...config.languages.targets].map(
        (l) => `language:${l}`,
      ),
      ...config.moduleTypes.map((t) => `type:${t.id}`),
      ...config.audiences.map((a) => `audience:${a.id}`),
      ...config.facets.flatMap((f) => [
        `facet:${f.id}`,
        ...f.values.map((v) => `facet:${f.id}:${v.id}`),
      ]),
      ...config.variantAttributes.flatMap((a) => [
        `variant:${a.id}:${a.kind}`,
        ...(a.kind === 'enum'
          ? a.values.map((v) => `variant:${a.id}:${a.kind}:${v.id}`)
          : []),
      ]),
      ...config.textAttributes.map((a) => `text:${a.id}`),
      ...config.safetySymbols.map((s) => `symbol:${s.id}`),
      ...(config.calloutStyles ?? []).map((s) => `calloutStyle:${s.id}`),
    ]);
  const kept = ids(to);
  return [...ids(from)].some((id) => !kept.has(id));
}

/**
 * What changing the configuration from `from` to `to` would make invalid
 * in `content` (a change set's head, read past the reading filter: a
 * check, never a response): every validation error of a module or manual
 * under `to` that it does not have under `from`, e.g. a condition on a
 * removed variant value, a module or a term in a removed language, a
 * module of a removed type. `replaced` holds the files the same save point writes (by subject
 * name, `null` for a deletion), checked in place of what is committed;
 * `replacedFrom` is the configuration those were valid under (`from`
 * unless said: a change set's files at a merge were written under its
 * own); `alsoFrom` a second one for a file (by name) that was valid
 * under either (a merge's file changed on both sides). An error counts
 * when one of them lacks it. Archiving a value instead of removing it keeps it valid. Nothing
 * is read when `to` takes nothing away from either (`narrows`).
 */
export async function configUsages(
  content: ReadableContent,
  from: ProjectConfig,
  to: ProjectConfig,
  replaced: ReadonlyMap<string, CheckedFile | null> = new Map(),
  replacedFrom: ProjectConfig = from,
  alsoFrom: ReadonlyMap<string, ProjectConfig> = new Map(),
): Promise<ConfigUsage[]> {
  const forFiles = narrows(from, to);
  const forReplaced =
    forFiles ||
    narrows(replacedFrom, to) ||
    [...alsoFrom.values()].some((c) => narrows(c, to));
  if (!forReplaced) return [];
  const usages: ConfigUsage[] = [];
  // An error is new when one configuration the file was valid under lacks it.
  const check = (
    subject: LockSubject,
    file: CheckedFile,
    froms: readonly ProjectConfig[],
  ) => {
    const validate = (config: ProjectConfig): Issue[] => {
      switch (subject.type) {
        case 'module':
          return validateModule(file as Module, config);
        case 'term':
          return validateTerm(file as Term, config);
        case 'design':
          return designIssues(file as PageDesign, config);
        default:
          return validateManifest(file as Manifest, config);
      }
    };
    const key = (i: Issue) => `${i.code}\u0000${i.at ?? ''}\u0000${i.message}`;
    const before = froms.map(
      (from) =>
        new Set(
          validate(from)
            .filter((i) => i.severity === 'error')
            .map(key),
        ),
    );
    for (const issue of validate(to)) {
      if (
        issue.severity === 'error' &&
        before.some((b) => !b.has(key(issue)))
      ) {
        usages.push({ subject, issue });
      }
    }
  };
  for await (const file of forFiles ? content.everythingForCheck() : []) {
    const subject: LockSubject =
      file.kind === 'module'
        ? { type: 'module', lang: file.lang, moduleId: file.id }
        : file.kind === 'manual'
          ? { type: 'manual', manualId: file.id }
          : file.kind === 'term'
            ? { type: 'term', termId: file.id }
            : { type: 'design', designId: file.id };
    const name = subjectName(subject);
    if (replaced.has(name)) continue;
    const there =
      file.kind === 'module'
        ? file.module
        : file.kind === 'manual'
          ? file.manifest
          : file.kind === 'term'
            ? file.term
            : file.design;
    // A broken file is no content to keep valid.
    if (there === 'unreadable') continue;
    if (forFiles) check(subject, there, [from]);
  }
  for (const [name, file] of replaced) {
    // A deleted file is gone.
    if (file === null) continue;
    const subject = parseSubject(name);
    if (
      subject === undefined ||
      subject.type === 'config' ||
      subject.type === 'template'
    )
      continue;
    const also = alsoFrom.get(name);
    check(subject, file, also ? [replacedFrom, also] : [replacedFrom]);
  }
  return usages.sort((a, b) =>
    subjectName(a.subject).localeCompare(subjectName(b.subject)),
  );
}

/**
 * 422 `config-in-use` when `usages` is not empty: one error object per
 * usage (at most `MAX_USAGES`), `source.pointer` naming the subject and
 * block (`/module/en/charging/blocks/<id>`), `meta` the subject, the
 * validation code (`issue`) and the block (`at`).
 */
export function refuseUsages(usages: readonly ConfigUsage[]): void {
  if (usages.length === 0) return;
  const problems: Problem[] = usages
    .slice(0, MAX_USAGES)
    .map(({ subject, issue }) => {
      const { type, id } = subjectKey(subject);
      return {
        detail: issue.message,
        pointer: `/${type}/${id}${
          issue.at === undefined
            ? ''
            : type === 'design'
              ? // Where in the design: `regions.footer.en#b` as `/regions/footer/en/blocks/b`.
                `/${issue.at.replace('#', '/blocks/').replaceAll('.', '/')}`
              : `/blocks/${issue.at}`
        }`,
        meta: {
          subject,
          issue: issue.code,
          ...(issue.at !== undefined && { at: issue.at }),
        },
      };
    });
  throw new UnprocessableProblems(
    'config-in-use',
    `The configuration would make ${usages.length} ${usages.length === 1 ? 'place' : 'places'} in the content invalid${usages.length > MAX_USAGES ? ` (the first ${MAX_USAGES} listed)` : ''}: archive what is in use instead of removing it, or change the content first.`,
    problems,
  );
}
