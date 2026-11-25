import type { Schema } from '../api';

/** One check as the API sends it. */
export type CheckItem = Schema<'CheckResource'>;
export type CheckCode = CheckItem['attributes']['code'];
export type CheckSeverity = CheckItem['attributes']['severity'];
export type CheckSubject = CheckItem['attributes']['subject'];

export const CHECK_SEVERITIES: readonly CheckSeverity[] = [
  'blocking',
  'warning',
];

/** Page sizes offered under the list; the first is the default. */
export const CHECK_PAGE_SIZES = [50, 100, 200] as const;

/**
 * The checks about a derived manual's rule (#451): the manual builder shows them beside the rule,
 * and their links open it there (#669).
 */
export const DERIVED_CHECKS: ReadonlySet<string> = new Set<CheckCode>([
  'unknown-source-manual',
  'derived-source',
  'no-gathered-types',
  'derived-audience-wider',
  'safety-module-excluded',
  'unknown-excluded-module',
  'empty-derived-manual',
]);

/** Manual IDs are slugs (the API refuses anything else). */
export const MANUAL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** What each code is called in the Check column (a translation key). */
export const CHECK_TITLES: Readonly<Record<CheckCode, string>> = {
  'invalid-module': 'editor.checks.codes.invalid-module.title',
  'invalid-manifest': 'editor.checks.codes.invalid-manifest.title',
  'unknown-module-type': 'editor.checks.codes.unknown-module-type.title',
  'unknown-audience': 'editor.checks.codes.unknown-audience.title',
  'unknown-language': 'editor.checks.codes.unknown-language.title',
  'unknown-facet': 'editor.checks.codes.unknown-facet.title',
  'unknown-facet-value': 'editor.checks.codes.unknown-facet-value.title',
  'unknown-safety-symbol': 'editor.checks.codes.unknown-safety-symbol.title',
  'unknown-text-attribute': 'editor.checks.codes.unknown-text-attribute.title',
  'placeholder-in-module': 'editor.checks.codes.placeholder-in-module.title',
  'unknown-placeholder': 'editor.checks.codes.unknown-placeholder.title',
  'unknown-variant-attribute':
    'editor.checks.codes.unknown-variant-attribute.title',
  'unknown-variant-value': 'editor.checks.codes.unknown-variant-value.title',
  'version-compare-on-enum':
    'editor.checks.codes.version-compare-on-enum.title',
  'invalid-version-value': 'editor.checks.codes.invalid-version-value.title',
  'missing-variant-attribute':
    'editor.checks.codes.missing-variant-attribute.title',
  'missing-text-attribute': 'editor.checks.codes.missing-text-attribute.title',
  'pdf-accessibility': 'editor.checks.codes.pdf-accessibility.title',
  'pdf-not-checked': 'editor.checks.codes.pdf-not-checked.title',
  'pdf-layout-not-checked': 'editor.checks.codes.pdf-layout-not-checked.title',
  'page-design-overflow': 'editor.checks.codes.page-design-overflow.title',
  'page-design-template-error':
    'editor.checks.codes.page-design-template-error.title',
  'page-design-unknown-template':
    'editor.checks.codes.page-design-unknown-template.title',
  'running-head-truncated': 'editor.checks.codes.running-head-truncated.title',
  'callout-label-overflow': 'editor.checks.codes.callout-label-overflow.title',
  'safety-message-split': 'editor.checks.codes.safety-message-split.title',
  'page-design-missing-value':
    'editor.checks.codes.page-design-missing-value.title',
  'page-design-missing-text-attribute':
    'editor.checks.codes.page-design-missing-text-attribute.title',
  'page-design-missing-variant-attribute':
    'editor.checks.codes.page-design-missing-variant-attribute.title',
  passthrough: 'editor.checks.codes.passthrough.title',
  'empty-table': 'editor.checks.codes.empty-table.title',
  'snippet-too-large': 'editor.checks.codes.snippet-too-large.title',
  'inconsistent-variants': 'editor.checks.codes.inconsistent-variants.title',
  'above-audience': 'editor.checks.codes.above-audience.title',
  'delivery-access-capped': 'editor.checks.codes.delivery-access-capped.title',
  'missing-manufacturer': 'editor.checks.codes.missing-manufacturer.title',
  'missing-module': 'editor.checks.codes.missing-module.title',
  'module-cycle': 'editor.checks.codes.module-cycle.title',
  'module-ref-unknown-block':
    'editor.checks.codes.module-ref-unknown-block.title',
  'expansion-too-large': 'editor.checks.codes.expansion-too-large.title',
  'chunk-set-too-large': 'editor.checks.codes.chunk-set-too-large.title',
  'chunks-not-checked': 'editor.checks.codes.chunks-not-checked.title',
  'xref-unknown-module': 'editor.checks.codes.xref-unknown-module.title',
  'xref-unknown-block': 'editor.checks.codes.xref-unknown-block.title',
  'xref-outside-manual': 'editor.checks.codes.xref-outside-manual.title',
  'deprecated-module': 'editor.checks.codes.deprecated-module.title',
  'unknown-term': 'editor.checks.codes.unknown-term.title',
  'deprecated-term': 'editor.checks.codes.deprecated-term.title',
  'unknown-page-design': 'editor.checks.codes.unknown-page-design.title',
  'page-design-missing-translation':
    'editor.checks.codes.page-design-missing-translation.title',
  'page-design-dropped-text':
    'editor.checks.codes.page-design-dropped-text.title',
  'page-design-missing-font':
    'editor.checks.codes.page-design-missing-font.title',
  'missing-cover-image': 'editor.checks.codes.missing-cover-image.title',
  'missing-cover-alt': 'editor.checks.codes.missing-cover-alt.title',
  'missing-source-title': 'editor.checks.codes.missing-source-title.title',
  'unknown-cover-variant': 'editor.checks.codes.unknown-cover-variant.title',
  'unknown-source-manual': 'editor.checks.codes.unknown-source-manual.title',
  'derived-source': 'editor.checks.codes.derived-source.title',
  'no-gathered-types': 'editor.checks.codes.no-gathered-types.title',
  'safety-module-excluded': 'editor.checks.codes.safety-module-excluded.title',
  'safety-notice-excluded': 'editor.checks.codes.safety-notice-excluded.title',
  'unknown-excluded-module':
    'editor.checks.codes.unknown-excluded-module.title',
  'empty-derived-manual': 'editor.checks.codes.empty-derived-manual.title',
  'derived-audience-wider': 'editor.checks.codes.derived-audience-wider.title',
  'update-step-version': 'editor.checks.codes.update-step-version.title',
  'update-step-outside-versions':
    'editor.checks.codes.update-step-outside-versions.title',
  'update-step-phase': 'editor.checks.codes.update-step-phase.title',
  'page-design-region-languages-differ':
    'editor.checks.codes.page-design-region-languages-differ.title',
  'unknown-replacement': 'editor.checks.codes.unknown-replacement.title',
  'address-taken': 'editor.checks.codes.address-taken.title',
  'unknown-callout': 'editor.checks.codes.unknown-callout.title',
  'hidden-callout': 'editor.checks.codes.hidden-callout.title',
  'unknown-callout-style': 'editor.checks.codes.unknown-callout-style.title',
  'missing-image': 'editor.checks.codes.missing-image.title',
  'missing-attachment': 'editor.checks.codes.missing-attachment.title',
  'attachment-file-name': 'editor.checks.codes.attachment-file-name.title',
  'missing-translation': 'editor.checks.codes.missing-translation.title',
  'outdated-translation': 'editor.checks.codes.outdated-translation.title',
  'missing-label': 'editor.checks.codes.missing-label.title',
  'forbidden-term': 'editor.checks.codes.forbidden-term.title',
  'style-rule': 'editor.checks.codes.style-rule.title',
  'writing-not-checked': 'editor.checks.codes.writing-not-checked.title',
};

/** What each code means, without naming anything (a translation key). */
const CHECK_DETAILS: Readonly<Record<CheckCode, string>> = {
  'invalid-module': 'editor.checks.codes.invalid-module.detail',
  'invalid-manifest': 'editor.checks.codes.invalid-manifest.detail',
  'unknown-module-type': 'editor.checks.codes.unknown-module-type.detail',
  'unknown-audience': 'editor.checks.codes.unknown-audience.detail',
  'unknown-language': 'editor.checks.codes.unknown-language.detail',
  'unknown-facet': 'editor.checks.codes.unknown-facet.detail',
  'unknown-facet-value': 'editor.checks.codes.unknown-facet-value.detail',
  'unknown-safety-symbol': 'editor.checks.codes.unknown-safety-symbol.detail',
  'unknown-text-attribute': 'editor.checks.codes.unknown-text-attribute.detail',
  'placeholder-in-module': 'editor.checks.codes.placeholder-in-module.detail',
  'unknown-placeholder': 'editor.checks.codes.unknown-placeholder.detail',
  'unknown-variant-attribute':
    'editor.checks.codes.unknown-variant-attribute.detail',
  'unknown-variant-value': 'editor.checks.codes.unknown-variant-value.detail',
  'version-compare-on-enum':
    'editor.checks.codes.version-compare-on-enum.detail',
  'invalid-version-value': 'editor.checks.codes.invalid-version-value.detail',
  'missing-variant-attribute':
    'editor.checks.codes.missing-variant-attribute.detail',
  'missing-text-attribute': 'editor.checks.codes.missing-text-attribute.detail',
  'pdf-accessibility': 'editor.checks.codes.pdf-accessibility.detail',
  'pdf-not-checked': 'editor.checks.codes.pdf-not-checked.detail',
  'pdf-layout-not-checked': 'editor.checks.codes.pdf-layout-not-checked.detail',
  'page-design-overflow': 'editor.checks.codes.page-design-overflow.detail',
  'page-design-template-error':
    'editor.checks.codes.page-design-template-error.detail',
  'page-design-unknown-template':
    'editor.checks.codes.page-design-unknown-template.detail',
  'running-head-truncated': 'editor.checks.codes.running-head-truncated.detail',
  'callout-label-overflow': 'editor.checks.codes.callout-label-overflow.detail',
  'safety-message-split': 'editor.checks.codes.safety-message-split.detail',
  'page-design-missing-value':
    'editor.checks.codes.page-design-missing-value.detail',
  'page-design-missing-text-attribute':
    'editor.checks.codes.page-design-missing-text-attribute.detail',
  'page-design-missing-variant-attribute':
    'editor.checks.codes.page-design-missing-variant-attribute.detail',
  passthrough: 'editor.checks.codes.passthrough.detail',
  'empty-table': 'editor.checks.codes.empty-table.detail',
  'snippet-too-large': 'editor.checks.codes.snippet-too-large.detail',
  'inconsistent-variants': 'editor.checks.codes.inconsistent-variants.detail',
  'above-audience': 'editor.checks.codes.above-audience.detail',
  'delivery-access-capped': 'editor.checks.codes.delivery-access-capped.detail',
  'missing-manufacturer': 'editor.checks.codes.missing-manufacturer.detail',
  'missing-module': 'editor.checks.codes.missing-module.detail',
  'module-cycle': 'editor.checks.codes.module-cycle.detail',
  'module-ref-unknown-block':
    'editor.checks.codes.module-ref-unknown-block.detail',
  'expansion-too-large': 'editor.checks.codes.expansion-too-large.detail',
  'chunk-set-too-large': 'editor.checks.codes.chunk-set-too-large.detail',
  'chunks-not-checked': 'editor.checks.codes.chunks-not-checked.detail',
  'xref-unknown-module': 'editor.checks.codes.xref-unknown-module.detail',
  'xref-unknown-block': 'editor.checks.codes.xref-unknown-block.detail',
  'xref-outside-manual': 'editor.checks.codes.xref-outside-manual.detail',
  'deprecated-module': 'editor.checks.codes.deprecated-module.detail',
  'unknown-term': 'editor.checks.codes.unknown-term.detail',
  'deprecated-term': 'editor.checks.codes.deprecated-term.detail',
  'unknown-page-design': 'editor.checks.codes.unknown-page-design.detail',
  'page-design-missing-translation':
    'editor.checks.codes.page-design-missing-translation.detail',
  'page-design-dropped-text':
    'editor.checks.codes.page-design-dropped-text.detail',
  'page-design-missing-font':
    'editor.checks.codes.page-design-missing-font.detail',
  'missing-cover-image': 'editor.checks.codes.missing-cover-image.detail',
  'missing-cover-alt': 'editor.checks.codes.missing-cover-alt.detail',
  'missing-source-title': 'editor.checks.codes.missing-source-title.detail',
  'unknown-cover-variant': 'editor.checks.codes.unknown-cover-variant.detail',
  'unknown-source-manual': 'editor.checks.codes.unknown-source-manual.detail',
  'derived-source': 'editor.checks.codes.derived-source.detail',
  'no-gathered-types': 'editor.checks.codes.no-gathered-types.detail',
  'safety-module-excluded': 'editor.checks.codes.safety-module-excluded.detail',
  'safety-notice-excluded': 'editor.checks.codes.safety-notice-excluded.detail',
  'unknown-excluded-module':
    'editor.checks.codes.unknown-excluded-module.detail',
  'empty-derived-manual': 'editor.checks.codes.empty-derived-manual.detail',
  'derived-audience-wider': 'editor.checks.codes.derived-audience-wider.detail',
  'update-step-version': 'editor.checks.codes.update-step-version.detail',
  'update-step-outside-versions':
    'editor.checks.codes.update-step-outside-versions.detail',
  'update-step-phase': 'editor.checks.codes.update-step-phase.detail',
  'page-design-region-languages-differ':
    'editor.checks.codes.page-design-region-languages-differ.detail',
  'unknown-replacement': 'editor.checks.codes.unknown-replacement.detail',
  'address-taken': 'editor.checks.codes.address-taken.detail',
  'unknown-callout': 'editor.checks.codes.unknown-callout.detail',
  'hidden-callout': 'editor.checks.codes.hidden-callout.detail',
  'unknown-callout-style': 'editor.checks.codes.unknown-callout-style.detail',
  'missing-image': 'editor.checks.codes.missing-image.detail',
  'missing-attachment': 'editor.checks.codes.missing-attachment.detail',
  'attachment-file-name': 'editor.checks.codes.attachment-file-name.detail',
  'missing-translation': 'editor.checks.codes.missing-translation.detail',
  'outdated-translation': 'editor.checks.codes.outdated-translation.detail',
  'missing-label': 'editor.checks.codes.missing-label.detail',
  'forbidden-term': 'editor.checks.codes.forbidden-term.detail',
  'style-rule': 'editor.checks.codes.style-rule.detail',
  'writing-not-checked': 'editor.checks.codes.writing-not-checked.detail',
};

/** The Details text of a page design's check that names what it is about (#554). */
const DESIGN_NAMED = {
  'page-design-missing-value': 'editor.checks.named.page-design-missing-value',
  'page-design-missing-text-attribute':
    'editor.checks.named.page-design-missing-text-attribute',
  'page-design-missing-variant-attribute':
    'editor.checks.named.page-design-missing-variant-attribute',
  'page-design-missing-translation':
    'editor.checks.named.page-design-missing-translation',
  'page-design-dropped-text': 'editor.checks.named.page-design-dropped-text',
  'page-design-missing-font': 'editor.checks.named.page-design-missing-font',
} as const satisfies Partial<Record<CheckCode, string>>;

/** A translation key and its parameters. */
export interface Text {
  readonly key: string;
  readonly params?: Record<string, string>;
}

/**
 * The Details column: what the check names (a module, a block, a language) when the API names
 * it, else what the code means. `languageName` turns a language tag into its name.
 */
export function detailOf(
  check: CheckItem,
  languageName: (lang: string) => string,
): Text {
  const { code, params } = check.attributes;
  const module = params['module'];
  const block = params['block'];
  const lang = params['lang'];
  switch (code) {
    case 'missing-module':
      if (module) {
        return {
          key: 'editor.checks.named.missing-module',
          params: { module },
        };
      }
      break;
    case 'xref-unknown-module':
      if (module) {
        return {
          key: 'editor.checks.named.xref-unknown-module',
          params: { module },
        };
      }
      break;
    case 'xref-unknown-block':
      if (module && block) {
        return {
          key: 'editor.checks.named.xref-unknown-block',
          params: { module, block },
        };
      }
      break;
    case 'module-ref-unknown-block':
      if (module && block) {
        return {
          key: 'editor.checks.named.module-ref-unknown-block',
          params: { module, block },
        };
      }
      break;
    case 'xref-outside-manual':
      if (module) {
        return {
          key: 'editor.checks.named.xref-outside-manual',
          params: { module },
        };
      }
      break;
    case 'deprecated-module': {
      const replacedBy = params['replacedBy'];
      if (module) {
        return replacedBy
          ? {
              key: 'editor.checks.named.deprecated-module-replaced',
              params: { module, replacedBy },
            }
          : {
              key: 'editor.checks.named.deprecated-module',
              params: { module },
            };
      }
      break;
    }
    case 'unknown-term': {
      const term = params['term'];
      if (term) {
        return { key: 'editor.checks.named.unknown-term', params: { term } };
      }
      break;
    }
    case 'deprecated-term': {
      const term = params['term'];
      const replacedBy = params['replacedBy'];
      if (term) {
        return replacedBy
          ? {
              key: 'editor.checks.named.deprecated-term-replaced',
              params: { term, replacedBy },
            }
          : { key: 'editor.checks.named.deprecated-term', params: { term } };
      }
      break;
    }
    case 'unknown-page-design': {
      const design = params['design'];
      if (design) {
        return {
          key:
            params['from'] === 'manual'
              ? 'editor.checks.named.unknown-page-design-manual'
              : 'editor.checks.named.unknown-page-design-config',
          params: { design },
        };
      }
      break;
    }
    case 'page-design-missing-value':
    case 'page-design-missing-text-attribute':
    case 'page-design-missing-variant-attribute': {
      // What the design names, where in it (#554).
      const design = params['design'];
      const at = params['at'];
      const name = params['name'];
      if (design && at && name) {
        return { key: DESIGN_NAMED[code], params: { design, at, name } };
      }
      break;
    }
    case 'page-design-missing-translation':
    case 'page-design-dropped-text':
    case 'page-design-missing-font': {
      const design = params['design'];
      const at = params['at'];
      if (design && at) {
        return { key: DESIGN_NAMED[code], params: { design, at } };
      }
      break;
    }
    case 'page-design-template-error': {
      // Where the template does not compile (#396): its file, line and column, and why.
      const template = params['template'];
      const file = params['file'];
      const problem = params['problem'];
      if (template && file && problem) {
        return {
          key: 'editor.checks.named.page-design-template-error',
          params: {
            template,
            file,
            line: params['line'] ?? '0',
            column: params['column'] ?? '0',
            problem,
          },
        };
      }
      break;
    }
    case 'page-design-unknown-template': {
      const design = params['design'];
      const template = params['template'];
      if (design && template) {
        return {
          key: 'editor.checks.named.page-design-unknown-template',
          params: { design, template },
        };
      }
      break;
    }
    case 'page-design-region-languages-differ': {
      const design = params['design'];
      const at = params['at'];
      const name = params['name'];
      if (design && at && name) {
        return {
          key: 'editor.checks.named.page-design-region-languages-differ',
          params: { design, at, language: languageName(name) },
        };
      }
      break;
    }
    case 'unknown-replacement': {
      const replacedBy = params['replacedBy'];
      if (replacedBy) {
        return {
          key: 'editor.checks.named.unknown-replacement',
          params: { replacedBy },
        };
      }
      break;
    }
    case 'address-taken': {
      const address = params['address'];
      const manual = params['manual'];
      if (address && manual) {
        return {
          // This manual's address is the other's ID, or the other has this one's ID as its.
          key:
            address === manual
              ? 'editor.checks.named.address-taken-own'
              : 'editor.checks.named.address-taken-other',
          params: { address, manual },
        };
      }
      break;
    }
    case 'delivery-access-capped': {
      const access = params['access'];
      const maxAccess = params['maxAccess'];
      if (access && maxAccess) {
        return {
          key: 'editor.checks.named.delivery-access-capped',
          params: { access, maxAccess },
        };
      }
      break;
    }
    case 'missing-translation':
      if (lang) {
        return {
          key: 'editor.checks.named.missing-translation',
          params: { language: languageName(lang) },
        };
      }
      break;
    case 'pdf-accessibility': {
      // The renderer's reason, in English as it gives it.
      const problem = params['problem'];
      if (problem) {
        return {
          key: 'editor.checks.named.pdf-accessibility',
          params: { problem },
        };
      }
      break;
    }
    case 'outdated-translation': {
      // At a manual (#656): its cover images' text, or its page design's region text.
      const count = params['blocks'];
      const design = params['design'];
      if (lang && count && design) {
        return {
          key: 'editor.checks.named.outdated-design-translation',
          params: { design, count, language: languageName(lang) },
        };
      }
      if (lang && count && params['at'] === 'coverImage') {
        return {
          key: 'editor.checks.named.outdated-cover-translation',
          params: { count, language: languageName(lang) },
        };
      }
      break;
    }
    case 'forbidden-term': {
      // The writing checks (#55): what was found, the term, and what to write instead.
      const text = params['text'];
      const term = params['term'];
      const replacement = params['replacement'];
      if (text && term) {
        if (params['status'] === 'deprecated') {
          return replacement
            ? {
                key: 'editor.checks.named.forbidden-term-deprecated-replaced',
                params: { text, term, replacement },
              }
            : {
                key: 'editor.checks.named.forbidden-term-deprecated',
                params: { text, term },
              };
        }
        if (replacement) {
          return {
            key: 'editor.checks.named.forbidden-term',
            params: { text, term, replacement },
          };
        }
      }
      break;
    }
    case 'style-rule': {
      // A sentence too long, or a configured rule's own message (in the language it is for).
      const text = params['text'];
      const words = params['words'];
      const max = params['max'];
      if (params['rule'] === 'max-sentence-words' && words && max) {
        return {
          key: 'editor.checks.named.style-rule-sentence',
          params: { words, max },
        };
      }
      const message = params['message'];
      const replacement = params['replacement'];
      if (text && message) {
        return replacement
          ? {
              key: 'editor.checks.named.style-rule-replaced',
              params: { text, message, replacement },
            }
          : {
              key: 'editor.checks.named.style-rule',
              params: { text, message },
            };
      }
      break;
    }
    case 'writing-not-checked': {
      const key = {
        chars: 'editor.checks.named.writing-not-checked-chars',
        findings: 'editor.checks.named.writing-not-checked-findings',
        steps: 'editor.checks.named.writing-not-checked-steps',
      }[params['stopped'] ?? ''];
      if (key) return { key };
      break;
    }
    case 'missing-label':
      if (lang) {
        return {
          key: 'editor.checks.named.missing-label',
          params: { language: languageName(lang) },
        };
      }
      break;
  }
  return { key: CHECK_DETAILS[code] };
}

/** The checks of one subject on the page, in the API's order. */
export interface CheckGroup {
  /** Stable across pages: `manual/<id>`, `module/<lang>/<id>` or `design/<id>`. */
  readonly key: string;
  readonly subject: CheckSubject;
  /** The subject's title as the reader reads it, or null. */
  readonly title: string | null;
  readonly checks: readonly CheckItem[];
  readonly blocking: number;
  readonly warning: number;
}

export function subjectKey(subject: CheckSubject): string {
  switch (subject.type) {
    case 'manual':
      return `manual/${subject.manualId}`;
    case 'design':
      return `design/${subject.designId}`;
    default:
      return `module/${subject.lang}/${subject.moduleId}`;
  }
}

/**
 * The page's checks by subject (the API sends them ordered by subject, so a group is a run;
 * a subject seen again later still joins its group).
 */
export function groupChecks(items: readonly CheckItem[]): CheckGroup[] {
  const groups = new Map<
    string,
    { subject: CheckSubject; title: string | null; checks: CheckItem[] }
  >();
  for (const item of items) {
    const key = subjectKey(item.attributes.subject);
    let group = groups.get(key);
    if (!group) {
      group = {
        subject: item.attributes.subject,
        title: item.meta.title,
        checks: [],
      };
      groups.set(key, group);
    }
    group.checks.push(item);
  }
  return [...groups].map(([key, { subject, title, checks }]) => ({
    key,
    subject,
    title,
    checks,
    blocking: checks.filter((c) => c.attributes.severity === 'blocking').length,
    warning: checks.filter((c) => c.attributes.severity === 'warning').length,
  }));
}

/**
 * Where a check is fixed: the module editor at its block, the manual, a derived manual's rule,
 * or the page design's screen (#396).
 */
export interface FixLink {
  readonly commands: readonly string[];
  /** Query parameters of its own (the change set is added by the page). */
  readonly query: Readonly<Record<string, string>>;
}

export function fixLinkOf(check: CheckItem): FixLink {
  const { subject, blockId, code } = check.attributes;
  if (subject.type === 'manual') {
    // A derived manual's checks are fixed in its rule (#669): the builder shows it.
    return {
      commands: ['/manuals', subject.manualId],
      query: DERIVED_CHECKS.has(code) ? { section: 'rule' } : {},
    };
  }
  if (subject.type === 'design') {
    return { commands: ['/admin/page-designs', subject.designId], query: {} };
  }
  return {
    commands: ['/content', subject.lang, subject.moduleId],
    query: blockId ? { block: blockId } : {},
  };
}
