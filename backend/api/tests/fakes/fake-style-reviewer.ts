import {
  type ProposedSuggestion,
  type StyleReviewRequest,
  StyleReviewer,
} from '../../src/style-review/core/style-reviewer.js';

/**
 * A style reviewer in memory: records every request it was sent and
 * answers with `answer` (a function of the request, or a fixed list).
 * `hang` never answers (unless aborted, when it rejects), for timeouts;
 * `fail` rejects.
 */
export class FakeStyleReviewer extends StyleReviewer {
  readonly configured = true;
  readonly requests: StyleReviewRequest[] = [];
  answer:
    | readonly ProposedSuggestion[]
    | ((request: StyleReviewRequest) => readonly ProposedSuggestion[]) = [];
  hang = false;
  /** Ignores the signal while hanging, as a misbehaving adapter would. */
  ignoreSignal = false;
  fail: Error | undefined;

  review(
    request: StyleReviewRequest,
    signal: AbortSignal,
  ): Promise<readonly ProposedSuggestion[]> {
    this.requests.push(request);
    if (this.fail) return Promise.reject(this.fail);
    if (this.hang) {
      return new Promise((_, reject) => {
        if (!this.ignoreSignal) {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }
      });
    }
    return Promise.resolve(
      typeof this.answer === 'function' ? this.answer(request) : this.answer,
    );
  }
}
