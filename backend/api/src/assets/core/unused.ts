import type { Actor } from '../../access/core/actor.js';
import { allowsUnrestricted } from '../../access/core/allows.js';
import { ForbiddenError } from '../../base/core/errors.js';

/** How long after its last upload (or storing) a file nothing refers to is still kept (#242). */
export const UNUSED_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Whether `actor` may find and delete unused files: `content.read.draft` and
 * `content.edit`, each in a role whose scope restricts nothing. An unused file
 * has no module to check a scope against (#255, which asks for no restriction
 * on languages; the other dimensions are required unrestricted too, so a role
 * kept to some content never decides about files at all), and unused files
 * include other people's draft uploads (an abandoned change set's), so never
 * for someone who does not read every draft, a contributor among them (#137).
 */
export function editsEverything(actor: Actor): boolean {
  return (
    allowsUnrestricted(actor, 'content.read.draft') &&
    allowsUnrestricted(actor, 'content.edit')
  );
}

export function requireEditsEverything(actor: Actor): void {
  if (!editsEverything(actor)) {
    throw new ForbiddenError(
      'Finding and deleting unused files needs content.read.draft and content.edit, each in a role whose scope restricts nothing.',
    );
  }
}
