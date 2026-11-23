import type { Item, Response } from '../../api';

/** `GET /storage-usage`'s resource. */
export type StorageUsage = Response<'/storage-usage'>['data'];
/** One file of `GET /storage-usage/files`. */
export type StoredFileItem = Item<'/storage-usage/files'>;
export type StorageLevel = StorageUsage['meta']['level'];

/** The permission the storage card needs (`GET /storage-usage`). */
export const READ_STORAGE_USAGE = 'admin.roles';

/** Page sizes of the list of largest files. */
export const FILE_PAGE_SIZES = [10, 25, 50] as const;

/** The meter's colour for a level. */
export const LEVEL_TONES: Readonly<
  Record<StorageLevel, 'success' | 'warning' | 'destructive'>
> = {
  unlimited: 'success',
  ok: 'success',
  warning: 'warning',
  reached: 'destructive',
};

/** The words for a level that needs attention, as whole keys; none for the others. */
export const LEVEL_NOTICES: Readonly<
  Partial<Record<StorageLevel, { title: string; text: string }>>
> = {
  warning: {
    title: 'editor.admin.system.storage.warning.title',
    text: 'editor.admin.system.storage.warning.text',
  },
  reached: {
    title: 'editor.admin.system.storage.reached.title',
    text: 'editor.admin.system.storage.reached.text',
  },
};

/** The share used as a whole percentage for the meter (0 to 100), 0 without a limit. */
export function percentUsed(usage: StorageUsage): number {
  const share = usage.meta.usedShare;
  if (share === null || !Number.isFinite(share)) return 0;
  return Math.min(100, Math.max(0, share * 100));
}

/** A share as a percentage in the interface's locale (`85 %`), rounded down; small shares keep a decimal. */
export function formatShare(share: number, locale: string): string {
  const digits = share > 0 && share < 0.1 ? 1 : 0;
  // Rounded down, so it says 100 % only at the limit (the nudge keeps 0.29 from flooring to
  // 28 % in binary floating point).
  const step = 10 ** (digits + 2);
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    maximumFractionDigits: digits,
  }).format(Math.floor(share * step + 1e-9) / step);
}

/** A file's name as shown: its file name, else the start of its hash. */
export function fileLabel(file: StoredFileItem): string {
  return file.attributes.fileName ?? file.id.slice(0, 12);
}

/**
 * Where the media library opens a file: searched by its hash, which finds just it, and open
 * (`/media?q=<hash>&file=<hash>`); a file nobody uses, the library looks for on its unused list.
 */
export function mediaLink(file: StoredFileItem): {
  commands: string[];
  queryParams: Record<string, string>;
} {
  return { commands: ['/media'], queryParams: { q: file.id, file: file.id } };
}

/** The media library's list of unused files, to free room. */
export const UNUSED_FILES_LINK = {
  commands: ['/media'],
  queryParams: { usage: 'unused' },
} as const;

/**
 * A wait of `seconds` in the largest whole unit that fits (seconds,
 * minutes, hours, days), as `Intl` writes it in `locale` (#527).
 */
export function formatWait(seconds: number, locale: string): string {
  const units = [
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ] as const;
  for (const [unit, size] of units) {
    if (seconds >= size) {
      return new Intl.NumberFormat(locale, {
        style: 'unit',
        unit,
        unitDisplay: 'long',
      }).format(Math.floor(seconds / size));
    }
  }
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: 'second',
    unitDisplay: 'long',
  }).format(Math.max(0, Math.floor(seconds)));
}
