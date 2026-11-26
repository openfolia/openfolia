import { InvalidParameterError } from '../../base/core/errors.js';

/** The `scimType` of a SCIM error (RFC 7644, section 3.12), for the 400s that carry one. */
export type ScimType =
  | 'invalidFilter'
  | 'tooMany'
  | 'uniqueness'
  | 'mutability'
  | 'invalidSyntax'
  | 'invalidPath'
  | 'noTarget'
  | 'invalidValue'
  | 'invalidVers'
  | 'sensitive';

/**
 * A SCIM request the standard refuses with 400 and a `scimType` (#377). A 400 like any
 * `InvalidParameterError`; the SCIM routes answer it in SCIM's error shape.
 */
export abstract class ScimRequestError extends InvalidParameterError {
  abstract readonly scimType: ScimType;

  constructor(message: string, parameter = 'body') {
    super(parameter, message);
  }
}

/** 400 `scim-invalid-filter` (`invalidFilter`): a `filter` that does not parse, or compares what it cannot. */
export class ScimInvalidFilterError extends ScimRequestError {
  override readonly code = 'scim-invalid-filter';
  readonly scimType = 'invalidFilter';

  constructor(message: string) {
    super(message, 'filter');
  }
}

/** 400 `scim-invalid-syntax` (`invalidSyntax`): a body that is no SCIM resource or patch. */
export class ScimInvalidSyntaxError extends ScimRequestError {
  override readonly code = 'scim-invalid-syntax';
  readonly scimType = 'invalidSyntax';
}

/** 400 `scim-invalid-path` (`invalidPath`): a patch `path` that does not parse. */
export class ScimInvalidPathError extends ScimRequestError {
  override readonly code = 'scim-invalid-path';
  readonly scimType = 'invalidPath';
}

/** 400 `scim-no-target` (`noTarget`): a patch whose path selects nothing it could change. */
export class ScimNoTargetError extends ScimRequestError {
  override readonly code = 'scim-no-target';
  readonly scimType = 'noTarget';
}

/** 400 `scim-invalid-value` (`invalidValue`): an attribute missing, of the wrong type or out of range. */
export class ScimInvalidValueError extends ScimRequestError {
  override readonly code = 'scim-invalid-value';
  readonly scimType = 'invalidValue';
}

/** 400 `scim-mutability` (`mutability`): a change to a read-only attribute (`id`, `meta`, `groups`). */
export class ScimMutabilityError extends ScimRequestError {
  override readonly code = 'scim-mutability';
  readonly scimType = 'mutability';
}

/** The codes answered as `uniqueness` (409): a `userName`, an email address or a group's name taken. */
export const UNIQUENESS_CODES: ReadonlySet<string> = new Set([
  'scim-user-name-taken',
  'scim-group-name-taken',
  'email-taken',
]);
