import { sniffImageType } from './sniff-image-type.js';

/**
 * What an attachment upload may be (#236). Any file type is taken, within
 * rules from the settings: an optional allow list, a deny list, and the
 * dangerous types (executables, scripts, HTML, SVG), refused unless the
 * settings open them. The type is decided by the server from the bytes and
 * the file name's extension, never from the part's `Content-Type`.
 */

/** One entry of a type list: `application/zip`, `text/*` or `.zip`. */
export type TypeRule =
  | { readonly kind: 'type'; readonly type: string }
  | { readonly kind: 'family'; readonly top: string }
  | { readonly kind: 'extension'; readonly extension: string };

export interface AttachmentTypeRules {
  /** When given, only a file whose type or extension one of these names. */
  readonly allow?: readonly TypeRule[] | undefined;
  /** Refused: a file whose type or extension one of these names. */
  readonly deny: readonly TypeRule[];
  /** Dangerous types and extensions taken all the same. */
  readonly open: readonly TypeRule[];
}

export const NO_TYPE_RULES: AttachmentTypeRules = { deny: [], open: [] };

const NAME = '[a-z0-9][a-z0-9!#$&^_.+-]{0,62}';
const TYPE_ENTRY = new RegExp(`^${NAME}/(?:\\*|${NAME})$`);
const EXTENSION_ENTRY = /^\.[a-z0-9][a-z0-9_+-]{0,31}$/;

/**
 * A comma-separated list of type rules, as the settings hold it: each a
 * media type (`application/zip`), a top-level type with `/*` (`text/*`) or
 * an extension with its dot (`.zip`), lowercase; spaces around entries
 * are ignored, an empty list is none. Returns the problem as a string for
 * a malformed entry.
 */
export function parseTypeRules(raw: string): TypeRule[] | string {
  const rules: TypeRule[] = [];
  for (const entry of raw.split(',').map((e) => e.trim())) {
    if (entry === '') continue;
    if (EXTENSION_ENTRY.test(entry)) {
      rules.push({ kind: 'extension', extension: entry });
    } else if (TYPE_ENTRY.test(entry)) {
      rules.push(
        entry.endsWith('/*')
          ? { kind: 'family', top: entry.slice(0, -2) }
          : { kind: 'type', type: entry },
      );
    } else {
      return `"${entry}" is neither a lowercase media type (application/zip, text/*) nor an extension (.zip)`;
    }
  }
  return rules;
}

/**
 * Types that run code or render as a page where they are opened: HTML and
 * what a browser renders like it, SVG (a document that can hold scripts),
 * executables, installers and scripts.
 */
export const DANGEROUS_TYPES: ReadonlySet<string> = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'text/javascript',
  'application/javascript',
  'application/x-msdownload',
  'application/vnd.microsoft.portable-executable',
  'application/x-msi',
  'application/x-elf',
  'application/x-mach-binary',
  'application/x-sh',
  'application/java-archive',
  'application/vnd.android.package-archive',
  'application/hta',
  // Office documents that carry macros: the legacy binary formats (OLE
  // compound files, whatever the bytes are) and the macro-enabled ones.
  'application/x-ole-storage',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.ms-word.document.macroenabled.12',
  'application/vnd.ms-word.template.macroenabled.12',
  'application/vnd.ms-excel.sheet.macroenabled.12',
  'application/vnd.ms-excel.template.macroenabled.12',
  'application/vnd.ms-excel.addin.macroenabled.12',
  'application/vnd.ms-excel.sheet.binary.macroenabled.12',
  'application/vnd.ms-powerpoint.presentation.macroenabled.12',
  'application/vnd.ms-powerpoint.template.macroenabled.12',
  'application/vnd.ms-powerpoint.addin.macroenabled.12',
  'application/vnd.ms-powerpoint.slideshow.macroenabled.12',
]);

/** Extensions that run code or render as a page when opened, whatever the bytes are. */
export const DANGEROUS_EXTENSIONS: ReadonlySet<string> = new Set(
  (
    '.html .htm .xhtml .xht .shtml .mht .mhtml .svg .svgz .hta ' +
    '.js .mjs .cjs .jse .vbs .vbe .wsf .wsh .ps1 .psm1 .bat .cmd .sh .bash .zsh .command ' +
    '.exe .dll .com .scr .cpl .msi .msp .jar .apk .app .dmg .pkg .deb .rpm .lnk .reg ' +
    // What Windows opens or mounts past its download warning, shortcuts
    // that reach out on their own, macro documents and script files.
    '.iso .img .vhd .vhdx .chm .url .scf .pif .msc .inf .xll .appref-ms .application ' +
    '.library-ms .settingcontent-ms .wsc .sct .ps1xml .psd1 .psc1 .py .pyw .pl .rb ' +
    '.docm .dotm .xlsm .xltm .xlam .pptm .potm .ppam ' +
    // Legacy Office formats, which carry macros, and the rest of what
    // Windows runs or installs.
    '.doc .dot .xls .xlt .xla .xlsb .ppt .pot .pps .ppsm .sldm .mdb .mde .accde .ade .adp ' +
    '.msix .msixbundle .appx .appxbundle .mst .ocx .sys .drv .cab .gadget .hlp .jnlp ' +
    '.vb .vbscript .ws .ps2 .ps2xml .psc2 .mshxml .msh .msh1 .msh2 .msh1xml .msh2xml ' +
    '.diagcab .xbap .ins .isp .its .job .search-ms ' +
    // Remote-desktop and web-query files, OneNote and RTF documents with
    // embedded objects, shell scraps, themes that reach out on their own.
    '.rdp .iqy .slk .one .onepkg .rtf .shs .shb .wbk .xlm .pub .mam .theme .themepack ' +
    '.website .vsto'
  ).split(' '),
);

/** Media types by extension, for files the bytes say nothing certain about. */
const BY_EXTENSION: Readonly<Record<string, string>> = {
  '.zip': 'application/zip',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.toml': 'application/toml',
  '.ini': 'text/plain',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.tgz': 'application/gzip',
  '.7z': 'application/x-7z-compressed',
  '.bin': 'application/octet-stream',
  '.hex': 'text/plain',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.docx':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx':
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.xhtml': 'application/xhtml+xml',
  '.svg': 'image/svg+xml',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.dll': 'application/vnd.microsoft.portable-executable',
  '.msi': 'application/x-msi',
  '.sh': 'application/x-sh',
  '.jar': 'application/java-archive',
  '.apk': 'application/vnd.android.package-archive',
  '.hta': 'application/hta',
  '.doc': 'application/msword',
  '.dot': 'application/msword',
  '.xls': 'application/vnd.ms-excel',
  '.xlt': 'application/vnd.ms-excel',
  '.xla': 'application/vnd.ms-excel',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pot': 'application/vnd.ms-powerpoint',
  '.pps': 'application/vnd.ms-powerpoint',
  '.docm': 'application/vnd.ms-word.document.macroenabled.12',
  '.dotm': 'application/vnd.ms-word.template.macroenabled.12',
  '.xlsm': 'application/vnd.ms-excel.sheet.macroenabled.12',
  '.xltm': 'application/vnd.ms-excel.template.macroenabled.12',
  '.xlam': 'application/vnd.ms-excel.addin.macroenabled.12',
  '.xlsb': 'application/vnd.ms-excel.sheet.binary.macroenabled.12',
  '.pptm': 'application/vnd.ms-powerpoint.presentation.macroenabled.12',
  '.potm': 'application/vnd.ms-powerpoint.template.macroenabled.12',
  '.ppam': 'application/vnd.ms-powerpoint.addin.macroenabled.12',
  '.ppsm': 'application/vnd.ms-powerpoint.slideshow.macroenabled.12',
};

/** How many of the file's first bytes `attachmentType` reads. */
export const ATTACHMENT_SNIFF_BYTES = 4096;

/**
 * The lowercase extension of `fileName` with its dot (`.zip`), or
 * `undefined`. A name that is all extension (`.hta`, `.bashrc`) has one:
 * Windows opens `.hta` as an HTML application all the same.
 */
export function extensionOf(fileName: string | undefined): string | undefined {
  if (fileName === undefined) return undefined;
  const dot = fileName.lastIndexOf('.');
  if (dot < 0 || dot === fileName.length - 1) return undefined;
  const extension = fileName.slice(dot).toLowerCase();
  return EXTENSION_ENTRY.test(extension) ? extension : undefined;
}

const startsWith = (head: Uint8Array, bytes: readonly number[]) =>
  bytes.every((b, i) => head[i] === b);

/**
 * The type the bytes show, when they show one for certain: a dangerous
 * kind (HTML, SVG, an executable or a script) or a format with a
 * signature (images, PDF, ZIP, gzip, 7z). `undefined` for anything else.
 */
export function sniffAttachmentType(head: Uint8Array): string | undefined {
  if (startsWith(head, [0x4d, 0x5a])) {
    return 'application/vnd.microsoft.portable-executable';
  }
  if (startsWith(head, [0x7f, 0x45, 0x4c, 0x46])) return 'application/x-elf';
  for (const magic of [
    [0xfe, 0xed, 0xfa, 0xce],
    [0xfe, 0xed, 0xfa, 0xcf],
    [0xce, 0xfa, 0xed, 0xfe],
    [0xcf, 0xfa, 0xed, 0xfe],
  ]) {
    if (startsWith(head, magic)) return 'application/x-mach-binary';
  }
  if (startsWith(head, [0x23, 0x21])) return 'application/x-sh';
  // An OLE compound file: legacy Office documents (with their macros),
  // Windows installers.
  if (startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return 'application/x-ole-storage';
  }
  const image = sniffImageType(head);
  if (image !== 'application/octet-stream') return image;
  if (looksLikeHtml(head)) return 'text/html';
  if (startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d]))
    return 'application/pdf';
  if (
    startsWith(head, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWith(head, [0x50, 0x4b, 0x05, 0x06])
  ) {
    return 'application/zip';
  }
  if (startsWith(head, [0x1f, 0x8b])) return 'application/gzip';
  if (startsWith(head, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) {
    return 'application/x-7z-compressed';
  }
  return undefined;
}

/**
 * Whether the text the file starts with reads as HTML to a browser that
 * sniffs (the WHATWG sniffing patterns: a tag such as `<html`, `<script`,
 * `<iframe` or a comment opening the text, after a byte order mark and
 * whitespace), in UTF-8 or UTF-16.
 */
function looksLikeHtml(head: Uint8Array): boolean {
  const data = Buffer.from(head.buffer, head.byteOffset, head.byteLength);
  const texts = [data.toString('utf8')];
  if (startsWith(head, [0xff, 0xfe])) texts.push(data.toString('utf16le'));
  if (startsWith(head, [0xfe, 0xff])) {
    texts.push(Buffer.from(data).swap16().toString('utf16le'));
  }
  return texts.some((text) =>
    /^[\ufeff\ufffe\s]*<(?:!doctype\s+html|html|head|body|script|iframe|h1|div|font|table|a|style|title|b|br|p|!--|\?xml[^>]*>\s*<(?:html|!doctype\s+html))[\s>/]/i.test(
      text,
    ),
  );
}

export interface AttachmentType {
  /** The media type stored and sent with the file. */
  readonly mediaType: string;
  /** The file name's extension (`.zip`), when it has one. */
  readonly extension?: string;
  /** The type the extension stands for, when it stands for a known one. */
  readonly named?: string;
  /** The type a signature in the bytes shows, when there is one. */
  readonly sniffed?: string;
}

/** Formats that are ZIP files inside: their bytes show `application/zip`. */
const ZIP_CONTAINERS: ReadonlySet<string> = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/java-archive',
  'application/vnd.android.package-archive',
  'application/vnd.ms-word.document.macroenabled.12',
  'application/vnd.ms-word.template.macroenabled.12',
  'application/vnd.ms-excel.sheet.macroenabled.12',
  'application/vnd.ms-excel.template.macroenabled.12',
  'application/vnd.ms-excel.addin.macroenabled.12',
  'application/vnd.ms-excel.sheet.binary.macroenabled.12',
  'application/vnd.ms-powerpoint.presentation.macroenabled.12',
  'application/vnd.ms-powerpoint.template.macroenabled.12',
  'application/vnd.ms-powerpoint.addin.macroenabled.12',
  'application/vnd.ms-powerpoint.slideshow.macroenabled.12',
]);

/** Formats that are OLE compound files inside: legacy Office documents and Windows installers. */
const OLE_CONTAINERS: ReadonlySet<string> = new Set([
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/x-msi',
]);

/**
 * Whether bytes of type `sniffed` can be a file of type `named`: the same
 * type, a ZIP container (`.docx`) whose bytes show a ZIP, or an OLE one
 * (`.doc`, `.msi`) whose bytes show an OLE compound file.
 */
const agrees = (named: string, sniffed: string) =>
  named === sniffed ||
  (sniffed === 'application/zip' && ZIP_CONTAINERS.has(named)) ||
  (sniffed === 'application/x-ole-storage' && OLE_CONTAINERS.has(named));

/**
 * The type a file name's extension stands for: its known type, else
 * `application/octet-stream` (an unknown or no extension claims nothing).
 */
export const typeOfName = (fileName: string | undefined): string => {
  const extension = extensionOf(fileName);
  return (
    (extension === undefined ? undefined : BY_EXTENSION[extension]) ??
    'application/octet-stream'
  );
};

/**
 * The media type of an attachment upload from its first bytes (at least
 * `ATTACHMENT_SNIFF_BYTES`, or all of a shorter file) and its file name: a
 * dangerous kind the bytes show wins over any name (`report.pdf` holding
 * HTML is HTML); else the extension's type; else the type the bytes show;
 * else `application/octet-stream`.
 */
export function attachmentType(
  head: Uint8Array,
  fileName: string | undefined,
): AttachmentType {
  const extension = extensionOf(fileName);
  const sniffed = sniffAttachmentType(head);
  const named = extension === undefined ? undefined : BY_EXTENSION[extension];
  // `.bin` claims nothing: it says no more than no extension.
  const claimed = named === 'application/octet-stream' ? undefined : named;
  // Dangerous bytes win over a name of another type; under their own
  // container's name (`.msi`, `.doc` of an OLE file) they keep that type.
  const mediaType =
    (sniffed !== undefined &&
    DANGEROUS_TYPES.has(sniffed) &&
    !(claimed !== undefined && agrees(claimed, sniffed))
      ? sniffed
      : (claimed ?? sniffed)) ?? 'application/octet-stream';
  return {
    mediaType,
    ...(extension !== undefined ? { extension } : {}),
    ...(claimed !== undefined ? { named: claimed } : {}),
    ...(sniffed !== undefined ? { sniffed } : {}),
  };
}

const matchesType = (rule: TypeRule, mediaType: string): boolean =>
  (rule.kind === 'type' && rule.type === mediaType) ||
  (rule.kind === 'family' && mediaType.startsWith(`${rule.top}/`));

const matches = (
  rules: readonly TypeRule[],
  mediaType: string,
  extension: string | undefined,
) =>
  rules.some(
    (rule) =>
      matchesType(rule, mediaType) ||
      (rule.kind === 'extension' && rule.extension === extension),
  );

/** Every type the file can be taken for: the stored one, the name's and the bytes'. */
const typesOf = (file: AttachmentType): string[] => [
  ...new Set(
    [file.mediaType, file.named, file.sniffed].filter(
      (type): type is string => type !== undefined,
    ),
  ),
];

/**
 * Whether an allow list takes the file: an entry naming its stored type,
 * or its extension where that extension stands for the stored type (or
 * for none, and the bytes show none either). So `.dat` on the list does
 * not take ZIP bytes named `data.dat`.
 */
const allowed = (allow: readonly TypeRule[], file: AttachmentType) =>
  allow.some((rule) => {
    if (rule.kind !== 'extension') return matchesType(rule, file.mediaType);
    if (rule.extension !== file.extension) return false;
    const named = BY_EXTENSION[rule.extension] ?? 'application/octet-stream';
    return agrees(named, file.mediaType) || agrees(file.mediaType, named);
  });

/** Why an attachment is refused, or `undefined` when it is taken. */
export type AttachmentRefusal =
  | { readonly reason: 'mismatch' }
  | { readonly reason: 'not-allowed' }
  | { readonly reason: 'denied' }
  | { readonly reason: 'dangerous' };

/**
 * Whether the rules take a file of this type. Refused, in this order: a
 * file whose bytes show a known type its extension does not stand for
 * (`mismatch`: PNG bytes named `.html`, HTML named `.json`); one the allow
 * list (when there is one) does not take, by its stored type or extension,
 * where the bytes' type must be taken too unless it is the ZIP a ZIP
 * container shows; one a deny list entry names by any type it can be
 * taken for (stored, named, sniffed) or its extension; and a dangerous one
 * unless opened.
 * A dangerous file is opened by an entry naming its media type (or its
 * top-level type), or by one naming its extension when that extension
 * stands for exactly this media type: `.html` and `text/html` both open
 * `page.html`, but neither opens an executable named `page.html`, whose
 * bytes make it `application/vnd.microsoft.portable-executable`.
 */
export function refusal(
  file: AttachmentType,
  rules: AttachmentTypeRules,
): AttachmentRefusal | undefined {
  if (
    file.named !== undefined &&
    file.sniffed !== undefined &&
    !agrees(file.named, file.sniffed)
  ) {
    return { reason: 'mismatch' };
  }
  if (rules.allow !== undefined && !allowed(rules.allow, file)) {
    return { reason: 'not-allowed' };
  }
  if (typesOf(file).some((type) => matches(rules.deny, type, file.extension))) {
    return { reason: 'denied' };
  }
  const dangerous =
    DANGEROUS_TYPES.has(file.mediaType) ||
    (file.extension !== undefined && DANGEROUS_EXTENSIONS.has(file.extension));
  if (!dangerous) return undefined;
  const opened = rules.open.some(
    (rule) =>
      matchesType(rule, file.mediaType) ||
      (rule.kind === 'extension' &&
        rule.extension === file.extension &&
        (BY_EXTENSION[rule.extension] ?? 'application/octet-stream') ===
          file.mediaType),
  );
  return opened ? undefined : { reason: 'dangerous' };
}

/**
 * Whether a file of `storedType` may be offered for download under
 * `fileName`: a dangerous extension (`.html`, `.svg`, `.exe`) only when it
 * stands for exactly the stored type, any other only when it stands for
 * the stored type (a ZIP container for a ZIP and back) or for no known
 * type, or the stored type is none (`application/octet-stream`). So a block in content cannot label an allowed file as `evil.html`.
 */
export function nameFits(fileName: string, storedType: string): boolean {
  const extension = extensionOf(fileName);
  if (extension === undefined) return true;
  const named = typeOfName(fileName);
  if (DANGEROUS_EXTENSIONS.has(extension) || DANGEROUS_TYPES.has(named)) {
    return BY_EXTENSION[extension] === storedType;
  }
  return (
    named === 'application/octet-stream' ||
    // Bytes of no known type, served as such: a harmless name may say more.
    storedType === 'application/octet-stream' ||
    agrees(named, storedType) ||
    agrees(storedType, named)
  );
}
