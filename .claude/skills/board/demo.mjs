// The working board's example data (`board.mjs demo`), so the page can be seen before a real run
// fills it. It writes only into an empty board.
import { existsSync } from 'node:fs';
import path from 'node:path';

import { FILES, appendJsonl, writeJson } from './lib.mjs';

/** @param {string} dir */
export function seedDemo(dir) {
  const f = {
    state: path.join(dir, FILES.state),
    log: path.join(dir, FILES.log),
    timings: path.join(dir, FILES.timings),
    inbox: path.join(dir, FILES.inbox),
  };
  if ([f.state, f.log, f.timings, f.inbox].some((file) => existsSync(file))) {
    throw new Error(
      `${dir} already holds a board; demo only writes into an empty one`,
    );
  }
  const now = Date.now();
  const ago = (/** @type {number} */ hours) =>
    new Date(now - hours * 3_600_000).toISOString();
  writeJson(f.state, {
    updatedAt: ago(0),
    project: 'Example project · Sprint 3',
    client: 'the client',
    needsYou: [
      {
        id: 'n-approve-910',
        text: 'Approve PR #910 for merge',
        detail: 'Two clean review rounds; touches money.',
      },
      {
        id: 'n-env',
        text: 'Set MAIL_FROM in the hosted environment',
        detail: 'Needed before #905 can go live.',
      },
    ],
    questions: [
      {
        id: 'q-vat-reverse',
        text: 'Does a customer abroad get reverse-charged VAT on invoices, or do we leave them out for now?',
        options: ['Reverse charge', 'Out of scope for Sprint 3'],
      },
      {
        id: 'q-pdf-logo',
        text: 'Which logo goes on the invoice PDF: the full one or the mark only?',
      },
    ],
    waitingOnClient: [
      {
        id: 'c-terms',
        text: 'Payment terms per customer (14 or 30 days?)',
        since: ago(50),
      },
    ],
    lanes: [
      {
        id: 'lane-a',
        name: 'Lane A',
        issue: 912,
        title: 'Invoice numbering per year',
        status: 'Review round 2',
        next: '#915',
      },
      {
        id: 'lane-b',
        name: 'Lane B',
        issue: 905,
        title: 'Send invoice by e-mail',
        status: 'In progress',
        next: '#918',
      },
      {
        id: 'lane-c',
        name: 'Lane C',
        issue: null,
        title: '',
        status: 'Idle',
        next: '#920',
      },
    ],
    replies: [],
  });
  for (const [
    hours,
    text,
    issue,
  ] of /** @type {[number, string, number | undefined][]} */ ([
    [0.5, 'Review round 2 on #912: no critical or major findings', 912],
    [2, 'Merged #908 (credit notes) into sprint-3', 908],
    [3.2, 'Opened PR #910 for #909', 909],
    [26, 'Merged #901 (tax groups per rate)', 901],
    [28, 'Renumbered migrations after main’s newest', undefined],
  ])) {
    appendJsonl(f.log, { at: ago(hours), text, ...(issue ? { issue } : {}) });
  }
  const t = { issues: /** @type {Record<string, any>} */ ({}) };
  t.issues['901'] = {
    assignments: [{ lane: 'lane-a', from: ago(52) }],
    work: [
      { at: ago(30), minutes: 150, lane: 'lane-a' },
      { at: ago(27), minutes: 40, lane: 'lane-a' },
    ],
    title: 'Tax groups per rate',
    events: [
      { at: ago(52), status: 'In progress' },
      { at: ago(40), status: 'In review' },
      { at: ago(26), status: 'Done' },
    ],
    merged: ago(26),
    pauses: [{ from: ago(46), to: ago(36), reason: 'Night' }],
    rounds: [
      { at: ago(39), critical: 1, major: 2, minor: 3 },
      { at: ago(30), critical: 0, major: 0, minor: 1 },
    ],
    friction: [
      {
        at: ago(39),
        category: 'review-finding',
        note: 'Rounding per line instead of per group',
        minutes: 45,
      },
      {
        at: ago(28),
        category: 'migration-renumber',
        note: 'main moved on during review',
        minutes: 15,
      },
    ],
  };
  t.issues['908'] = {
    assignments: [{ lane: 'lane-b', from: ago(9) }],
    work: [{ at: ago(3), minutes: 95, lane: 'lane-b' }],
    title: 'Credit notes',
    events: [
      { at: ago(9), status: 'In progress' },
      { at: ago(5), status: 'In review' },
      { at: ago(2), status: 'Done' },
    ],
    merged: ago(2),
    pauses: [],
    rounds: [{ at: ago(4), critical: 0, major: 1, minor: 2 }],
    friction: [
      {
        at: ago(6),
        category: 'flaky-test',
        note: 'e2e date picker timing',
        minutes: 20,
      },
    ],
  };
  t.issues['912'] = {
    assignments: [{ lane: 'lane-a', from: ago(6) }],
    work: [
      { at: ago(2), minutes: 120, lane: 'lane-a' },
      { at: ago(0.6), minutes: 25, lane: 'lane-a' },
    ],
    title: 'Invoice numbering per year',
    events: [
      { at: ago(6), status: 'In progress' },
      { at: ago(1.5), status: 'In review' },
    ],
    pauses: [{ from: ago(4), to: ago(3.5), reason: 'Usage limit' }],
    rounds: [
      { at: ago(1.2), critical: 0, major: 2, minor: 1 },
      { at: ago(0.5), critical: 0, major: 0, minor: 2 },
    ],
    friction: [
      {
        at: ago(4),
        category: 'limit',
        note: 'Usage limit, 30 minutes',
        minutes: 30,
      },
    ],
  };
  t.issues['905'] = {
    assignments: [{ lane: 'lane-b', from: ago(3) }],
    work: [{ at: ago(1), minutes: 70, lane: 'lane-b' }],
    title: 'Send invoice by e-mail',
    events: [{ at: ago(3), status: 'In progress' }],
    pauses: [],
    rounds: [],
    friction: [
      {
        at: ago(1),
        category: 'spec-gap',
        note: 'Which address: billing e-mail or contact?',
      },
    ],
  };
  writeJson(f.timings, t);
}
