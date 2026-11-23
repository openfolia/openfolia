import {
  isTextRange,
  type Module,
  type PlainText,
  plainTextOf,
  type TranslatableField,
  sha256Hex,
  translatableUnits,
} from '@openfolia/content-model';
import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { AuditLog } from '../../../audit/core/audit-log.js';
import {
  NotConfiguredError,
  TooManyRequestsError,
  UnavailableError,
  UnprocessableError,
} from '../../../base/core/errors.js';
import { UnitOfWork } from '../../../base/core/unit-of-work.js';
import { GetWorkingCopyAction } from '../../../change-sets/core/actions/get-working-copy.action.js';
import { changeSetBranch } from '../../../change-sets/core/change-set.js';
import { subjectKey } from '../../../change-sets/core/lock.js';
import { OpenSnapshotAction } from '../../../content/core/actions/open-snapshot.action.js';
import { SlidingWindowLimit } from '../../../base/core/rate-limit.js';
import {
  type ProposedSuggestion,
  type StyleReviewRequest,
  StyleReviewer,
  StyleReviewLimits,
} from '../style-reviewer.js';
import type { StyleReview, StyleSuggestion } from '../style-suggestion.js';

/** The most text one review sends (UTF-16 code units, style guide included): a cost limit. */
export const MAX_REVIEW_CHARS = 100_000;
/** Reviews one server runs at once; more are 503 `style-review-busy`. */
export const MAX_CONCURRENT_REVIEWS = 8;
/** The most suggestions a review keeps (in document order). */
export const MAX_SUGGESTIONS = 200;
/** A suggestion's longest message and replacement; longer ones are dropped. */
export const MAX_MESSAGE_LENGTH = 1_000;
export const MAX_REPLACEMENT_LENGTH = 2_000;

export interface ReviewModuleStyleInput {
  readonly actor: Actor;
  readonly changeSetId: string;
  readonly lang: string;
  readonly moduleId: string;
}

/**
 * A model's style and consistency suggestions for one module of a change
 * set (#248): its working copy, else the file committed on its branch,
 * read as `GetWorkingCopyAction` reads it (only the change set's author,
 * only within their reading scope; 403 or 404 otherwise). Off unless a
 * reviewer is configured (404 `not-configured`, before anything is read).
 *
 * Only the module's translatable text (`translatableUnits`, as
 * `plainTextOf` gives it) and the configured `styleGuide` are sent: no
 * metadata, no comments, no other module. At most `MAX_REVIEW_CHARS`
 * (422 `too-large`), `StyleReviewLimits.perMinute` per actor (429
 * `rate-limited`), `MAX_CONCURRENT_REVIEWS` at once (503
 * `style-review-busy`) and `timeoutMs` long (503 `style-review-timeout`).
 *
 * What comes back is untrusted advice: each suggestion must name a unit
 * and part that was sent and a range of its typed text (`isTextRange`),
 * with a bounded message and a replacement that fits in a text run;
 * anything else is dropped (counted in `dropped`). Nothing it says is
 * acted on. Not stored; one `module.style-review` audit event per review
 * (who, which module, the outcome and how many suggestions), never text.
 */
@Injectable()
export class ReviewModuleStyleAction extends ActorAction<
  ReviewModuleStyleInput,
  StyleReview
> {
  readonly policy = 'content.edit';

  /** Made on first use: the policy check comes before any use of the dependencies. */
  private perActor: SlidingWindowLimit | undefined;
  private running = 0;

  constructor(
    private readonly reviewer: StyleReviewer,
    private readonly limits: StyleReviewLimits,
    private readonly getWorkingCopy: GetWorkingCopyAction,
    private readonly openSnapshot: OpenSnapshotAction,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
  ) {
    super();
  }

  protected async run({
    actor,
    changeSetId,
    lang,
    moduleId,
  }: ReviewModuleStyleInput): Promise<StyleReview> {
    if (!this.reviewer.configured) {
      throw new NotConfiguredError(
        'The style review is not set up on this server.',
      );
    }
    const view = await this.getWorkingCopy.handle({
      actor,
      changeSetId,
      subject: { type: 'module', lang, moduleId },
    });
    const module = view.content as Module;
    const subject = subjectKey(view.subject);
    const snapshot = await this.openSnapshot.handle({
      actor,
      ref: changeSetBranch(changeSetId),
    });
    const { styleGuide } = await snapshot.config();

    const sent = unitsOf(module);
    const request: StyleReviewRequest = {
      lang: module.meta.lang,
      units: sent.map(({ blockId, kind, parts }) => ({
        blockId,
        kind,
        parts: parts.map(({ field, plain }) => ({ field, text: plain.text })),
      })),
      styleGuide,
    };
    const size =
      (styleGuide?.length ?? 0) +
      sent.reduce(
        (n, u) => n + u.parts.reduce((m, p) => m + p.plain.text.length, 0),
        0,
      );
    if (size > MAX_REVIEW_CHARS) {
      throw new UnprocessableError(
        'too-large',
        `The module's text is too long for a style review (at most ${MAX_REVIEW_CHARS} characters with the style guide).`,
        { max: MAX_REVIEW_CHARS },
      );
    }
    // Before the rate limit, so a busy server does not use up the caller's reviews.
    if (this.running >= MAX_CONCURRENT_REVIEWS) throw busy();
    this.perActor ??= new SlidingWindowLimit(this.limits.perMinute);
    const allowed = this.perActor.take(`${actor.kind}:${actor.id}`);
    if (!allowed.ok) {
      throw new TooManyRequestsError(
        `At most ${this.limits.perMinute} style reviews a minute.`,
        allowed.retryAfterSeconds,
      );
    }

    const result: StyleReview = {
      changeSetId,
      lang: view.subject.type === 'module' ? view.subject.lang : lang,
      moduleId,
      version: view.version,
      baseCommit: view.baseCommit,
      suggestions: [],
      dropped: 0,
    };
    if (sent.length === 0) {
      await this.audit(actor, subject.id, changeSetId, 'empty', 0, 0);
      return result;
    }
    const proposed = await this.ask(request, actor, subject.id, changeSetId);
    const { suggestions, dropped } = checked(proposed, sent);
    await this.audit(
      actor,
      subject.id,
      changeSetId,
      'ok',
      suggestions.length,
      dropped,
    );
    return { ...result, suggestions, dropped };
  }

  /** The reviewer's answer, within the concurrency bound and the timeout. */
  private async ask(
    request: StyleReviewRequest,
    actor: Actor,
    moduleKey: string,
    changeSetId: string,
  ): Promise<readonly ProposedSuggestion[]> {
    if (this.running >= MAX_CONCURRENT_REVIEWS) throw busy();
    this.running++;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(TIMED_OUT);
      }, this.limits.timeoutMs);
    });
    // Counted until the adapter's own call settles, so one that ignores the
    // signal still counts against the bound after the request has ended.
    const call = Promise.resolve()
      .then(() => this.reviewer.review(request, controller.signal))
      .finally(() => this.running--);
    try {
      // Raced, so an adapter that ignores the signal still cannot hold the request.
      return await Promise.race([call, timedOut]);
    } catch (error) {
      const timeout = error === TIMED_OUT || controller.signal.aborted;
      // The request fails anyway: an audit write failing too must not hide
      // why (it is a database problem, reported by the database's own health).
      await this.audit(
        actor,
        moduleKey,
        changeSetId,
        timeout ? 'timeout' : 'failed',
        0,
        0,
      ).catch(() => undefined);
      // The adapter's error is not passed on: it may name the endpoint.
      throw timeout
        ? new UnavailableError(
            'style-review-timeout',
            'The style review took too long; try again later.',
            Math.max(1, Math.ceil(this.limits.timeoutMs / 1000)),
          )
        : new UnavailableError(
            'style-review-unavailable',
            'The style review could not be done; try again later.',
            30,
          );
    } finally {
      clearTimeout(timer);
      controller.abort();
      // Settled or not, its outcome is no longer anyone's.
      call.catch(() => undefined);
    }
  }

  private audit(
    actor: Actor,
    moduleKey: string,
    changeSetId: string,
    outcome: 'ok' | 'empty' | 'timeout' | 'failed',
    suggestions: number,
    dropped: number,
  ): Promise<void> {
    return this.unit.run((tx) =>
      this.auditLog.record(tx, actor, {
        action: 'module.style-review',
        subject: { type: 'module', id: moduleKey },
        data: { changeSetId, outcome, suggestions, dropped },
      }),
    );
  }
}

const TIMED_OUT = Symbol('timed out');

const busy = () =>
  new UnavailableError(
    'style-review-busy',
    'Too many style reviews are running; try again shortly.',
    5,
  );

interface SentUnit {
  readonly blockId: string;
  readonly kind: string;
  readonly parts: readonly {
    readonly field: TranslatableField;
    readonly plain: PlainText;
  }[];
}

function unitsOf(module: Module): SentUnit[] {
  // A callout's legend (#548) is a unit of its own, by the callout's ID and field `legend` (#573).
  return translatableUnits(module).map((unit) => ({
    blockId: unit.blockId,
    kind: unit.kind,
    parts: unit.parts.map((part) => ({
      field: part.field,
      plain: plainTextOf(part.content),
    })),
  }));
}

/**
 * No line breaks, control characters or invisible format characters
 * (direction overrides, zero-width characters; ZWNJ and ZWJ, which some
 * scripts need, aside): a replacement goes into one text run, and never
 * hides text that shows differently from what is stored.
 */
const RUN_TEXT =
  /^(?:(?![\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}])[^]|\u200c|\u200d)*$/u;
/** What a message loses: control and format characters (a message is shown as plain text). */
const UNSHOWN = /(?![\u200c\u200d])[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu;

/**
 * The proposals that fit the text sent, as suggestions in document order
 * (unit, part, start), without duplicates, at most `MAX_SUGGESTIONS`; and
 * how many were dropped.
 */
function checked(
  proposed: readonly ProposedSuggestion[],
  sent: readonly SentUnit[],
): { suggestions: StyleSuggestion[]; dropped: number } {
  const places = new Map<string, Place>();
  let order = 0;
  for (const unit of sent) {
    for (const part of unit.parts) {
      places.set(placeKey(unit.blockId, part.field), {
        order: order++,
        blockId: unit.blockId,
        field: part.field,
        plain: part.plain,
      });
    }
  }
  const kept = new Map<
    string,
    { order: number; suggestion: StyleSuggestion }
  >();
  let dropped = 0;
  for (const p of Array.isArray(proposed) ? proposed : []) {
    const suggestion = toSuggestion(p, places);
    if (!suggestion || kept.has(suggestion.suggestion.id)) {
      dropped++;
      continue;
    }
    kept.set(suggestion.suggestion.id, suggestion);
  }
  const ordered = [...kept.values()]
    .sort(
      (a, b) =>
        a.order - b.order ||
        a.suggestion.range.start - b.suggestion.range.start ||
        a.suggestion.range.end - b.suggestion.range.end,
    )
    .map((k) => k.suggestion);
  const suggestions = ordered.slice(0, MAX_SUGGESTIONS);
  return {
    suggestions,
    dropped: dropped + ordered.length - suggestions.length,
  };
}

function toSuggestion(
  p: ProposedSuggestion,
  places: ReadonlyMap<string, Place>,
): { order: number; suggestion: StyleSuggestion } | undefined {
  if (typeof p !== 'object' || p === null) return undefined;
  if (typeof p.blockId !== 'string' || typeof p.field !== 'string') {
    return undefined;
  }
  const place = places.get(placeKey(p.blockId, p.field));
  if (!place || !isTextRange(place.plain, p.start, p.end)) return undefined;
  if (typeof p.message !== 'string') return undefined;
  const message = p.message.replace(UNSHOWN, ' ').replace(/\s+/g, ' ').trim();
  if (message.length === 0 || message.length > MAX_MESSAGE_LENGTH) {
    return undefined;
  }
  const original = place.plain.text.slice(p.start, p.end);
  let replacement: string | null = null;
  if (p.replacement !== undefined && p.replacement !== null) {
    if (
      typeof p.replacement !== 'string' ||
      p.replacement.length > MAX_REPLACEMENT_LENGTH ||
      !RUN_TEXT.test(p.replacement) ||
      p.replacement === original
    ) {
      return undefined;
    }
    replacement = p.replacement;
  }
  const range = { start: p.start, end: p.end };
  const id = sha256Hex(
    JSON.stringify([
      p.blockId,
      p.field,
      range.start,
      range.end,
      replacement,
      message,
    ]),
  ).slice(0, 32);
  return {
    order: place.order,
    suggestion: {
      id,
      blockId: place.blockId,
      field: place.field,
      range,
      original,
      message,
      replacement,
      rule: 'model',
    },
  };
}

/** A part of a unit that was sent, in document order. */
interface Place {
  readonly order: number;
  readonly blockId: string;
  readonly field: TranslatableField;
  readonly plain: PlainText;
}

const placeKey = (blockId: string, field: string) =>
  JSON.stringify([blockId, field]);
