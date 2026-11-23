import { computed, Injectable, signal } from '@angular/core';

/** Route data: how the sidebar starts on a screen. */
export type SidebarMode = 'expanded' | 'collapsed';

const STORAGE_KEY = 'openfolia.sidebar';

function readChoice(): SidebarMode | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'expanded' || value === 'collapsed' ? value : null;
  } catch {
    return null;
  }
}

function writeChoice(mode: SidebarMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Storage blocked or full: the choice then lasts only until the page is reloaded.
  }
}

/**
 * Whether the sidebar is collapsed to icons. The person's own choice (the trigger, the mark,
 * Ctrl/Cmd+B) wins on every screen and survives a reload (local storage). A screen's route data
 * (`sidebar`) is only the default until the person has ever chosen. Below tablet width the
 * sidebar is a drawer instead (Zard's mobile sidebar), opened from the page's menu button.
 */
@Injectable({ providedIn: 'root' })
export class ShellState {
  private readonly choice = signal<SidebarMode | null>(readChoice());
  private readonly routeDefault = signal<SidebarMode>('expanded');
  private readonly mode = computed(() => this.choice() ?? this.routeDefault());
  readonly collapsed = computed(() => this.mode() === 'collapsed');

  setDefault(mode: SidebarMode): void {
    this.routeDefault.set(mode);
  }

  /** Sets it from the sidebar's own open state (its trigger, Ctrl/Cmd+B). */
  setOpen(open: boolean): void {
    const mode: SidebarMode = open ? 'expanded' : 'collapsed';
    // The provider echoes programmatic changes: only a real change is the person's choice.
    if (mode === this.mode()) return;
    this.choice.set(mode);
    writeChoice(mode);
  }

  toggle(): void {
    this.setOpen(this.collapsed());
  }
}
