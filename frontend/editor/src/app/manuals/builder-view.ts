import { idParam, oneOfParam } from '../view-state';

/**
 * What the manual builder shows, kept in the address (`injectQueryState`) so a link or a reload
 * shows the same view: `?manual=<id>&node=<row>&lang=<tag>&variant=<slug>&deleted=shown&section=rule`. The change set (`cs`)
 * is the shell's (`ChangeSetUrl`). A value not of its form is dropped here; one the page does not
 * know (not in the manual, the configuration) is dropped by the page; a default (the first
 * manual, the source language, the first variant, no row) is left out.
 */
export const BUILDER_VIEW = {
  // IDs and slugs as the API writes them: no spaces, no path separators, at most 200 characters.
  manual: idParam(/^[a-z0-9][a-z0-9-]{0,199}$/),
  node: idParam(/^[a-z0-9][a-z0-9-]{0,199}(~[0-9]{1,4})?$/),
  lang: idParam(/^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8}){0,3}$/),
  variant: idParam(/^[A-Za-z0-9._~=,:+-]{1,400}$/),
  /** The switcher lists the manuals deleted on the branch too (#321), each opening its history. */
  deleted: oneOfParam(['shown'] as const),
  /** A part of the builder to bring into view once: `rule`, a derived manual's rule (#669). */
  section: oneOfParam(['rule'] as const),
};
