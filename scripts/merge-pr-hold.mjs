// The open review findings that hold `pnpm merge:pr` (scripts/merge-pr-flow.mjs reads
// them before and again right before the merge), as plain functions a test can pin: who wrote
// each comment and review, whether it is wholly an all-clear or reads like a finding, and
// whether a later comment by another author answers it. Over ~250 lines on purpose: one rule
// (what holds, what answers it) whose word lists and helpers only make sense together.

/**
 * A page of a PR's review threads (GraphQL; `{owner}`/`{repo}` are filled in by gh; `$after`:
 * the previous page's endCursor, left out for the first), and gh's own login (`viewer`). The
 * flow reads every page.
 */
export const REVIEW_THREADS_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  viewer { login }
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        nodes { isResolved path comments(first: 1) { nodes { author { login } body } } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

/**
 * Words a security finding uses, access ones included (an RLS gap, an auth bypass, an IDOR, a
 * leak rarely says "security"), and the other classes a review names (a redirect, a traversal,
 * a race, a denial of service, a missing rate limit, …): whole words or their stems, any case.
 */
const SECURITY = new RegExp(
  `\\b(?:${[
    'rls',
    'row[- ]level',
    'polic(?:y|ies)',
    'auth(?:entication|orization)?[- ]bypass\\w*',
    'bypass\\w*',
    'access[- ]control',
    'privileges?',
    'escalat\\w*',
    'idor',
    'permissions?',
    'unauthori[sz]ed',
    'leak\\w*',
    'expos(?:e|es|ed|ing|ure)',
    'tenants?',
    'service[_ ]role',
    'csrf',
    'xss',
    'ssrf',
    'injection',
    'secrets?',
    'credentials?',
    'tokens?',
    'vulnerab\\w*',
    '\\w*secur\\w*',
    'cve',
    'redirect\\w*',
    'travers\\w*',
    'races?',
    'racy',
    'toctou',
    'dos',
    'denial[- ]of[- ]service',
    'rate[- ]?limit\\w*',
    'enumerat\\w*',
    'csp',
    'cors',
    'deserializ\\w*',
    'sandbox\\w*',
    'escap\\w*',
    'unsafe\\w*',
  ].join('|')})\\b`,
  'i',
);
/**
 * An all-clear: the whole comment is one "no findings" sentence (an optional heading or
 * `Security:` before it), nothing else. A comment that says more is read as findings.
 */
const CLEAN =
  /^\s*(?:#+\s*)?(?:security(?: review)?\s*[:-]?\s*)?(?:✅\s*)?no (?:security )?(?:findings|issues|vulnerabilities)(?: found)?\.?\s*$/i;

/**
 * A short approval: nothing but approving words ("LGTM", "looks good (to me)", "approved",
 * "ship it", "nice", "thanks", 👍, ✅, 🚀) and punctuation. Text made of these alone can carry
 * no finding; anything more from another author holds until answered.
 */
const APPROVAL =
  /^(?:\s|[.,!:;-]|lgtm|looks good(?: to me)?|approved?|ship it|nice|great|thanks|thank you|👍|✅|🚀)+$/iu;

/**
 * The shape of a finding, whatever its words: a severity label (`(high)`, `Low:`, `severity:
 * high`), a vulnerability, a missing owner check, what any signed-in person or another person's
 * record is open to, a check that is never made.
 */
const SHAPE = new RegExp(
  [
    String.raw`\bseverity\b`,
    String.raw`(?:^|[\s([*])(?:critical|high|medium|low)(?:[\s-]+(?:severity|risk|impact))?\s*(?:[:)\]]|\*\*)`,
    String.raw`\bvulnerab\w*`,
    String.raw`\b(?:owner|ownership)[- ]checks?\b`,
    String.raw`\bany (?:signed[- ]in|authenticated|logged[- ]in) (?:user|person|member|account)s?\b`,
    String.raw`\banother (?:user|person|member|tenant|account)(?:'|’)s\b`,
    String.raw`\bnever (?:checks?|verif(?:y|ies)|validates?)\b`,
    // A hold in plain words: don't merge, a blocker, a missing admin or role check, what anyone
    // or other people can do, data lost.
    String.raw`\b(?:do not|don(?:'|’)?t) merge\b|\bblock(?:er|ing)\b|\bhold off\b`,
    String.raw`\b(?:admin|role) checks?\b|\bnon-admins?\b|\bnot restricted\b|\bskips? the\b[^.\n]*\bchecks?\b`,
    String.raw`\b(?:doesn(?:'|’)?t|does not|don(?:'|’)?t|do not) check\b`,
    String.raw`\banyone\b|\bany user\b|\bother people(?:'|’)s\b|\banother person(?:'|’)s\b`,
    String.raw`\b(?:drops?|deletes?)\b[^.\n]*\b(?:data|rows?|records?)\b|\bdata loss\b`,
  ].join('|'),
  'im',
);
/**
 * A reply that keeps a finding open, or raises another: "not fixed (yet)", "still", "also",
 * "another", "a new issue", "as well", "remains", "but", "however", "separately".
 */
const STILL_OPEN =
  /\b(?:not|isn't|is not|wasn't|hasn't|haven't|never|no longer)\s+(?:yet\s+)?(?:been\s+)?(?:fixed|resolved|addressed)\b|\b(?:still|also|additionally|another|unfixed|remains?|but|however|separately|though)\b|\bnew (?:finding|issue|problem|bug|hole|leak)\b|\bas well\b/i;

/**
 * A reply's answer: it says the finding is resolved (`fixed in <sha>`, `resolved in <sha>`, a
 * 7–40 character hex SHA with at least one letter; `fixed by <sha | #PR | URL>`) or doesn't
 * apply (`not applicable`, `does not apply`, `doesn't apply`, `false positive`, `by design`).
 * Anything else ("good catch, will fix", "+1", "fix pending", "won't fix") answers nothing.
 */
const SHA_REF = String.raw`(?=[0-9]*[a-f])[0-9a-f]{7,40}\b`;
const ANSWER = new RegExp(
  [
    String.raw`\b(?:fixed|resolved) in ${SHA_REF}`,
    String.raw`\bfixed by (?:${SHA_REF}|#\d+\b|https?:\/\/\S)`,
    String.raw`\bnot applicable\b|\b(?:does not|doesn(?:'|’)?t) apply\b`,
    String.raw`\bfalse positive\b|\bby design\b`,
  ].join('|'),
  'i',
);
/** An answer phrase negated ("not a false positive", "isn't by design"). */
const NEGATED_ANSWER =
  /\b(?:not|isn(?:'|’)?t|wasn(?:'|’)?t|never|no)\s+(?:a\s+|really\s+)?(?:false positive|by design)\b/i;

const login = (item) => item.author?.login ?? '';

/**
 * Whether a text reads like a security finding (its words or its shape: SECURITY, SHAPE, the
 * word "finding") and isn't wholly an all-clear.
 */
const readsLikeFinding = (body) => {
  const text = String(body ?? '');
  return (
    (SECURITY.test(text) || SHAPE.test(text) || /\bfindings?\b/i.test(text)) &&
    !CLEAN.test(text)
  );
};

/** Whether a body is wholly an all-clear: empty, a "no findings", or a short approval. */
const allClear = (body) => {
  const text = String(body ?? '').trim();
  return text === '' || CLEAN.test(text) || APPROVAL.test(text);
};

/**
 * Whether a comment or review was written by gh's own login (the viewer: `viewerDidAuthor`, or
 * a login in `own`: the viewer's and the PR author's). The shared login the agents and the
 * background security-review hook post under, so its notes hold only when they read like a
 * finding; everyone else's hold unless wholly an all-clear. An author it can't name is
 * another's (fail closed).
 */
const isOwn = (item, own) =>
  item.viewerDidAuthor === true || own.has(login(item));

/** Whether an item holds until answered: another's unless an all-clear, the viewer's finding. */
const needsAnswer = (item, own) =>
  isOwn(item, own) ? readsLikeFinding(item.body) : !allClear(item.body);

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The body without its quoted (`>`) lines. */
const unquotedLines = (body) =>
  String(body ?? '')
    .split('\n')
    .filter((line) => !/^\s*>/.test(line))
    .join('\n');

/**
 * Whether a comment that links a finding raises one itself (keeps it open, or adds another), so
 * it is no answer: its own words outside quoted lines (links left out: a repository's name is
 * no finding) have a finding's shape (SHAPE: a severity, "anyone", "don't merge", a missing
 * check, …) or say it is still open or name another ("not fixed", "but", "also",
 * "separately"). Security words alone don't: an answer explains itself in the finding's own
 * words ("false positive: the function is service_role only"), and it must say it is fixed or
 * doesn't apply (pureReply) to answer at all.
 */
const raisesFinding = (body) => {
  const own = unquotedLines(body).replace(/https?:\/\/\S+/g, ' ');
  return SHAPE.test(own) || STILL_OPEN.test(own);
};

/** Whether `later`'s quoted (`>`) lines hold a line of `finding`'s text. */
function quotes(later, finding) {
  const quoted = String(later.body ?? '')
    .split('\n')
    .filter((line) => /^\s*>/.test(line))
    .map((line) => line.replace(/^\s*(?:>\s*)+/, '').trim())
    .filter(Boolean);
  const lines = String(finding.body ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return quoted.some((line) =>
    lines.some((own) => own.includes(line) || line.includes(own)),
  );
}

/**
 * Whether `later` links `comment`: it holds its URL (as GitHub's "Copy link" gives it, followed
 * by no further digit: `#issuecomment-123` is not inside `#issuecomment-1234`) outside its
 * quoted lines, and someone else wrote it (an author never answers itself). A comment without a
 * URL can't be linked, so it stays open (merge:pr's usage).
 */
const links = (comment) => (later) =>
  Boolean(comment.url) &&
  login(later) !== login(comment) &&
  new RegExp(`${escape(comment.url)}(?!\\d)`).test(unquotedLines(later.body));

/** Whether a body's own words (outside quoted lines) say the finding is fixed or doesn't apply. */
const saysAnswered = (body) => {
  const own = unquotedLines(body);
  return ANSWER.test(own) && !NEGATED_ANSWER.test(own);
};

/**
 * Whether a linking `later` is a pure reply to `target`: it says it is fixed or doesn't apply
 * (ANSWER: an acknowledgement is no answer), doesn't quote it (a quote reply carries the
 * finding on) and raises no finding itself ("NOT fixed yet", "fixed in abc1234, but the RLS
 * policy now …": raisesFinding).
 */
const pureReply = (later, target) =>
  saysAnswered(later.body) &&
  !quotes(later, target) &&
  !raisesFinding(later.body);

/**
 * Whether `target` is answered by the `laters` (in order) that link it (`linked`): the last one
 * that does decides, so a later finding-like comment linking it opens it again.
 */
function answeredBy(target, laters, linked) {
  let answered = false;
  for (const later of laters) {
    if (linked(later)) answered = pureReply(later, target);
  }
  return answered;
}

/** Whether `later` answers `comment`: links it, as a pure reply. */
const answers = (comment) => (later) =>
  links(comment)(later) && pureReply(later, comment);

/**
 * Which comments hold until answered (by index): every one by another author that isn't wholly
 * an all-clear (`claude`, `coderabbitai`: a GitHub App's login comes without `[bot]`, so its
 * name can't tell a finding from a note), and the viewer's that read like a finding. A pure
 * reply to an earlier held comment or review (links it, another author, raises nothing itself)
 * isn't one: else every answer would need an answer of its own.
 */
function findings(comments, reviewFindings, own) {
  const found = new Set();
  comments.forEach((comment, i) => {
    if (!needsAnswer(comment, own)) return;
    const reply =
      comments.some(
        (earlier, j) => j < i && found.has(j) && answers(earlier)(comment),
      ) || reviewFindings.some((review) => answersReview(review)(comment));
    if (!reply) found.add(i);
  });
  return found;
}

/** Who wrote a held comment, for the message. */
function heldBy(comment, own) {
  const where = comment.url ? ` (${comment.url})` : '';
  const by = login(comment) || 'an unknown author';
  if (!isOwn(comment, own)) return `an unanswered comment by ${by}${where}`;
  return `an unanswered security comment by ${by}${where} (yours: if it is no finding, edit it into a plain note, or have someone else answer it)`;
}

const time = (value) =>
  typeof value === 'string' ? Date.parse(value) : Number.NaN;

/** When a comment (`createdAt`) or a review (`submittedAt`) was written. */
const writtenAt = (item) => time(item.createdAt ?? item.submittedAt);

/**
 * Whether `later` (a comment or a review) names a PR review (`gh pr view --json reviews`:
 * `{ id, author, body, state, submittedAt }`, no URL): another author wrote it after the review
 * (both times known: a comment's `createdAt`, a review's `submittedAt`), and it names the
 * review's `id` outside quoted lines, followed by no further id character. A review without an
 * id, or a time missing, is never answered (fail closed).
 */
const namesReview = (review) => (later) => {
  const submitted = time(review.submittedAt);
  return (
    Boolean(review.id) &&
    login(later) !== login(review) &&
    !Number.isNaN(submitted) &&
    writtenAt(later) > submitted &&
    new RegExp(`${escape(review.id)}(?![\\w-])`).test(unquotedLines(later.body))
  );
};

/** Whether `later` answers a PR review: names it, as a pure reply. */
const answersReview = (review) => (later) =>
  namesReview(review)(later) && pureReply(later, review);

/**
 * The PR's reviews whose summary holds until answered (by index; as with comments: another
 * author's unless an all-clear, the viewer's that read like a finding), a review that answers
 * an earlier one aside.
 */
function reviewFindings(reviews, own) {
  const found = new Set();
  reviews.forEach((review, i) => {
    if (!needsAnswer(review, own)) return;
    const reply = reviews.some(
      (earlier, j) => j < i && found.has(j) && answersReview(earlier)(review),
    );
    if (!reply) found.add(i);
  });
  return reviews.filter((_, i) => found.has(i));
}

/**
 * What the PR's reviews hold the merge for: a review requesting changes that its author hasn't
 * followed with an approval, and a review whose summary holds (reviewFindings) that neither a
 * later approval by its author (another's, never the viewer's own) nor a later review or
 * comment by another author answering it by its id clears.
 */
function reviewHolds(reviews, found, comments, own) {
  const held = [];
  reviews.forEach((review, i) => {
    const by = login(review) || 'an unknown author';
    const approvedLater = reviews
      .slice(i + 1)
      .some(
        (next) => login(next) === login(review) && next.state === 'APPROVED',
      );
    if (review.state === 'CHANGES_REQUESTED' && !approvedLater) {
      held.push(`a review requesting changes by ${by}`);
    } else if (
      found.includes(review) &&
      !(approvedLater && login(review) !== '' && !isOwn(review, own)) &&
      !answeredBy(
        review,
        [...reviews, ...comments].sort((a, b) => writtenAt(a) - writtenAt(b)),
        namesReview(review),
      )
    ) {
      held.push(`an unanswered review by ${by} (id ${review.id ?? 'unknown'})`);
    }
  });
  return held;
}

/**
 * Why open review findings hold the merge, or null. `threads`: the PR's review threads
 * (`{ isResolved, path, comments: { nodes: [{ author, body }] } }`); `comments`: its comments in
 * order (`{ author: { login }, body, url, createdAt?, viewerDidAuthor? }`); `reviews`: its
 * reviews in order (`{ id, author, body, state, submittedAt }`); `viewer`: gh's own login (the
 * PR's author, `pr.author.login`, counts as the viewer too). Fail-closed by structure, not by a
 * word list: an unresolved review thread holds; a comment or review summary by anyone but the
 * viewer holds unless it is wholly an all-clear ("no findings", or a short approval: "LGTM",
 * "looks good", "approved", 👍); the viewer's own (the shared login the agents and the
 * background security-review hook post under) hold when they read like a finding (security
 * words or a finding's shape). A held comment is answered by a later comment from another
 * author that links its URL as a pure reply (it says it is fixed or doesn't apply: ANSWER), a
 * held review by one that names its id the same way; an acknowledgement, a reply with a
 * finding's shape, one saying it is still open, or one quoting it, is no answer, and the last
 * linking comment decides. A review requesting
 * changes holds until its author approves; another author's later approval also clears their
 * own earlier review summaries. When unsure, it holds.
 */
export function securityHold({
  pr,
  threads,
  comments,
  reviews = [],
  viewer = null,
}) {
  const own = new Set([viewer, pr.author?.login].filter(Boolean));
  const open = threads.filter((thread) => !thread.isResolved);
  const reviewed = reviewFindings(reviews, own);
  const found = findings(comments, reviewed, own);
  const unanswered = comments.filter(
    (comment, i) =>
      found.has(i) &&
      !answeredBy(comment, comments.slice(i + 1), links(comment)),
  );
  const fromReviews = reviewHolds(reviews, reviewed, comments, own);
  if (open.length === 0 && unanswered.length === 0 && fromReviews.length === 0)
    return null;
  const where = [
    ...open.map(
      (thread) => `an unresolved review thread on ${thread.path ?? 'the PR'}`,
    ),
    ...unanswered.map((comment) => heldBy(comment, own)),
    ...fromReviews,
  ];
  return `PR #${pr.number} has open review findings (${where.join('; ')}). Its branch owner answers them first (a fix, or a reply saying exactly why one doesn't apply: a thread resolved; a comment answered by a later PR comment from another author that links it by its URL, a review by one that names its id, either a pure reply that says "fixed in <sha>", "fixed by <sha|#PR|URL>", "resolved in <sha>", "not applicable", "doesn't apply", "false positive" or "by design" and names no finding of its own; a review requesting changes by its author's approval); merge after that.`;
}
