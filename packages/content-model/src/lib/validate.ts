import type { Block } from './blocks.js';
import type { Condition } from './condition.js';
import type { ProjectConfig } from './config.js';
import type { Inline } from './inline.js';
import { Version } from './condition.js';
import type { Deprecation } from './deprecation.js';
import type { CoverImageAlt, Manifest, ManifestEntry } from './manifest.js';
import type { Module } from './module.js';
import { blocksTooLargeForSnippet, isSnippetType } from './snippet.js';
import { imagesById } from './callouts.js';
import { walk } from './walk.js';
import { isPlaceholderKey, PLACEHOLDER_KEYS } from './placeholder.js';
import { type LocalizedText, textIn } from './localized-text.js';
import { compareVersions } from './condition-eval.js';
import {
  isUpdatePhase,
  UPDATE_PHASES,
  validStepVersion,
} from './update-guide.js';

export interface Issue {
  severity: 'error' | 'warning';
  code: IssueCode;
  message: string;
  /** ID of the block or item the issue is about; absent for module metadata. */
  at?: string;
}

export type IssueCode =
  | 'unknown-module-type'
  | 'unknown-audience'
  | 'unknown-language'
  | 'unknown-facet'
  | 'unknown-facet-value'
  | 'unknown-safety-symbol'
  | 'unknown-text-attribute'
  | 'unknown-variant-attribute'
  | 'unknown-variant-value'
  | 'version-compare-on-enum'
  | 'invalid-version-value'
  | 'passthrough'
  | 'empty-table'
  | 'snippet-too-large'
  | 'inconsistent-variants'
  /** A manual gives a cover image to a variant it does not build (#394): it is never shown. */
  | 'unknown-cover-variant'
  | 'missing-cover-alt'
  /** A manual's or group's title written per language without the source language's (#731). */
  | 'missing-source-title'
  | 'unknown-replacement'
  | 'unknown-callout-style'
  | 'unknown-callout'
  | 'placeholder-in-module'
  | 'unknown-placeholder'
  /** A derived manual's source manual is not there or cannot be read (#451, `deriveManifest`). */
  | 'unknown-source-manual'
  /** A derived manual's source is a derived manual itself, or itself. */
  | 'derived-source'
  /** A derived manual's rule names no module types and none is configured as safety. */
  | 'no-gathered-types'
  /** A module of a safety type in a derived manual's source that its rule leaves out. */
  | 'safety-module-excluded'
  /** A safety notice of a derived manual's source that its notice gathering leaves out (#670). */
  | 'safety-notice-excluded'
  /** A derived manual's rule excludes a module its source does not include. */
  | 'unknown-excluded-module'
  /** A derived manual's rule gathers no module. */
  | 'empty-derived-manual'
  /** A derived manual for a wider audience than its source manual. */
  | 'derived-audience-wider'
  /** An update guide's step without a version, or with one that is not a dotted version (#906). */
  | 'update-step-version'
  /** An update guide's step at a version no jump between the guide's versions crosses (#906). */
  | 'update-step-outside-versions'
  /** An update guide's step whose phase is not `before`, `during` or `after` (#906). */
  | 'update-step-phase';

/**
 * Checks a module (already parsed by `Module`) against the project
 * configuration. Structural rules (including table geometry) live in the
 * schema; this covers what depends on config. References to other modules
 * are checked at repository level, not here.
 */
export function validateModule(module: Module, config: ProjectConfig): Issue[] {
  const issues: Issue[] = [];
  const error = (code: IssueCode, message: string, at?: string) =>
    issues.push({ severity: 'error', code, message, at });

  const { meta } = module;
  if (!config.moduleTypes.some((t) => t.id === meta.type)) {
    error(
      'unknown-module-type',
      `module type "${meta.type}" is not configured`,
    );
  }
  if (
    meta.audience !== undefined &&
    !config.audiences.some((a) => a.id === meta.audience)
  ) {
    error('unknown-audience', `audience "${meta.audience}" is not configured`);
  }
  if (
    meta.lang !== config.languages.source &&
    !config.languages.targets.includes(meta.lang)
  ) {
    error(
      'unknown-language',
      `language "${meta.lang}" is neither the source nor a target language`,
    );
  }
  for (const [facetId, values] of Object.entries(meta.facets)) {
    const facet = config.facets.find((f) => f.id === facetId);
    if (!facet) {
      error('unknown-facet', `facet "${facetId}" is not configured`);
      continue;
    }
    for (const value of values) {
      if (!facet.values.some((v) => v.id === value)) {
        error(
          'unknown-facet-value',
          `"${value}" is not a value of facet "${facetId}"`,
        );
      }
    }
  }

  const replacement = replacementIssue(module.id, meta.deprecated, 'module');
  if (replacement) issues.push(replacement);

  pushAll(
    issues,
    blockIssues(module.blocks, config, { placeholders: 'refuse' }),
  );
  // A snippet is one or a few blocks of wording: a heading or another module in it is a sign it
  // should be a module of another type. Worth a look, never more.
  if (isSnippetType(config, meta.type)) {
    for (const block of blocksTooLargeForSnippet(module.blocks)) {
      issues.push({
        severity: 'warning',
        code: 'snippet-too-large',
        message:
          block.type === 'section'
            ? 'a snippet holds a section; snippets are one or a few blocks of text'
            : 'a snippet holds a module reference; snippets are one or a few blocks of text',
        at: block.id,
      });
    }
  }
  return issues;
}

/**
 * Checks blocks against the configuration: text attributes, safety symbols and variant conditions
 * are configured, and placeholders (`placeholders`): refused in a module (`placeholder-in-module`),
 * or, in a page design's text, one of `PLACEHOLDER_KEYS` (`unknown-placeholder`). Also warns at
 * verbatim imported content and an empty table. Issues name the block or item in `at`.
 */
export function blockIssues(
  blocks: readonly Block[],
  config: ProjectConfig,
  options: { placeholders: 'refuse' | 'check' },
): Issue[] {
  const issues: Issue[] = [];
  const error = (code: IssueCode, message: string, at?: string) =>
    issues.push({ severity: 'error', code, message, at });
  // A callout reference names an image among the same blocks (#498).
  const images = imagesById(blocks);
  for (const { kind, node } of walk(blocks)) {
    if (kind === 'item') {
      checkInline(node.content, node.id);
    } else if (kind === 'block') {
      checkBlock(node);
    }
  }
  return issues;

  function checkBlock(block: Block): void {
    switch (block.type) {
      case 'paragraph':
        checkInline(block.content, block.id);
        break;
      case 'section':
        checkInline(block.title, block.id);
        break;
      case 'procedure':
        if (block.title) checkInline(block.title, block.id);
        break;
      case 'table':
        if (block.title) checkInline(block.title, block.id);
        // Empty cells are fine (a table being filled in); a table with nothing in it at all is
        // worth a look, never more.
        if (
          block.rows.every((row) =>
            row.cells.every((c) => c.blocks.length === 0),
          )
        )
          issues.push({
            severity: 'warning',
            code: 'empty-table',
            message: 'every cell of this table is empty',
            at: block.id,
          });
        break;
      case 'image':
        if (block.title) checkInline(block.title, block.id);
        for (const callout of block.callouts ?? []) {
          checkInline(callout.legend, block.id);
          if (callout.when)
            pushAll(issues, conditionIssues(callout.when, config, block.id));
          if (
            callout.style !== undefined &&
            !(config.calloutStyles ?? []).some((s) => s.id === callout.style)
          ) {
            error(
              'unknown-callout-style',
              `callout style "${callout.style}" is not configured`,
              block.id,
            );
          }
        }
        break;
      case 'safety':
        checkInline(block.hazard, block.id);
        for (const symbol of block.symbols) {
          if (!config.safetySymbols.some((s) => s.id === symbol)) {
            error(
              'unknown-safety-symbol',
              `safety symbol "${symbol}" is not configured`,
              block.id,
            );
          }
        }
        break;
      case 'faq':
        checkInline(block.question, block.id);
        break;
      case 'variant':
        pushAll(issues, conditionIssues(block.when, config, block.id));
        break;
      case 'passthrough':
        issues.push({
          severity: 'warning',
          code: 'passthrough',
          message: `unmapped ${block.format} content kept verbatim; convert it to model blocks`,
          at: block.id,
        });
        break;
      case 'list':
      case 'admonition':
      case 'attachment':
      case 'moduleRef':
      case 'literal':
      case 'pageBreak':
        break;
      default:
        block satisfies never;
    }
  }

  function checkInline(content: readonly Inline[], at: string): void {
    for (const node of content) {
      if (node.type === 'placeholder') {
        if (options.placeholders === 'refuse') {
          error(
            'placeholder-in-module',
            `placeholder "${node.key}" in a module: placeholders belong in a page design's text`,
            at,
          );
        } else if (!isPlaceholderKey(node.key)) {
          error(
            'unknown-placeholder',
            `"${node.key}" is no placeholder; one of ${PLACEHOLDER_KEYS.join(', ')}`,
            at,
          );
        }
      }
      if (node.type === 'calloutRef') {
        const image = images.get(node.block);
        if (!image) {
          error(
            'unknown-callout',
            `refers to a callout on "${node.block}", which is no image of this module`,
            at,
          );
        } else if (!image.callouts?.some((c) => c.id === node.callout)) {
          error(
            'unknown-callout',
            `refers to the callout "${node.callout}", which image "${node.block}" does not have`,
            at,
          );
        }
      }
      if (
        node.type === 'attribute' &&
        !config.textAttributes.some((a) => a.id === node.name)
      ) {
        error(
          'unknown-text-attribute',
          `text attribute "${node.name}" is not configured`,
          at,
        );
      }
    }
  }
}

/** Checks a variant condition against the configured variant attributes. */
export function conditionIssues(
  condition: Condition,
  config: ProjectConfig,
  at?: string,
): Issue[] {
  switch (condition.op) {
    case 'all':
    case 'any':
      return condition.of.flatMap((c) => conditionIssues(c, config, at));
    case 'not':
      return conditionIssues(condition.of, config, at);
  }
  const issues: Issue[] = [];
  const error = (code: IssueCode, message: string) =>
    issues.push({ severity: 'error', code, message, at });
  const attr = config.variantAttributes.find((a) => a.id === condition.attr);
  if (!attr) {
    error(
      'unknown-variant-attribute',
      `variant attribute "${condition.attr}" is not configured`,
    );
  } else if (condition.op === 'cmp') {
    if (attr.kind === 'enum') {
      error(
        'version-compare-on-enum',
        `"${attr.id}" is not a version, so it can't be compared with ${condition.cmp}`,
      );
    } else {
      // The version it is compared with, as `Version` (the evaluator's form).
      pushAll(issues, variantValueIssues(attr.id, condition.value, config, at));
    }
  } else {
    for (const value of condition.values)
      pushAll(issues, variantValueIssues(attr.id, value, config, at));
  }
  return issues;
}

/** Checks one variant value (from a condition or a manifest's variant list) against the configuration. */
function variantValueIssues(
  attrId: string,
  value: string,
  config: ProjectConfig,
  at?: string,
): Issue[] {
  const attr = config.variantAttributes.find((a) => a.id === attrId);
  if (!attr) {
    return [
      {
        severity: 'error',
        code: 'unknown-variant-attribute',
        message: `variant attribute "${attrId}" is not configured`,
        at,
      },
    ];
  }
  if (attr.kind === 'enum' && !attr.values.some((v) => v.id === value)) {
    return [
      {
        severity: 'error',
        code: 'unknown-variant-value',
        message: `"${value}" is not a value of variant attribute "${attr.id}"`,
        at,
      },
    ];
  }
  if (attr.kind === 'version' && !Version.safeParse(value).success) {
    return [
      {
        severity: 'error',
        code: 'invalid-version-value',
        message: `"${value}" is not a version (variant attribute "${attr.id}")`,
        at,
      },
    ];
  }
  return [];
}

/**
 * Checks a manifest against the configuration: audience, variant values,
 * text attributes and every condition. Whether the listed modules exist is
 * checked when the manual is resolved.
 */
export function validateManifest(
  manifest: Manifest,
  config: ProjectConfig,
): Issue[] {
  const issues: Issue[] = [];
  if (
    manifest.audience !== undefined &&
    !config.audiences.some((a) => a.id === manifest.audience)
  ) {
    issues.push({
      severity: 'error',
      code: 'unknown-audience',
      message: `audience "${manifest.audience}" is not configured`,
    });
  }

  const keySets = new Set<string>();
  manifest.variants.forEach((variant, i) => {
    const at = `variant ${i + 1}`;
    keySets.add(Object.keys(variant).sort().join(','));
    for (const [key, value] of Object.entries(variant))
      pushAll(issues, variantValueIssues(key, value, config, at));
  });
  if (keySets.size > 1) {
    issues.push({
      severity: 'warning',
      code: 'inconsistent-variants',
      message:
        'variants set different attributes; conditions on a missing attribute count as false',
    });
  }

  for (const [name, value] of Object.entries(manifest.attributes)) {
    if (!config.textAttributes.some((a) => a.id === name)) {
      issues.push({
        severity: 'error',
        code: 'unknown-text-attribute',
        message: `text attribute "${name}" is not configured`,
        at: name,
      });
    }
    if (typeof value !== 'string') {
      for (const option of value)
        if (option.when)
          pushAll(issues, conditionIssues(option.when, config, name));
    }
  }

  // The cover image (#394): its alternative text in configured languages, each variant's own
  // for a variant the manual builds, once.
  const cover = manifest.coverImage;
  if (cover) {
    const languages = new Set([
      config.languages.source,
      ...config.languages.targets,
    ]);
    const altLanguages = (alt: CoverImageAlt, at: string) => {
      if (typeof alt === 'string') return;
      // Required in the source language: every language without its own falls back to it.
      if (alt[config.languages.source] === undefined) {
        issues.push({
          severity: 'error',
          code: 'missing-cover-alt',
          message: `the cover image's alternative text has no version in the source language "${config.languages.source}"`,
          at: `${at}.alt`,
        });
      }
      for (const lang of Object.keys(alt)) {
        if (!languages.has(lang)) {
          issues.push({
            severity: 'error',
            code: 'unknown-language',
            message: `language "${lang}" of the cover image's alternative text is neither the source nor a target language`,
            at: `${at}.alt.${lang}`,
          });
        }
      }
    };
    if (cover.default) altLanguages(cover.default.alt, 'coverImage.default');
    const built = new Set(manifest.variants.map(variantKey));
    const given = new Set<string>();
    cover.variants.forEach((entry, i) => {
      const at = `coverImage.variants.${i}`;
      altLanguages(entry.alt, at);
      const key = variantKey(entry.variant);
      if (!built.has(key) || given.has(key)) {
        issues.push({
          severity: 'warning',
          code: 'unknown-cover-variant',
          message: given.has(key)
            ? 'the cover image is given to a variant that has one before it; it is never shown'
            : 'the cover image is given to a variant the manual does not build; it is never shown',
          at,
        });
      }
      given.add(key);
    });
  }

  // The title and the groups' titles (#731): in configured languages, the source language's
  // among them when written per language.
  const configured = new Set([
    config.languages.source,
    ...config.languages.targets,
  ]);
  const titleLanguages = (text: LocalizedText, what: string, at: string) => {
    if (typeof text === 'string') return;
    if (text[config.languages.source] === undefined) {
      issues.push({
        severity: 'error',
        code: 'missing-source-title',
        message: `${what} has no version in the source language "${config.languages.source}"`,
        at,
      });
    }
    for (const lang of Object.keys(text)) {
      if (!configured.has(lang)) {
        issues.push({
          severity: 'error',
          code: 'unknown-language',
          message: `language "${lang}" of ${what} is neither the source nor a target language`,
          at: `${at}.${lang}`,
        });
      }
    }
  };
  titleLanguages(manifest.title, 'the title', 'title');

  const checkEntries = (entries: readonly ManifestEntry[]) => {
    for (const entry of entries) {
      const at =
        'module' in entry
          ? entry.module
          : textIn(
              entry.title,
              config.languages.source,
              config.languages.source,
            );
      if (entry.when) pushAll(issues, conditionIssues(entry.when, config, at));
      if ('entries' in entry) {
        titleLanguages(entry.title, `the group "${at}"`, at);
        checkEntries(entry.entries);
      }
    }
  };
  // A derived manual's entries are its source's (#451), checked there.
  if (manifest.kind === 'derived') {
    for (const type of manifest.rule?.moduleTypes ?? []) {
      if (!config.moduleTypes.some((t) => t.id === type)) {
        issues.push({
          severity: 'error',
          code: 'unknown-module-type',
          message: `module type "${type}" of the rule is not configured`,
          at: `rule.moduleTypes`,
        });
      }
    }
  } else if (manifest.kind === 'update-guide') {
    // An update guide's entries are its steps (#906), checked as steps.
    if (manifest.guide)
      pushAll(issues, updateGuideIssues(manifest.guide, config));
  } else checkEntries(manifest.entries);
  const replacement = replacementIssue(
    manifest.id,
    manifest.deprecated,
    'manual',
  );
  if (replacement) issues.push(replacement);
  return issues;
}

/**
 * An update guide's own checks (#906): its version attribute a configured version attribute, and
 * per step (`at` `guide.steps.<n>`, from 0) a dotted version (`update-step-version`, an error)
 * that a jump between the guide's versions crosses, i.e. after the first and at most the last
 * (`update-step-outside-versions`, a warning: the step is never shown), a known phase
 * (`update-step-phase`, an error), a configured level (`unknown-audience`) and a valid condition.
 */
function updateGuideIssues(
  guide: NonNullable<Manifest['guide']>,
  config: ProjectConfig,
): Issue[] {
  const issues: Issue[] = [];
  const attr = config.variantAttributes.find((a) => a.id === guide.attribute);
  if (!attr || attr.kind !== 'version') {
    issues.push({
      severity: 'error',
      code: 'unknown-variant-attribute',
      message: attr
        ? `variant attribute "${guide.attribute}" of the guide is not a version attribute`
        : `variant attribute "${guide.attribute}" of the guide is not configured`,
      at: 'guide.attribute',
    });
  }
  const first = guide.versions[0] as string;
  const last = guide.versions[guide.versions.length - 1] as string;
  guide.steps.forEach((step, i) => {
    const at = `guide.steps.${i}`;
    if (!validStepVersion(step.version)) {
      issues.push({
        severity: 'error',
        code: 'update-step-version',
        message:
          step.version === undefined
            ? `the step "${step.module}" has no version`
            : `the step "${step.module}" has version "${step.version}", which is not a dotted version such as "2.3"`,
        at,
      });
    } else if (
      compareVersions(step.version, first) <= 0 ||
      compareVersions(step.version, last) > 0
    ) {
      issues.push({
        severity: 'warning',
        code: 'update-step-outside-versions',
        message: `the step "${step.module}" is for version ${step.version}, which no update from ${first} to ${last} crosses: it is never shown`,
        at,
      });
    }
    if (!isUpdatePhase(step.phase)) {
      issues.push({
        severity: 'error',
        code: 'update-step-phase',
        message: `the step "${step.module}" has phase "${step.phase}"; a phase is one of ${UPDATE_PHASES.join(', ')}`,
        at,
      });
    }
    if (
      step.level !== undefined &&
      !config.audiences.some((a) => a.id === step.level)
    ) {
      issues.push({
        severity: 'error',
        code: 'unknown-audience',
        message: `level "${step.level}" of the step "${step.module}" is not a configured audience`,
        at,
      });
    }
    if (step.when) pushAll(issues, conditionIssues(step.when, config, at));
  });
  return issues;
}

/**
 * A deprecation naming its own module or manual as the replacement (a
 * warning). Whether a replacement exists at all is the repository's
 * question, not one file's: the API's checks report that with the same
 * code.
 */
function replacementIssue(
  id: string,
  deprecated: Deprecation | undefined,
  kind: 'module' | 'manual',
): Issue | undefined {
  if (deprecated?.replacedBy !== id) return undefined;
  return {
    severity: 'warning',
    code: 'unknown-replacement',
    message: `the ${kind} is deprecated with itself as its replacement`,
  };
}

/** A variant's values as one key, their order aside. */
function variantKey(values: Readonly<Record<string, string>>): string {
  return JSON.stringify(
    Object.entries(values).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

/** Pushes every issue of `from` to `to` without spreading it into arguments, which has a length limit. */
function pushAll(to: Issue[], from: readonly Issue[]): void {
  for (const issue of from) to.push(issue);
}
