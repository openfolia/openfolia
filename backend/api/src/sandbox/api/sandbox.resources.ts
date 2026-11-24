import { z } from 'zod';
import { resourceObject, singleDocument } from '../../base/api/json-api.js';
import type { SandboxStatus } from '../core/sandbox.js';

const count = (what: string) => z.number().int().min(0).describe(what);

export const SandboxResource = resourceObject('Sandbox', {
  attributes: z.object({
    limits: z
      .object({
        moduleBytes: count(
          'The largest module (or other working copy), in bytes of its JSON (`CCMS_SANDBOX_MAX_MODULE_BYTES`).',
        ),
        commentLength: count(
          'The longest comment, in characters (`CCMS_SANDBOX_MAX_COMMENT_LENGTH`).',
        ),
        changeSets: count(
          'The most revisions (change sets) made (`CCMS_SANDBOX_MAX_CHANGE_SETS`).',
        ),
        modules: count('The most modules made (`CCMS_SANDBOX_MAX_MODULES`).'),
        manuals: count('The most manuals made (`CCMS_SANDBOX_MAX_MANUALS`).'),
        releasesPerHour: count(
          'The most releases cut in any hour (`CCMS_SANDBOX_RELEASES_PER_HOUR`).',
        ),
        renderJobs: count(
          'The most PDFs rendered at once (`CCMS_SANDBOX_RENDER_JOBS`).',
        ),
        writeBytes: count(
          'The most bytes written over the session: every working copy saved, comment, commit and stored file (`CCMS_SANDBOX_MAX_WRITE_BYTES`).',
        ),
      })
      .describe('The caps; past one, 422 `sandbox-limit-reached`.'),
    idleMinutes: count(
      'It ends this many minutes after the last request that did something (`CCMS_SANDBOX_IDLE_MINUTES`).',
    ),
    maxMinutes: count(
      'It ends this many minutes after it started, however busy (`CCMS_SANDBOX_MAX_MINUTES`).',
    ),
    portalUrl: z
      .url()
      .optional()
      .describe(
        'The shared read-only reader portal (an https:// address, `CCMS_SANDBOX_PORTAL_URL`), which the banner links. Absent when not set. A link only: the API never calls it.',
      ),
    endUrl: z
      .string()
      .optional()
      .describe(
        'Where the banner ends the sandbox ("End demo"): a path on the editor’s origin or an https:// address (`CCMS_SANDBOX_END_URL`). The editor posts `{ lang }` to it and goes to the answer’s `next`. Absent when not set: no "End demo". The API never calls it.',
      ),
  }),
  meta: z.object({
    used: z
      .object({
        changeSets: count('Revisions made so far.'),
        modules: count('Modules made so far.'),
        manuals: count('Manuals made so far.'),
        releasesLastHour: count('Releases cut in the last hour.'),
        writtenBytes: count('Bytes written so far, of `writeBytes`.'),
      })
      .describe('What is used of the counted caps.'),
    startedAt: z.iso.datetime().describe('When the sandbox started.'),
    endsAt: z.iso
      .datetime()
      .describe(
        'When it ends: the earlier of its idle end and its hard end. Everything in it is deleted then.',
      ),
  }),
})
  .describe('`id` is always `current`.')
  .meta({ id: 'SandboxResource' });

export const SandboxDocument = singleDocument(SandboxResource).meta({
  id: 'SandboxDocument',
});

export function toSandboxDocument(
  status: SandboxStatus,
): z.infer<typeof SandboxDocument> {
  return {
    data: {
      type: 'Sandbox',
      id: 'current',
      attributes: {
        limits: { ...status.limits },
        idleMinutes: status.lifetime.idleMinutes,
        maxMinutes: status.lifetime.maxMinutes,
        ...(status.portalUrl === undefined
          ? {}
          : { portalUrl: status.portalUrl }),
        ...(status.endUrl === undefined ? {} : { endUrl: status.endUrl }),
      },
      meta: {
        used: {
          changeSets: status.used['change-sets'],
          modules: status.used.modules,
          manuals: status.used.manuals,
          releasesLastHour: status.used.releases,
          writtenBytes: status.writtenBytes,
        },
        startedAt: status.startedAt.toISOString(),
        endsAt: status.endsAt.toISOString(),
      },
    },
  };
}
