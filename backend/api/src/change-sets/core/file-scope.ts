import type { Actor } from '../../access/core/actor.js';
import { type UsagePlace, usageOf } from '../../assets/core/readable-assets.js';
import { NotFoundError } from '../../base/core/errors.js';
import type { OpenSnapshotAction } from '../../content/core/actions/open-snapshot.action.js';
import type { ReadableContent } from '../../content/core/readable-content.js';
import type { ChangeSet } from './change-set.js';

/**
 * Where the files a working copy of `changeSet` names may come from
 * (#335, `ReadableAssets`): a module the actor may see on the change
 * set's branch (`branch`, its committed head as they read it: what the
 * change set refers to already, and the base it started from), then at
 * its base ref as they read it now (a module added there since). A base
 * the actor may not open adds nothing. A file a page design there names
 * counts too (#390): every reader of the commit reads its designs; so does
 * a manual's cover image the actor may see (#394). Working
 * copies never count, so a draft cannot vouch for a file another draft
 * names.
 */
export function workingCopyFilePlaces(
  openSnapshot: Pick<OpenSnapshotAction, 'handle'>,
  actor: Actor,
  changeSet: Pick<ChangeSet, 'baseRef'>,
  branch: Pick<
    ReadableContent,
    'assetUsage' | 'pageDesignAssets' | 'manualCoverAssets'
  >,
): UsagePlace[] {
  // Opened at most once per call, however many checks ask.
  let base: Promise<ReadonlyMap<string, unknown> | undefined> | undefined;
  const openBase = async () => {
    let opened: ReadableContent;
    try {
      opened = await openSnapshot.handle({ actor, ref: changeSet.baseRef });
    } catch (error) {
      if (error instanceof NotFoundError) return undefined;
      throw error;
    }
    return withDesigns(opened)();
  };
  return [
    withDesigns(branch),
    () => {
      base ??= openBase();
      // A failure is not kept: the next check tries again.
      base.catch(() => (base = undefined));
      return base;
    },
  ];
}

/** The files a module the actor may see uses, those a page design names (every reader's) and the cover images of the manuals the actor may see, at `content`. */
function withDesigns(
  content: Pick<
    ReadableContent,
    'assetUsage' | 'pageDesignAssets' | 'manualCoverAssets'
  >,
): UsagePlace {
  const modules = usageOf(content);
  let both: Promise<ReadonlyMap<string, unknown>> | undefined;
  return () =>
    (both ??= (async () => {
      const [used, designs, covers] = await Promise.all([
        modules(),
        content.pageDesignAssets(),
        content.manualCoverAssets(),
      ]);
      if (designs.size === 0 && covers.size === 0) return used;
      const merged = new Map<string, unknown>(used);
      for (const asset of [...designs, ...covers.keys()])
        if (!merged.has(asset)) merged.set(asset, []);
      return merged;
    })());
}
