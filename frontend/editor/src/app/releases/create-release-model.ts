import type { Item } from '../api';

export type CheckItem = Item<'/manuals/{id}/checks'>;
export type MaintenanceLine = Item<'/maintenance-lines'>;

/** The dialog's steps, in order. */
export const STEPS = ['product', 'checks', 'outputs', 'notes'] as const;
export type Step = (typeof STEPS)[number];

export const STEP_TEXT: Readonly<Record<Step, string>> = {
  product: 'editor.releases.create.steps.product',
  checks: 'editor.releases.create.steps.checks',
  outputs: 'editor.releases.create.steps.outputs',
  notes: 'editor.releases.create.steps.notes',
};

/** The checks of one manual the release renders, as read for the dialog. */
export interface ManualReadiness {
  readonly id: string;
  readonly title: string;
  readonly blocking: number;
  readonly warning: number;
  /** The first checks, blocking first (each links to its fix). */
  readonly checks: readonly CheckItem[];
  /** The checks could not be read. */
  readonly failed: boolean;
}

/** All manuals together: still reading, failed, or how many block and warn. */
export type Readiness =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed' }
  | {
      readonly kind: 'read';
      readonly blocking: number;
      readonly warning: number;
    };

export function readinessOf(
  manuals: readonly ManualReadiness[] | null,
): Readiness {
  if (manuals === null) return { kind: 'loading' };
  if (manuals.some((m) => m.failed)) return { kind: 'failed' };
  return {
    kind: 'read',
    blocking: manuals.reduce((n, m) => n + m.blocking, 0),
    warning: manuals.reduce((n, m) => n + m.warning, 0),
  };
}

/** Manuals with blocking checks first, then with warnings, then the rest; by title within. */
export function byUrgency(
  manuals: readonly ManualReadiness[],
): ManualReadiness[] {
  const rank = (m: ManualReadiness) =>
    m.failed ? 0 : m.blocking > 0 ? 1 : m.warning > 0 ? 2 : 3;
  return [...manuals].sort(
    (a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title),
  );
}

/**
 * Why "Create release" cannot be pressed now (a translation key), or null: the checks first
 * (#241: no release while blocking checks are open; warnings need a confirmation), then the
 * product and version, then the notes.
 */
export function createBlocked(state: {
  readiness: Readiness;
  warningsConfirmed: boolean;
  detailsProblem: boolean;
  notesProblem: boolean;
  busy: boolean;
}): string | null {
  const { readiness } = state;
  if (state.busy) return 'editor.releases.create.blocked.busy';
  if (readiness.kind === 'loading')
    return 'editor.releases.create.blocked.checking';
  if (readiness.kind === 'failed')
    return 'editor.releases.create.blocked.checksFailed';
  if (readiness.blocking > 0) return 'editor.releases.create.blocked.blocking';
  if (readiness.warning > 0 && !state.warningsConfirmed)
    return 'editor.releases.create.blocked.warnings';
  if (state.detailsProblem) return 'editor.releases.create.blocked.details';
  if (state.notesProblem) return 'editor.releases.create.blocked.notes';
  return null;
}

/** The first checks of a page, blocking ones first (the API orders by subject). */
export function firstChecks(
  checks: readonly CheckItem[],
  count: number,
): CheckItem[] {
  return [...checks]
    .sort(
      (a, b) =>
        Number(b.attributes.severity === 'blocking') -
        Number(a.attributes.severity === 'blocking'),
    )
    .slice(0, count);
}
