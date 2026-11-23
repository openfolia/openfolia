import {
  readXml,
  type XmlElement,
  type XmlLimits,
  type XmlNode,
  XmlReadError,
  type XmlRefusal,
} from '@openfolia/xml';
import { attributeValue, plainText } from './xml.js';

/**
 * COTI (the open exchange standard between content and translation management systems), level
 * 1: a translation package is a ZIP holding one folder per translation project, each with its
 * project description `COTI.xml` and its files. This module writes and reads that description;
 * packing the ZIP is the caller's (the API's `CotiPackageExchange`).
 */

/** The namespace of `COTI.xml`, as the standard (specification 1.1) fixes it. */
export const COTI_NAMESPACE = 'http://www.dercom.de/COTI/2013/1.0/namespace';

/** The project description's file name, at the top of each project's folder. */
export const COTI_FILE = 'COTI.xml';

/** The folder of a project holding the files to translate. */
export const COTI_TRANSLATION_FOLDER = 'translation files';

/** The specification version written. */
export const COTI_VERSION = '1.1';

/** The COTI levels `<coti level>` may name. */
export const COTI_LEVELS = ['1', '2', '3'] as const;

/** What a translation's files may be, as the TMS may set it: untranslated, partly, completely. */
export const COTI_STATUSES = ['none', 'proof', 'final'] as const;
export type CotiStatus = (typeof COTI_STATUSES)[number];

/** One file to translate, relative to the project's folder. */
export interface CotiTranslationFile {
  /** Relative to `COTI.xml` (`translation files/<name>`); at most 255 characters. */
  readonly fileRef: string;
  readonly mimeType: string;
  readonly encoding?: string;
  readonly creationDate?: Date;
}

/** One translation project: one source and one target language, as `COTI.xml` describes it. */
export interface CotiProject {
  /** The application that wrote it (`<coti creator>`). */
  readonly creator: string;
  readonly creationDate: Date;
  /** The package the project belongs to (`<coti package-id>`). */
  readonly packageId?: string;
  readonly name: string;
  readonly projectId: string;
  readonly checkoutDate: Date;
  readonly dueDate?: Date;
  readonly subject?: string;
  readonly meta?: readonly { readonly name: string; readonly value: string }[];
  /** `<translation name>`. */
  readonly translationName: string;
  /** COTI language codes (`cotiLanguage`). */
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly status?: CotiStatus;
  readonly files: readonly CotiTranslationFile[];
}

/** Why a `COTI.xml` is refused: an XML refusal, `not-coti` (no COTI root) or `invalid-coti`. */
export type CotiRefusal = XmlRefusal | 'not-coti' | 'invalid-coti';

export class CotiReadError extends Error {
  override readonly name = 'CotiReadError';

  constructor(
    readonly reason: CotiRefusal,
    message: string,
  ) {
    super(message);
  }
}

export class CotiWriteError extends Error {
  override readonly name = 'CotiWriteError';
}

/** A `COTI.xml` as read: what an import needs of it. */
export interface ReadCoti {
  readonly level: string;
  readonly version: string;
  readonly packageId: string | undefined;
  readonly projectId: string;
  /** The `<meta>` entries, by name (the first of a name). */
  readonly meta: Readonly<Record<string, string>>;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly status: CotiStatus | undefined;
  readonly files: readonly {
    readonly fileRef: string;
    readonly mimeType: string;
  }[];
}

/** A project description is small: one per project, a line per file. */
export const COTI_XML_LIMITS: XmlLimits = {
  maxLength: 1024 * 1024,
  maxDepth: 8,
  maxNodes: 20_000,
  maxAttributes: 32,
};

/** The longest relative file reference the standard allows. */
export const MAX_COTI_FILE_REF = 255;

/** A COTI language code: a language and a region (`de-DE`), as the standard's schema has them. */
const COTI_LANGUAGE = /^[a-zA-Z]{1,8}-[a-zA-Z0-9]{1,8}$/;

/** A MIME type, as the standard's schema has it. */
const MIME_TYPE = /^[-\w]+\/[-\w+]+$/;

/** What a project folder's name may hold, by the standard: `[a-zA-Z0-9_-+]`. */
const FOLDER_CHARACTER = /[^a-zA-Z0-9_\-+]/g;

/**
 * A language tag as COTI writes it: language and region (`de` → `de-DE`, `en` → `en-US`, `pt-BR`
 * stays), the region the tag's own or else its most likely one (`Intl.Locale#maximize`, from
 * CLDR), as the standard's schema takes only `<language>-<region>`. A script is not carried
 * (`zh-Hant-TW` → `zh-TW`); `ZZ` (unknown) where no region is known.
 */
export function cotiLanguage(tag: string): string {
  const locale = new Intl.Locale(tag);
  const region = locale.region ?? locale.maximize().region ?? 'ZZ';
  return `${locale.language}-${region}`;
}

/** A time as a package's name starts with it: `2009-11-13T103935Z` (UTC, no separators in the time). */
export function cotiTimestamp(at: Date): string {
  const iso = at.toISOString(); // 2009-11-13T10:39:35.123Z
  return `${iso.slice(0, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
}

/** A name part of a package or folder, with only the characters the standard allows (others `-`). */
export function cotiName(text: string): string {
  return text.replace(FOLDER_CHARACTER, '-');
}

/** A project's folder: `<project-id>_<source>_<target>`. */
export function cotiProjectFolder(
  project: Pick<CotiProject, 'projectId' | 'sourceLanguage' | 'targetLanguage'>,
): string {
  return [project.projectId, project.sourceLanguage, project.targetLanguage]
    .map(cotiName)
    .join('_');
}

/** `xs:dateTime` in UTC, without fractions of a second. */
const dateTime = (at: Date) => `${at.toISOString().slice(0, 19)}Z`;

const attributes = (
  entries: readonly (readonly [string, string | undefined])[],
) =>
  entries
    .filter((e): e is readonly [string, string] => e[1] !== undefined)
    .map(([name, value]) => ` ${name}="${attributeValue(value)}"`)
    .join('');

/**
 * `COTI.xml` for one project (level 1, specification 1.1), in the standard's namespace, UTF-8
 * with an XML declaration, no DTD. Throws `CotiWriteError` for what the standard's schema
 * would refuse: a language that is not `<language>-<region>`, no file, a file reference that is
 * empty, longer than 255 characters or not relative, a MIME type that is not one.
 */
export function writeCoti(project: CotiProject): string {
  for (const lang of [project.sourceLanguage, project.targetLanguage]) {
    if (!COTI_LANGUAGE.test(lang)) {
      throw new CotiWriteError(
        `"${lang}" is no COTI language code (<language>-<region>).`,
      );
    }
  }
  if (project.files.length === 0) {
    throw new CotiWriteError('A COTI project holds at least one file.');
  }
  for (const file of project.files) {
    if (
      file.fileRef.length === 0 ||
      file.fileRef.length > MAX_COTI_FILE_REF ||
      !isRelativeFileRef(file.fileRef)
    ) {
      throw new CotiWriteError(
        `"${file.fileRef}" is no relative file reference of 1 to ${MAX_COTI_FILE_REF} characters.`,
      );
    }
    if (!MIME_TYPE.test(file.mimeType)) {
      throw new CotiWriteError(`"${file.mimeType}" is no MIME type.`);
    }
  }
  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
  lines.push(
    `<coti xmlns="${COTI_NAMESPACE}"${attributes([
      ['version', COTI_VERSION],
      ['level', '1'],
      ['creator', project.creator],
      ['creation-date', dateTime(project.creationDate)],
      ['package-id', project.packageId],
    ])}>`,
  );
  lines.push(
    `  <project${attributes([
      ['name', project.name],
      ['project-id', project.projectId],
      ['checkout-date', dateTime(project.checkoutDate)],
      ['proposal', 'no'],
      ['due-date', project.dueDate && dateTime(project.dueDate)],
    ])}>`,
  );
  if (project.subject !== undefined) {
    lines.push(`    <subject>${plainText(project.subject)}</subject>`);
  }
  for (const { name, value } of project.meta ?? []) {
    lines.push(
      `    <meta${attributes([
        ['name', name],
        ['value', value],
      ])}/>`,
    );
  }
  lines.push(
    `    <translation${attributes([
      ['name', project.translationName],
      ['source-language', project.sourceLanguage],
      ['target-language', project.targetLanguage],
      ['status', project.status],
    ])}>`,
  );
  for (const file of project.files) {
    lines.push(
      `      <translation-file${attributes([
        ['file-ref', file.fileRef],
        ['mime-type', file.mimeType],
        ['encoding', file.encoding],
        ['creation-date', file.creationDate && dateTime(file.creationDate)],
      ])}/>`,
    );
  }
  lines.push('    </translation>', '  </project>', '</coti>', '');
  return lines.join('\n');
}

/**
 * Whether `ref` is a plain relative path inside its project's folder: `/` as the separator, no
 * empty, `.` or `..` segment, no backslash, colon or control character, not absolute.
 */
export function isRelativeFileRef(ref: string): boolean {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\:]/.test(ref) || ref.startsWith('/')) {
    return false;
  }
  return ref
    .split('/')
    .every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

const isCoti = (node: XmlNode, local: string): node is XmlElement =>
  typeof node !== 'string' &&
  node.ns === COTI_NAMESPACE &&
  node.local === local;

const childrenOf = (element: XmlElement, local: string): XmlElement[] =>
  element.children.filter((c): c is XmlElement => isCoti(c, local));

const invalid = (message: string) => new CotiReadError('invalid-coti', message);

const required = (element: XmlElement, name: string): string => {
  const value = element.attributes.get(name);
  if (value === undefined || value.trim() === '') {
    throw invalid(`<${element.local}> has no "${name}".`);
  }
  return value;
};

/**
 * Reads a `COTI.xml` as untrusted input (`readXml`: no DTD, no entities but XML's five, bounded by
 * `COTI_XML_LIMITS`, UTF-8 only): a `<coti>` in the standard's namespace (else `not-coti`) with a
 * `level` and `version`, one `<project>` with a `project-id`, one `<translation>` with its source
 * and target language (each `<language>-<region>`) and at least one `<translation-file>`, each
 * with a `file-ref` (a relative path inside the project's folder, at most 255 characters) and a
 * `mime-type` (else `invalid-coti`). Reference files are not read: they are context for a
 * translator, never imported.
 */
export function readCoti(xml: string): ReadCoti {
  let root: XmlElement;
  try {
    root = readXml(xml, COTI_XML_LIMITS);
  } catch (error) {
    if (error instanceof XmlReadError) {
      throw new CotiReadError(error.reason, error.message);
    }
    throw error;
  }
  if (!isCoti(root, 'coti')) {
    throw new CotiReadError(
      'not-coti',
      `The project description is no COTI document (a <coti> in ${COTI_NAMESPACE}).`,
    );
  }
  const level = required(root, 'level');
  if (!(COTI_LEVELS as readonly string[]).includes(level)) {
    throw invalid(`<coti level="${level}"> names no COTI level.`);
  }
  const version = required(root, 'version');
  const projects = childrenOf(root, 'project');
  const [project] = projects;
  if (!project || projects.length > 1) {
    throw invalid('A COTI document holds exactly one <project>.');
  }
  const translations = childrenOf(project, 'translation');
  const [translation] = translations;
  if (!translation || translations.length > 1) {
    throw invalid('A COTI project holds exactly one <translation>.');
  }
  const language = (name: string) => {
    const value = required(translation, name);
    if (!COTI_LANGUAGE.test(value)) {
      throw invalid(`"${value}" is no COTI language code (${name}).`);
    }
    return value;
  };
  const status = translation.attributes.get('status');
  if (
    status !== undefined &&
    !(COTI_STATUSES as readonly string[]).includes(status)
  ) {
    throw invalid(
      `<translation status="${status}"> is none of ${COTI_STATUSES.join(', ')}.`,
    );
  }
  const files = childrenOf(translation, 'translation-file').map((file) => {
    const fileRef = required(file, 'file-ref');
    if (fileRef.length > MAX_COTI_FILE_REF || !isRelativeFileRef(fileRef)) {
      throw invalid(
        `The file reference ${JSON.stringify(fileRef.slice(0, MAX_COTI_FILE_REF))} is no relative path inside the project's folder.`,
      );
    }
    return { fileRef, mimeType: required(file, 'mime-type') };
  });
  if (files.length === 0) {
    throw invalid('A COTI translation names at least one <translation-file>.');
  }
  // No prototype: a `<meta name="__proto__">` is a name like any other.
  const meta: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  for (const entry of childrenOf(project, 'meta')) {
    const name = entry.attributes.get('name');
    const value = entry.attributes.get('value');
    if (
      name !== undefined &&
      value !== undefined &&
      !Object.hasOwn(meta, name)
    ) {
      meta[name] = value;
    }
  }
  const packageId = root.attributes.get('package-id');
  return {
    level,
    version,
    packageId:
      packageId === undefined || packageId === '' ? undefined : packageId,
    projectId: required(project, 'project-id'),
    meta,
    sourceLanguage: language('source-language'),
    targetLanguage: language('target-language'),
    status: status as CotiStatus | undefined,
    files,
  };
}
