import {
  HttpStatus,
  Injectable,
  type ArgumentMetadata,
  type PipeTransform,
} from '@nestjs/common';
import { TABLE_TOO_LARGE } from '@openfolia/content-model';
import { TABLE_CAPS } from '../core/errors.js';
import { JsonApiException } from './json-api.exception.js';

/**
 * How deeply a request body may nest (objects and arrays). Validating a
 * recursive schema (a module's blocks) walks it recursively, so a body
 * nested a few thousand levels deep would exhaust the stack; real content
 * nests a few dozen at most.
 */
export const MAX_BODY_DEPTH = 128;

/** Whether `value` nests deeper than `max` levels; iterative, never recursive. */
export function nestsDeeperThan(value: unknown, max: number): boolean {
  const stack: [unknown, number][] = [[value, 0]];
  while (stack.length > 0) {
    const [item, depth] = stack.pop() as [unknown, number];
    if (typeof item !== 'object' || item === null) continue;
    if (depth >= max) return true;
    for (const child of Object.values(item)) stack.push([child, depth + 1]);
  }
  return false;
}

/**
 * Validates every parameter that declares a `schema` (Zod), e.g.
 * `@Param('id', { schema: ModuleId })`. Failures are JSON:API errors that
 * name the parameter (or, for bodies, point at the member).
 */
@Injectable()
export class SchemaValidationPipe implements PipeTransform {
  async transform(
    value: unknown,
    metadata: ArgumentMetadata,
  ): Promise<unknown> {
    const { schema } = metadata;
    if (!schema || metadata.type === 'custom') return value;
    if (metadata.type === 'body' && nestsDeeperThan(value, MAX_BODY_DEPTH)) {
      throw new JsonApiException(HttpStatus.BAD_REQUEST, [
        {
          code: 'invalid-body',
          detail: `The body nests deeper than ${MAX_BODY_DEPTH} levels.`,
          source: { pointer: '' },
        },
      ]);
    }
    const result = await schema['~standard'].validate(value);
    if (!result.issues) return result.value;
    // Content holding a table past the caps (#686) is no malformed body but content that may
    // not be: 422 `table-too-large`, one error per such table.
    const tables = result.issues.filter(isTableTooLarge);
    if (metadata.type === 'body' && tables.length > 0) {
      throw new JsonApiException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        tables.map((issue) => ({
          code: 'table-too-large',
          detail: issue.message,
          source: { pointer: pointerOf(issue) },
          meta: TABLE_CAPS,
        })),
      );
    }
    throw new JsonApiException(
      HttpStatus.BAD_REQUEST,
      result.issues.map((issue) => ({
        code: metadata.type === 'body' ? 'invalid-body' : 'invalid-parameter',
        detail: issue.message,
        source:
          metadata.type === 'body'
            ? { pointer: pointerOf(issue) }
            : { parameter: metadata.data ?? pathOf(issue).join('.') },
      })),
    );
  }
}

/** A Standard Schema issue, as `validate` gives it. */
interface Issue {
  readonly message: string;
  readonly path?:
    ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
}

const pathOf = (issue: Issue): string[] =>
  (issue.path ?? []).map((segment) =>
    String(typeof segment === 'object' ? segment.key : segment),
  );

const pointerOf = (issue: Issue): string =>
  `/${pathOf(issue).map(escapePointer).join('/')}`;

/** The schema's issue for a table past the caps: a Zod custom issue whose `params.code` says so. */
const isTableTooLarge = (issue: Issue): boolean => {
  const params = (issue as { params?: unknown }).params;
  return (
    typeof params === 'object' &&
    params !== null &&
    (params as Record<string, unknown>)['code'] === TABLE_TOO_LARGE
  );
};

const escapePointer = (segment: string) =>
  segment.replaceAll('~', '~0').replaceAll('/', '~1');
