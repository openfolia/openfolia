import type { PermissionRule } from '../permissions/permissions';

export type PaletteActionId =
  'newModule' | 'newManual' | 'openReview' | 'switchChangeSet';

/** An action the palette offers next to the search results. Labels are translation keys. */
export interface PaletteAction {
  readonly id: PaletteActionId;
  readonly label: string;
  readonly description: string;
  /** What the role needs; a role without it never sees the action. */
  readonly rules: readonly PermissionRule[];
  /**
   * Whether the screen the action leads to exists. An action whose screen is not built yet is
   * hidden, never a dead link.
   */
  readonly built: boolean;
  /**
   * Not for a contributor (`suggestsOnly`, #137): they change modules through "Suggest a change"
   * only, with no change-set picker and no manual builder.
   */
  readonly notForContributors?: true;
}

/**
 * The palette's actions, in order. "New module" opens the content browser's dialog (screen 7),
 * "New manual" the manual builder's; "Open review" goes to the review screen (screen 4).
 */
export const PALETTE_ACTIONS: readonly PaletteAction[] = [
  {
    id: 'newModule',
    label: 'editor.search.actions.newModule.label',
    description: 'editor.search.actions.newModule.description',
    rules: [{ permission: 'content.edit' }],
    built: true,
  },
  {
    id: 'newManual',
    label: 'editor.search.actions.newManual.label',
    description: 'editor.search.actions.newManual.description',
    rules: [{ permission: 'content.edit' }],
    built: true,
    notForContributors: true,
  },
  {
    id: 'openReview',
    label: 'editor.search.actions.openReview.label',
    description: 'editor.search.actions.openReview.description',
    rules: [{ permission: 'content.read.draft' }],
    built: true,
  },
  {
    id: 'switchChangeSet',
    label: 'editor.search.actions.switchChangeSet.label',
    description: 'editor.search.actions.switchChangeSet.description',
    // The header's change-set control: anyone who can edit or read drafts uses change sets.
    rules: [
      { permission: 'content.edit' },
      { permission: 'content.read.draft' },
    ],
    built: true,
    notForContributors: true,
  },
];
