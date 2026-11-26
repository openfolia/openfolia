import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { Actor } from '../../access/core/actor.js';
import {
  allows,
  allowsManual,
  moduleTarget,
} from '../../access/core/allows.js';
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
import { DEPRECATION_WEBHOOK_EVENTS } from '../change-sets.webhook-events.js';

const Id = z.string().min(1).max(200);
const Commit = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);
const Lang = z.string().min(1).max(35);

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

/**
 * The deprecations' webhook events (`change-sets.webhook-events.ts`), as the owner of a
 * subscriber may read them (#42), each judged with the subscriber's audience limit by the
 * configuration at the deprecation's commit:
 *
 * - `module.deprecated`: when the owner may read the module (in its
 *   language, or in some language when the row names none) at the commit.
 * - `manual.deprecated` (#558): when the owner may read the manual (its
 *   audience) at the commit.
 *
 * Idempotency keys over what they name: the module, its language and the commit; the manual
 * and the commit.
 *
 * Who covers any owner of a subscriber to one of them: whoever reads content restricting
 * nothing; nothing more is needed.
 */
@Injectable()
export class DeprecationWebhookHandler extends WebhookEventHandler {
  readonly group = DEPRECATION_WEBHOOK_EVENTS.group;

  constructor(private readonly openSnapshot: OpenSnapshotAction) {
    super();
  }

  async build(
    event: OutboxEvent,
    owner: Actor,
    _wanted: ReadonlySet<WebhookEvent>,
    maxAudience: string | null,
  ): Promise<OutgoingEvent[] | undefined> {
    switch (event.topic) {
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
      default:
        return [];
    }
  }

  coversAnyOwner(): boolean {
    return true;
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
