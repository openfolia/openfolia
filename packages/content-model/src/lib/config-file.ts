/** The project configuration's file, at the root of a content repository. */
export const CONFIG_FILE_NAME = 'openfolia.yaml';

/**
 * Compatibility, for one release: the configuration's file name from before the product was
 * named. A repository without `CONFIG_FILE_NAME` is read from this one, with a deprecation
 * warning; when both exist, `CONFIG_FILE_NAME` wins and this one is ignored. Nothing writes it:
 * the first change to the configuration writes `CONFIG_FILE_NAME`.
 */
export const LEGACY_CONFIG_FILE_NAME = 'ccms.yaml';

/** Whether a repository path is the configuration's file, under either name. */
export function isConfigFileName(path: string): boolean {
  return path === CONFIG_FILE_NAME || path === LEGACY_CONFIG_FILE_NAME;
}
