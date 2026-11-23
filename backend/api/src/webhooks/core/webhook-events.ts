import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { Actor } from '../../access/core/actor.js';
import {
  allows,
  allowsManual,
  ANYWHERE,
  moduleTarget,
} from '../../access/core/allows.js';
import {
  InvalidContentError,
  NotFoundError,
  UnprocessableError,
} from '../../base/core/errors.js';
import { OpenSnapshotAction } from '../../content/core/actions/open-snapshot.action.js';
import type { OutboxEvent } from '../../outbox/core/outbox-feed.js';
import { ReleaseChangeReader } from '../../releases/core/actions/release-changes.action.js';
import type { Release } from '../../releases/core/release.js';
import type { ReleaseChange } from '../../releases/core/release-changes.js';
import { ReleaseStore } from '../../releases/core/release-store.js';
import type { DeliveryEvent, WebhookEvent } from './webhook.js';
import { capAudience } from './webhook-audience.js';

/**
 * Who reads content to judge an event that names no release (a module
 * deprecated at a commit): a service that reads every ref. What it reads
 * decides only whether an owner may know of the event, by their own
 * scope; nothing of it is sent but IDs.
 */
export const WEBHOOK_READER: Actor = Object.freeze({
  kind: 'service',
  // Outside the `UserId` format (":"), so no user can have this ID.
  id: 'service:webhooks',
  roles: Object.freeze([
    Object.freeze({
      id: 'webhook-reader',
      name: 'Webhooks (read-only)',
      permissions: Object.freeze(['content.read', 'content.read.draft']),
      scope: Object.freeze({}),
    }),
  ]),
}) as Actor;

/** The most module events one release makes per subscriber; the rest are left out (`complete: false`). */
export const MAX_MODULE_EVENTS = 1_000;

/** One event for one subscriber: what goes into its body. */
export interface OutgoingEvent {
  readonly type: WebhookEvent;
  /** The same for the same event whoever reads it, however often: SHA-256 hex. */
  readonly idempotencyKey: string;
  readonly data: Readonly<Record<string, unknown>>;
}

const Id = z.string().min(1).max(200);
const Commit = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);
const Lang = z.string().min(1).max(35);

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

/** `module.deprecated` (written on merge, #266): the module, where, why and its replacement. */
const ModuleDeprecated = z.object({
  moduleId: Id,
  lang: Lang.optional(),
  commit: Commit,
  reason: z.string().max(2_000).optional(),
  replacedBy: Id.nullable().optional(),
});

/** `manual.deprecated` (written on merge, #266): the manual, where, why and its replacement. */
const ManualDeprecated = z.object({
  manualId: Id,
  commit: Commit,
  reason: z.string().max(2_000).optional(),
  replacedBy: Id.nullable().optional(),
});

/** `translation.imported` (#51): the import and the change set it went into. */
const TranslationImported = z.object({
  importId: Id,
  changeSetId: Id.optional(),
});

/** The topics that make webhook events, and the events each makes. */
export const TOPIC_EVENTS: Readonly<Record<string, readonly WebhookEvent[]>> = {
  'release.published': ['manual.released', 'module.released'],
  'release.withdrawn': ['release.withdrawn'],
  'module.deprecated': ['module.deprecated'],
  'manual.deprecated': ['manual.deprecated'],
  'translation.imported': ['translation.imported'],
};

/** The idempotency key of an event: SHA-256 over its type and what identifies it. */
export function idempotencyKey(
  type: DeliveryEvent,
  ...parts: readonly string[]
): string {
  const hash = createHash('sha256').update(type);
  for (const part of parts) hash.update('\n').update(part);
  return hash.digest('hex');
}

/**
 * What an outbox row tells one subscriber (#42), as its owner may read
 * it: a subscriber only hears of content its owner's roles let them read
 * (`content.read`, in their scope), worked out again for every event.
 *
 * - `release.published` makes `manual.released`, one per manual the
 *   release changed as the owner sees it (`ReleaseChangeReader`, the same
 *   as `GET /releases/{id}/changes` answers them), with its languages, and
 *   `module.released`, one per module and language (at most
 *   `MAX_MODULE_EVENTS`), with its content hash (`contentHash`, the
 *   file's revision; null when removed). Past `too-many-changes` it makes
 *   a `manual.released` per manual the owner reads, the changes unknown
 *   (`complete: false`), and no module events.
 * - `release.withdrawn`: to an owner who reads released content anywhere
 *   (every reader may know a release).
 * - `module.deprecated`: when the owner may read the module (in its
 *   language, or in some language when the row names none) at the commit.
 * - `manual.deprecated` (#558): when the owner may read the manual (its
 *   audience) at the commit.
 * - `translation.imported`: to an owner holding `translation.manage` and
 *   `content.read.draft` (an import lands in a change set, a draft).
 *
 * Idempotency keys: `manual.released` over the release and the manual;
 * `module.released` over the release, the module, its language and its
 * content hash; the others over what they name. The same row read again
 * makes the same keys, so a subscriber gets each event once.
 *
 * Undefined: the row's payload is not what its topic writes. A topic that
 * makes no event: none.
 */
@Injectable()
export class WebhookEventBuilder {
  constructor(
    private readonly releases: ReleaseStore,
    private readonly changes: ReleaseChangeReader,
    private readonly openSnapshot: OpenSnapshotAction,
  ) {}

  /**
   * `maxAudience`: the subscriber's audience limit (#254): content is
   * judged as the owner reads it with every role capped at that level
   * (`capAudience`, by the configuration at the release's or the
   * deprecation's commit). A withdrawn release and a translation import
   * name no content of an audience, so they are not limited.
   */
  async of(
    event: OutboxEvent,
    owner: Actor,
    wanted: ReadonlySet<WebhookEvent>,
    maxAudience: string | null = null,
  ): Promise<OutgoingEvent[] | undefined> {
    const makes = TOPIC_EVENTS[event.topic] ?? [];
    if (!makes.some((type) => wanted.has(type))) return [];
    if (!allows(owner, 'content.read', ANYWHERE)) return [];
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
      case 'module.deprecated': {
        const parsed = ModuleDeprecated.safeParse(event.payload);
        if (!parsed.success) return undefined;
        const p = parsed.data;
        const told = await this.deprecationFor(owner, p, maxAudience);
        if (told === undefined) return [];
        return [
          {
            type: 'module.deprecated',
            idempotencyKey: idempotencyKey(
              'module.deprecated',
              p.moduleId,
              p.lang ?? '',
              p.commit,
            ),
            data: {
              moduleId: p.moduleId,
              ...(p.lang !== undefined && { lang: p.lang }),
              commit: p.commit,
              reason: p.reason ?? null,
              replacedBy: told.replacedBy,
            },
          },
        ];
      }
      case 'manual.deprecated': {
        const parsed = ManualDeprecated.safeParse(event.payload);
        if (!parsed.success) return undefined;
        const p = parsed.data;
        const told = await this.manualDeprecationFor(owner, p, maxAudience);
        if (told === undefined) return [];
        return [
          {
            type: 'manual.deprecated',
            idempotencyKey: idempotencyKey(
              'manual.deprecated',
              p.manualId,
              p.commit,
            ),
            data: {
              manualId: p.manualId,
              commit: p.commit,
              reason: p.reason ?? null,
              replacedBy: told.replacedBy,
            },
          },
        ];
      }
      case 'translation.imported': {
        const parsed = TranslationImported.safeParse(event.payload);
        if (!parsed.success) return undefined;
        const p = parsed.data;
        if (
          !allows(owner, 'translation.manage', ANYWHERE) ||
          !allows(owner, 'content.read.draft', ANYWHERE)
        ) {
          return [];
        }
        return [
          {
            type: 'translation.imported',
            idempotencyKey: idempotencyKey('translation.imported', p.importId),
            data: {
              importId: p.importId,
              changeSetId: p.changeSetId ?? null,
            },
          },
        ];
      }
      default:
        return [];
    }
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

  /**
   * What the owner is told of a deprecation: undefined when they may not
   * read the deprecated module at the commit (in its language, or in
   * some language when the row names none), or it is not there; else its
   * replacement, named only when they may read that too there, in some
   * language (else null), so no subscriber learns of a module outside
   * their scope (#43's security review). Judged with the audience limit.
   */
  private async deprecationFor(
    owner: Actor,
    p: z.infer<typeof ModuleDeprecated>,
    maxAudience: string | null,
  ): Promise<{ replacedBy: string | null } | undefined> {
    const at = await this.openSnapshot.handle({
      actor: WEBHOOK_READER,
      ref: p.commit,
    });
    if (at.commit !== p.commit) return undefined;
    const config = await at.config();
    if (maxAudience !== null) {
      owner = capAudience(
        owner,
        maxAudience,
        config.audiences.map((a) => a.id),
      );
    }
    const every = [config.languages.source, ...config.languages.targets];
    const readable = async (moduleId: string, langs: readonly string[]) => {
      for (const lang of langs) {
        const meta = await at.moduleMetaForCheck(moduleId, lang);
        if (meta === undefined || meta === 'unreadable') continue;
        if (
          allows(owner, 'content.read', moduleTarget({ ...meta, lang }, config))
        ) {
          return true;
        }
      }
      return false;
    };
    if (
      !(await readable(p.moduleId, p.lang !== undefined ? [p.lang] : every))
    ) {
      return undefined;
    }
    const replacedBy = p.replacedBy ?? null;
    return {
      replacedBy:
        replacedBy !== null && (await readable(replacedBy, every))
          ? replacedBy
          : null,
    };
  }

  /**
   * What the owner is told of a manual's deprecation (#558): undefined
   * when they may not read the manual at the commit (its audience; a
   * manifest that cannot be read counts as the most restricted level, as
   * notifications judge it) or it is not there; else its replacement,
   * named only when they may read that manual too there (else null).
   * Judged with the audience limit, as `deprecationFor`.
   */
  private async manualDeprecationFor(
    owner: Actor,
    p: z.infer<typeof ManualDeprecated>,
    maxAudience: string | null,
  ): Promise<{ replacedBy: string | null } | undefined> {
    const at = await this.openSnapshot.handle({
      actor: WEBHOOK_READER,
      ref: p.commit,
    });
    if (at.commit !== p.commit) return undefined;
    const config = await at.config();
    const audiences = config.audiences.map((a) => a.id);
    if (maxAudience !== null)
      owner = capAudience(owner, maxAudience, audiences);
    const readable = async (manualId: string) => {
      const manifest = await at.manifestForCheck(manualId);
      if (manifest === undefined) return false;
      return allowsManual(owner, 'content.read', {
        audiences,
        audience: manifest === 'unreadable' ? undefined : manifest.audience,
        lang: undefined,
      });
    };
    if (!(await readable(p.manualId))) return undefined;
    const replacedBy = p.replacedBy ?? null;
    return {
      replacedBy:
        replacedBy !== null && (await readable(replacedBy)) ? replacedBy : null,
    };
  }
}
