/**
 * The tokens of `frontend/theme/src/theme.css`, grouped for screen 0. A test in
 * `frontend/theme/tests` keeps this list and the CSS in step: a token added to one and not the
 * other fails it. Keep every name as a quoted string literal.
 */
export type TokenKind = 'color' | 'radius' | 'font';

export interface TokenGroup {
  /** A translation key. */
  readonly title: string;
  readonly kind: TokenKind;
  readonly tokens: readonly string[];
}

export const TOKEN_GROUPS: readonly TokenGroup[] = [
  {
    title: 'editor.theme.groups.surface',
    kind: 'color',
    tokens: [
      '--background',
      '--foreground',
      '--card',
      '--card-foreground',
      '--popover',
      '--popover-foreground',
      '--primary',
      '--primary-foreground',
      '--secondary',
      '--secondary-foreground',
      '--muted',
      '--muted-foreground',
      '--accent',
      '--accent-foreground',
      '--border',
      '--input',
      '--ring',
    ],
  },
  {
    title: 'editor.theme.groups.status',
    kind: 'color',
    tokens: [
      '--destructive',
      '--destructive-muted',
      '--success',
      '--success-muted',
      '--warning',
      '--warning-muted',
      '--info',
      '--info-muted',
    ],
  },
  {
    title: 'editor.theme.groups.sidebar',
    kind: 'color',
    tokens: [
      '--sidebar',
      '--sidebar-foreground',
      '--sidebar-primary',
      '--sidebar-primary-foreground',
      '--sidebar-accent',
      '--sidebar-accent-foreground',
      '--sidebar-border',
      '--sidebar-ring',
    ],
  },
  {
    title: 'editor.theme.groups.safety',
    kind: 'color',
    tokens: [
      '--safety-danger',
      '--safety-danger-foreground',
      '--safety-warning',
      '--safety-warning-foreground',
      '--safety-caution',
      '--safety-caution-foreground',
      '--safety-notice',
      '--safety-notice-foreground',
      '--safety-symbol-background',
    ],
  },
  { title: 'editor.theme.groups.radius', kind: 'radius', tokens: ['--radius'] },
  {
    title: 'editor.theme.groups.fonts',
    kind: 'font',
    tokens: ['--font-sans', '--font-mono'],
  },
];
