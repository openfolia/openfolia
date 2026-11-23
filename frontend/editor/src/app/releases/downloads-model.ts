import type { ZardBadgeTypeVariants } from '@openfolia/ui/badge';

import type { Response } from '../api';

/** The download centre's list (`GET /downloads`, #139). */
export type DownloadDoc = Response<'/downloads'>;
/** One download: an attachment, or a manual's PDF, at its product's latest release. */
export type DownloadItem = DownloadDoc['data'][number];
/** A download's versions (`GET /downloads/{id}/versions`). */
export type DownloadVersionDoc = Response<'/downloads/{id}/versions'>;
export type DownloadVersionItem = DownloadVersionDoc['data'][number];

export const DOWNLOAD_KINDS = ['attachment', 'manual'] as const;
export type DownloadKind = (typeof DOWNLOAD_KINDS)[number];

export const DOWNLOAD_PAGE_SIZES = [25, 50, 100] as const;
/** Versions per page of the panel. */
export const VERSION_PAGE_SIZE = 25;

/**
 * A download's ID as the API gives it (`attachment:…` or `manual:…`), as the address keeps the
 * chosen one: checked for its form and length only, the API judges the rest.
 */
export const DOWNLOAD_ID =
  /^(?:attachment|manual):[A-Za-z0-9.=,~;:_-]{1,1390}$/;

/** A language tag, as the language filter takes it. */
export const LANGUAGE = /^[a-zA-Z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,6}$/;

export const KIND_TEXT: Readonly<Record<DownloadKind, string>> = {
  attachment: 'editor.releases.downloads.kind.attachment',
  manual: 'editor.releases.downloads.kind.manual',
};

export type VersionState = DownloadVersionItem['attributes']['state'];

export const VERSION_STATE_TEXT: Readonly<Record<VersionState, string>> = {
  current: 'editor.releases.downloads.state.current',
  superseded: 'editor.releases.downloads.state.superseded',
  withdrawn: 'editor.releases.downloads.state.withdrawn',
};

export const VERSION_STATE_BADGE: Readonly<
  Record<VersionState, ZardBadgeTypeVariants>
> = {
  current: 'success',
  superseded: 'secondary',
  withdrawn: 'destructive',
};

/** A checksum shortened for a row: its first 12 characters (the whole one is in its title). */
export function shortHash(sha256: string): string {
  return sha256.slice(0, 12);
}
