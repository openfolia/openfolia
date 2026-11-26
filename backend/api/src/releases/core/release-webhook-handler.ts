import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { Actor } from '../../access/core/actor.js';
import {
  InvalidContentError,
  NotFoundError,
  UnprocessableError,
} from '../../base/core/errors.js';
import { OpenSnapshotAction } from '../../content/core/actions/open-snapshot.action.js';
import type { OutboxEvent } from '../../outbox/core/outbox-feed.js';
import type { WebhookEvent } from '../../webhooks/core/webhook.js';
import { capAudience } from '../../webhooks/core/webhook-audience.js';
import {
  type OutgoingEvent,
  WebhookEventHandler,
} from '../../webhooks/core/webhook-event-handler.js';
import {
  idempotencyKey,
  WEBHOOK_READER,
} from '../../webhooks/core/webhook-events.js';
import { RELEASED_WEBHOOK_EVENTS } from '../releases.webhook-events.js';
import { ReleaseChangeReader } from './actions/release-changes.action.js';
import type { Release } from './release.js';
import type { ReleaseChange } from './release-changes.js';
import { ReleaseStore } from './release-store.js';

/** The most module events one release makes per subscriber; the rest are left out (`complete: false`). */
export const MAX_MODULE_EVENTS = 1_000;

const Id = z.string().min(1).max(200);
const Commit = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);

/** `release.published` (#138): only what finds the release; the rest is read again. */
const ReleasePublished = z.object({ releaseId: Id });

/** `release.withdrawn` (#138). */
const ReleaseWithdrawn = z.object({
  releaseId: Id,
  product: Id,
  revision: Id,
  tag: z.string().min(1).max(300),
  commit: Commit,
  reason: z.string().max(2_000),
});

/**
 * The releases' webhook events (`releases.webhook-events.ts`), as the owner of a subscriber may
 * read them (#42):
 *
 * - `release.published` makes `manual.released`, one per manual the
 *   release changed as the owner sees it (`ReleaseChangeReader`, the same
 *   as `GET /releases/{id}/changes` answers them), with its languages, and
 *   `module.released`, one per module and language (at most
 *   `MAX_MODULE_EVENTS`), with its content hash (`contentHash`, the
 *   file's revision; null when removed). Past `too-many-changes` it makes
 *   a `manual.released` per manual the owner reads, the changes unknown
 *   (`complete: false`), and no module events. Judged with the
 *   subscriber's audience limit, by the configuration at the release's
 *   commit.
 * - `release.withdrawn`: to an owner who reads released content anywhere
 *   (every reader may know a release); it names no content of an
 *   audience, so it is not limited.
 *
 * Idempotency keys: `manual.released` over the release and the manual;
 * `module.released` over the release, the module, its language and its
 * content hash; `release.withdrawn` over the release.
 *
 * Who covers any owner of a subscriber to one of them: whoever reads
 * content restricting nothing; nothing more is needed.
 */
@Injectable()
export class ReleaseWebhookHandler extends WebhookEventHandler {
  readonly group = RELEASED_WEBHOOK_EVENTS.group;

  constructor(
    private readonly releases: ReleaseStore,
    private readonly changes: ReleaseChangeReader,
    private readonly openSnapshot: OpenSnapshotAction,
  ) {
    super();
  }

  async build(
    event: OutboxEvent,
    owner: Actor,
    wanted: ReadonlySet<WebhookEvent>,
    maxAudience: string | null,
  ): Promise<OutgoingEvent[] | undefined> {
    switch (event.topic) {
      case 'release.published': {
        const parsed = ReleasePublished.safeParse(event.payload);
        if (!parsed.success) return undefined;
        const release = await this.releases.find(parsed.data.releaseId);
        // Not published (yet, or ever): nothing to tell.
        if (!release) return [];
        return this.released(
          release,
          await this.capped(owner, maxAudience, release.commit),
          wanted,
        );
      }
      case 'release.withdrawn': {
        const parsed = ReleaseWithdrawn.safeParse(event.payload);
        if (!parsed.success) return undefined;
        const p = parsed.data;
        return [
          {
            type: 'release.withdrawn',
            idempotencyKey: idempotencyKey('release.withdrawn', p.releaseId),
            data: {
              releaseId: p.releaseId,
              product: p.product,
              revision: p.revision,
              tag: p.tag,
              commit: p.commit,
              reason: p.reason,
            },
          },
        ];
      }
      default:
        return [];
    }
  }

  coversAnyOwner(): boolean {
    return true;
  }

  /** `owner` capped at `maxAudience` by the configuration at `commit`; as it is without one. */
  private async capped(
    owner: Actor,
    maxAudience: string | null,
    commit: string,
  ): Promise<Actor> {
    if (maxAudience === null) return owner;
    const at = await this.openSnapshot.handle({
      actor: WEBHOOK_READER,
      ref: commit,
    });
    const config = await at.config();
    return capAudience(
      owner,
      maxAudience,
      config.audiences.map((a) => a.id),
    );
  }

  private async released(
    release: Release,
    owner: Actor,
    wanted: ReadonlySet<WebhookEvent>,
  ): Promise<OutgoingEvent[]> {
    let changes: readonly ReleaseChange[];
    let complete = true;
    // As when the release was published: too many changes to compare, or a
    // previous release that cannot be read, gives every manual the owner
    // reads (`complete: false`); none when even that cannot be read.
    const tolerated = (error: unknown) =>
      error instanceof NotFoundError ||
      error instanceof InvalidContentError ||
      error instanceof UnprocessableError;
    try {
      ({ changes } = await this.changes.of(owner, release));
    } catch (error) {
      if (!tolerated(error)) throw error;
      complete = false;
      try {
        changes = await this.changes.everyManual(owner, release);
      } catch (again) {
        if (!tolerated(again)) throw again;
        changes = [];
      }
    }
    const about = {
      releaseId: release.id,
      product: release.product,
      revision: release.revision,
      tag: release.tag,
      commit: release.commit,
      major: release.major,
    };
    const out: OutgoingEvent[] = [];
    if (wanted.has('manual.released')) {
      const byManual = new Map<string, ReleaseChange[]>();
      for (const change of changes) {
        byManual.set(change.manualId, [
          ...(byManual.get(change.manualId) ?? []),
          change,
        ]);
      }
      for (const [manualId, perLang] of byManual) {
        out.push({
          type: 'manual.released',
          idempotencyKey: idempotencyKey(
            'manual.released',
            release.id,
            manualId,
          ),
          data: {
            ...about,
            manualId,
            languages: perLang
              .map((c) => ({
                lang: c.lang,
                change: complete ? c.change : null,
              }))
              .sort((a, b) => a.lang.localeCompare(b.lang)),
            complete,
          },
        });
      }
    }
    if (wanted.has('module.released') && complete) {
      const modules = new Map<
        string,
        { moduleId: string; lang: string; change: string }
      >();
      for (const c of changes) {
        for (const m of c.modules) {
          modules.set(`${c.lang}/${m.moduleId}`, {
            moduleId: m.moduleId,
            lang: c.lang,
            change: m.change,
          });
        }
      }
      const listed = [...modules.values()];
      const at = await this.openSnapshot.handle({
        actor: owner,
        ref: release.commit,
      });
      for (const m of listed.slice(0, MAX_MODULE_EVENTS)) {
        const contentHash =
          m.change === 'removed'
            ? null
            : ((await at.moduleRevision(m.moduleId, m.lang)) ?? null);
        out.push({
          type: 'module.released',
          idempotencyKey: idempotencyKey(
            'module.released',
            release.id,
            `${m.lang}/${m.moduleId}`,
            contentHash ?? 'removed',
          ),
          data: {
            ...about,
            moduleId: m.moduleId,
            lang: m.lang,
            change: m.change,
            contentHash,
            complete: listed.length <= MAX_MODULE_EVENTS,
          },
        });
      }
    }
    return out;
  }
}
