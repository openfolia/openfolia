import { type LocalizedText, textIn } from '@openfolia/content-model/core';
import {
  archiveBlocked,
  afterRetry,
  canPlanAgain,
  anyPending,
  groupOutputs,
  OFFLINE_PACKAGES,
  donePercent,
  inProgress,
  notesByLanguageOf,
  notesProblem,
  notesShown,
  NOTES_SUMMARY,
  productFacetOf,
  productLabel,
  progressBadgeKey,
  progressKey,
  progressKind,
  progressParams,
  reasonProblem,
  releaseStateOf,
  revisionProblem,
  sameProgress,
  shortCommit,
  outputNames,
} from './releases-model';
import {
  config,
  manual,
  output,
  progress,
  refused,
  release,
} from './testing/releases';

describe('releases-model', () => {
  it('tells a release published or withdrawn by its withdrawal', () => {
    expect(releaseStateOf(release())).toBe('published');
    expect(
      releaseStateOf(
        release({
          withdrawal: {
            reason: 'Wrong torque',
            by: { kind: 'user', id: 'p' },
            at: '2026-11-18T12:00:00Z',
          },
        } as never),
      ),
    ).toBe('withdrawn');
  });

  it('sums up the files: preparing, rendering, failed, ready or none', () => {
    expect(progressKind(progress('planning'))).toBe('preparing');
    expect(progressKind(progress('done'))).toBe('none');
    expect(progressKind(progress('rendering', 14, 12))).toBe('rendering');
    expect(progressKind(progress('failed', 14, 12, 2))).toBe('failed');
    expect(progressKind(progress('done', 14, 14))).toBe('ready');
    expect(progressKey(progress('failed'))).toBe(
      'editor.releases.progress.planFailed',
    );
    expect(progressBadgeKey(progress('rendering', 9, 4))).toBe(
      'editor.releases.progress.badge.rendering',
    );
    expect(inProgress(undefined)).toBe(true);
    expect(inProgress(progress('planning'))).toBe(true);
    expect(inProgress(progress('done', 2, 2))).toBe(false);
    expect(donePercent(progress('rendering', 8, 2))).toBe(25);
    expect(donePercent(progress('planning'))).toBe(0);
    expect(
      sameProgress(progress('rendering', 8, 2), progress('rendering', 8, 2)),
    ).toBe(true);
    expect(
      sameProgress(progress('rendering', 8, 2), progress('rendering', 8, 3)),
    ).toBe(false);
    expect(sameProgress(undefined, null)).toBe(false);
  });

  it('says when a release has too many files to prepare, with the count only when known (#477)', () => {
    expect(progressKind(refused())).toBe('failed');
    expect(progressKey(refused())).toBe('editor.releases.progress.tooMany');
    expect(progressKey(refused(null))).toBe(
      'editor.releases.progress.tooManyLimit',
    );
    expect(progressBadgeKey(refused())).toBe(
      'editor.releases.progress.badge.tooMany',
    );
    expect(progressParams(refused())).toMatchObject({
      wanted: 5952,
      max: 2000,
      total: 0,
    });
    expect(progressParams(refused(null))).toMatchObject({ wanted: 0 });
    expect(archiveBlocked(refused())).toBe(
      'editor.releases.files.archive.tooMany',
    );
    expect(sameProgress(refused(), refused())).toBe(true);
    expect(sameProgress(refused(), refused(5952, 3000))).toBe(false);
    expect(sameProgress(refused(), progress('failed'))).toBe(false);
  });

  it('offers planning again for no files, or a planning that failed after some batches (#477)', () => {
    expect(canPlanAgain(progress('done'))).toBe(true);
    expect(canPlanAgain(progress('failed', 5, 5))).toBe(true);
    expect(progressKey(progress('failed', 5, 5))).toBe(
      'editor.releases.progress.planFailed',
    );
    expect(canPlanAgain(refused())).toBe(true);
    expect(canPlanAgain(progress('failed', 5, 4, 1))).toBe(false);
    expect(canPlanAgain(progress('done', 5, 5))).toBe(false);
    expect(canPlanAgain(progress('planning'))).toBe(false);
    expect(canPlanAgain(undefined)).toBe(false);
  });

  it('polls while a file is queued or rendering', () => {
    expect(anyPending([output('a'), output('b', { state: 'failed' })])).toBe(
      false,
    );
    expect(anyPending([output('a', { state: 'rendering' })])).toBe(true);
  });

  it('groups a page of files by manual, keeping the order', () => {
    const groups = groupOutputs([
      output('a', { manual: 'm1' }),
      output('b', { manual: 'm1', lang: 'de' }),
      output('c', { manual: 'm2' }),
    ]);
    expect(groups.map((g) => [g.manual, g.outputs.map((o) => o.id)])).toEqual([
      ['m1', ['a', 'b']],
      ['m2', ['c']],
    ]);
  });

  it('groups the offline packages, of no manual, on their own (#59)', () => {
    const pkg = (id: string, lang: string) =>
      output(id, {
        kind: 'offline-package',
        manual: null,
        variant: null,
        audience: 'public',
        lang,
      });
    const groups = groupOutputs([
      pkg('p1', 'de'),
      pkg('p2', 'en'),
      output('a', { manual: 'm1' }),
    ]);
    expect(groups.map((g) => [g.manual, g.outputs.map((o) => o.id)])).toEqual([
      [OFFLINE_PACKAGES, ['p1', 'p2']],
      ['m1', ['a']],
    ]);
  });

  it('takes the state a retry answers, else queued, clearing the error', () => {
    const failed = output('a', {
      state: 'failed',
      error: { code: 'render-failed', detail: 'boom' },
    });
    expect(afterRetry(failed, null).attributes).toMatchObject({
      state: 'queued',
      error: null,
    });
    expect(
      afterRetry(failed, { id: 'a', attributes: { state: 'rendering' } })
        .attributes.state,
    ).toBe('rendering');
  });

  it('names products by the product facet, else by ID', () => {
    const c = config();
    expect(productFacetOf(c)?.id).toBe('product');
    expect(productLabel(c, 'north')).toBe('North');
    expect(productLabel(c, 'east')).toBe('east');
    expect(productLabel(null, 'north')).toBe('north');
  });

  it('checks a product version as the API does', () => {
    expect(revisionProblem(' ')).toBe(
      'editor.releases.create.revision.required',
    );
    for (const bad of ['-1', '2..1', '2.', '2.lock', 'a/b', 'x'.repeat(101)])
      expect(revisionProblem(bad)).toBe(
        'editor.releases.create.revision.invalid',
      );
    for (const good of ['2.1', '2026-10', 'v3_rc1'])
      expect(revisionProblem(good)).toBeNull();
  });

  it('checks notes as the API does: length, markers and trailers', () => {
    expect(notesProblem('')).toBeNull();
    expect(notesProblem('Torque values corrected.')).toBeNull();
    expect(notesProblem('x'.repeat(10_001))).toBe(
      'editor.releases.create.notes.tooLong',
    );
    expect(notesProblem('a\n---\nb')).toBe(
      'editor.releases.create.notes.invalid',
    );
    expect(notesProblem('a\n[notes:de]')).toBe(
      'editor.releases.create.notes.invalid',
    );
    expect(notesProblem('Fixed.\n\nSigned-off-by: someone')).toBe(
      'editor.releases.create.notes.trailer',
    );
  });

  it('keeps only the summaries given, trimmed', () => {
    expect(notesByLanguageOf({ en: ' Hi ', de: '  ' })).toEqual({ en: 'Hi' });
  });

  it('needs a reason to withdraw, of at most 2,000 characters', () => {
    expect(reasonProblem('  ')).toBe('editor.releases.withdraw.reasonRequired');
    expect(reasonProblem('x'.repeat(2001))).toBe(
      'editor.releases.withdraw.reasonTooLong',
    );
    expect(reasonProblem('Wrong torque')).toBeNull();
  });

  it('shortens a commit as Git does', () => {
    expect(shortCommit('c0ffee1234')).toBe('c0ffee1');
  });
});

describe('archiveBlocked', () => {
  it('allows the ZIP once any file is ready, and says why not before', () => {
    expect(archiveBlocked(progress('rendering', 3, 1))).toBeNull();
    expect(archiveBlocked(progress('failed', 3, 2, 1))).toBeNull();
    expect(archiveBlocked(undefined)).toBe(
      'editor.releases.files.archive.notReady',
    );
    expect(archiveBlocked(progress('planning'))).toBe(
      'editor.releases.files.archive.notReady',
    );
    expect(archiveBlocked(progress('rendering', 3, 0, 0, 3))).toBe(
      'editor.releases.files.archive.notReady',
    );
    expect(archiveBlocked(progress('failed', 2, 0, 2))).toBe(
      'editor.releases.files.archive.allFailed',
    );
    expect(archiveBlocked(progress('failed'))).toBe(
      'editor.releases.files.archive.planFailed',
    );
    expect(archiveBlocked(progress('done'))).toBe(
      'editor.releases.files.archive.none',
    );
  });

  it('names a file by its manual’s title and variant label, else by their IDs (#691)', () => {
    const op = manual('operating', 'Operating manual');
    const manuals = new Map([[op.id, op]]);
    const title = {
      title: (t: LocalizedText) => textIn(t, 'de', 'en'),
      variant: (_: unknown, fallback: string) => fallback,
      offlinePackage: () => 'Offline package',
      audience: (id: string) => (id === 'public' ? 'Public' : undefined),
    };
    expect(outputNames(manuals, output('o1'), title)).toEqual({
      manual: 'Operating manual',
      variant: 'Large',
    });
    expect(
      outputNames(manuals, output('o2', { variant: 'model=small' }), title),
    ).toEqual({ manual: 'Operating manual', variant: 'model=small' });
    expect(outputNames(new Map(), output('o3'), title)).toEqual({
      manual: 'operating',
      variant: 'model=large',
    });
    // An offline package (#59): by its audience level's label, else its ID.
    const pkg = (audience: string | null) =>
      output('p', {
        kind: 'offline-package',
        manual: null,
        variant: null,
        audience,
      });
    expect(outputNames(manuals, pkg('public'), title)).toEqual({
      manual: 'Offline package',
      variant: 'Public',
    });
    expect(outputNames(manuals, pkg('internal'), title).variant).toBe(
      'internal',
    );
    expect(outputNames(manuals, pkg(null), title).variant).toBe('');
  });
});

describe('notesShown (#794)', () => {
  const notes = { de: 'Drehmomente korrigiert.', fr: 'Couples corrigés.' };

  it('opens on the summary in the interface language when the release has one', () => {
    expect(notesShown(notes, undefined, 'de')).toBe('de');
    expect(notesShown({ 'de-AT': 'Servus.' }, undefined, 'de')).toBe('de-AT');
    expect(notesShown({ DE: 'Hallo.' }, undefined, 'de')).toBe('DE');
  });

  it('opens on the summary without one in the interface language, or an empty one', () => {
    expect(notesShown(notes, undefined, 'en')).toBe(NOTES_SUMMARY);
    expect(notesShown({}, undefined, 'de')).toBe(NOTES_SUMMARY);
    expect(notesShown({ de: '  ' }, undefined, 'de')).toBe(NOTES_SUMMARY);
  });

  it('keeps an explicit choice: the summary, or a language the release has', () => {
    expect(notesShown(notes, NOTES_SUMMARY, 'de')).toBe(NOTES_SUMMARY);
    expect(notesShown(notes, 'fr', 'de')).toBe('fr');
    // A language the release has no summary in: as without a choice.
    expect(notesShown(notes, 'ar', 'de')).toBe('de');
    expect(notesShown(notes, 'ar', 'en')).toBe(NOTES_SUMMARY);
    // Not a key of its own: an object's inherited members name no summary.
    expect(notesShown(notes, 'valueOf', 'en')).toBe(NOTES_SUMMARY);
    expect(notesShown(notes, 'toString', 'de')).toBe('de');
  });
});
