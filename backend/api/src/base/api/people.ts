import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiExtension } from '@nestjs/swagger';
import { z } from 'zod';

export const NAMES_PEOPLE = 'openfolia:names-people';
/** OpenAPI marker read by `createOpenApiDocument`, which removes it again. */
export const NAMES_PEOPLE_EXTENSION = 'x-openfolia-names-people';

/**
 * For JSON:API routes whose documents name people (`{ kind: 'user', id }`: an author, approver,
 * commenter, …): the document's `meta.people` says of each whether they are deactivated (#928).
 * Derived when it is sent, by `JsonApiInterceptor`, and documented by `createOpenApiDocument`.
 * `tests/people.e2e.spec.ts` fails for a route that names people without it.
 */
export const NamesPeople = () =>
  applyDecorators(
    SetMetadata(NAMES_PEOPLE, true),
    ApiExtension(NAMES_PEOPLE_EXTENSION, true),
  );

/** `meta.people` of a document that names people. */
export const People = z
  .array(
    z.object({
      id: z.string().describe('The user’s ID.'),
      deactivated: z
        .boolean()
        .describe(
          'Whether the user is deactivated now; false for an ID no user has.',
        ),
    }),
  )
  .describe(
    'The users this document names (as `{ kind: "user", id }`), each once, by ID, and whether they are deactivated. Derived, never stored.',
  );

/** The IDs of the users a document's `data` and `meta` name, as `{ kind: 'user', id }`. */
export function peopleIn(document: object): string[] {
  const found: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return;
    if (
      'kind' in node &&
      node.kind === 'user' &&
      'id' in node &&
      typeof node.id === 'string'
    ) {
      found.push(node.id);
    }
    Object.values(node).forEach(visit);
  };
  visit('data' in document ? document.data : undefined);
  visit('meta' in document ? document.meta : undefined);
  return found;
}
