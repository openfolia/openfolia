import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { provideZard } from '@openfolia/ui/core';

import { ImageSources } from '../images/image-sources';
import { ModuleDiffBodyComponent } from './module-diff-body.component';
import { ModuleDiffComponent } from './module-diff.component';
import { ReviewComments } from './review-comments';
import { ReviewContext } from './review-context';
import { advance } from '../testing/fake-time';

const BASE = 'b'.repeat(40);
const HEAD = 'c'.repeat(40);
const OLD_PHOTO = `sha256:${'1'.repeat(64)}`;
const NEW_PHOTO = `sha256:${'2'.repeat(64)}`;

const change = (moduleId: string) => ({
  type: 'ChangeSetChange',
  id: `module/en/${moduleId}`,
  attributes: { subject: { type: 'module', lang: 'en', moduleId } },
  relationships: { changeSet: { data: { type: 'ChangeSet', id: 'x' } } },
  meta: { change: 'changed', fields: [], blocks: [], unreadable: false },
});

const text = (t: string) => [{ type: 'text', text: t }];
const p = (id: string, t: string) => ({
  type: 'paragraph',
  id,
  content: text(t),
});

const moduleDoc = (
  moduleId: string,
  blocks: unknown[],
  attributes: Record<string, unknown> = {},
) => ({
  data: {
    type: 'Module',
    id: `en/${moduleId}`,
    attributes: {
      moduleId,
      lang: 'en',
      schemaVersion: 1,
      title: 'Charging',
      moduleType: 'procedure',
      facets: {},
      keywords: ['battery'],
      blocks,
      ...attributes,
    },
    meta: { issues: [], status: { release: null, main: null } },
  },
});

/** The person's example, as on the base commit. */
const BEFORE = [
  p('intro', 'The vehicle charges automatically.'),
  { type: 'moduleRef', id: 'note', module: 'safety-note' },
  { type: 'image', id: 'photo', asset: OLD_PHOTO, alt: 'The charger' },
  {
    type: 'section',
    id: 'start',
    title: text('Before you start'),
    blocks: [
      p('level', 'Park on level ground near the station.'),
      p('clean', 'Keep the contacts clean.'),
      p('path', 'Keep the path free.'),
      p('dry', 'Keep it dry.'),
    ],
  },
];

/** …and on the head: a variant wrapper, a paragraph, a new photo, a safety notice. */
const AFTER = [
  {
    type: 'variant',
    id: 'small-only',
    when: { op: 'in', attr: 'model', values: ['small'] },
    blocks: [p('intro', 'The vehicle charges automatically.')],
  },
  p('fast', 'The large model also fast-charges.'),
  { type: 'moduleRef', id: 'note', module: 'safety-note' },
  {
    type: 'image',
    id: 'photo',
    asset: NEW_PHOTO,
    alt: 'The charger with its status ring',
  },
  {
    type: 'safety',
    id: 'hot',
    severity: 'warning',
    hazard: text('Hot charging contacts'),
    symbols: [],
    blocks: [p('burns', 'They can cause burns.')],
  },
  {
    type: 'section',
    id: 'start',
    title: text('Before you start'),
    blocks: [
      p('level', 'Park on firm, level ground close to the station.'),
      p('clean', 'Keep the contacts clean.'),
      p('path', 'Keep the path free.'),
      p('dry', 'Keep it dry.'),
    ],
  },
];

async function render(
  before: object,
  after: object,
  inputs: Record<string, unknown> = {},
  prepare: (comments: ReviewComments) => void = () => undefined,
) {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideZard(),
      ReviewContext,
      ReviewComments,
      ImageSources,
    ],
  });
  const comments = TestBed.inject(ReviewComments);
  prepare(comments);
  const http = TestBed.inject(HttpTestingController);
  const review = TestBed.inject(ReviewContext);
  review.storedConfig.set({
    moduleTypes: [
      {
        id: 'procedure',
        label: 'Procedure',
        restricted: false,
        snippet: false,
      },
    ],
    audiences: [],
    facets: [],
    variantAttributes: [
      {
        id: 'model',
        label: 'Model',
        kind: 'enum',
        values: [{ id: 'small', label: 'Small' }],
      },
    ],
    textAttributes: [],
    safetySymbols: [],
    outputLabels: {},
    languages: { source: 'en', targets: [] },
  } as never);
  // Fake time: the diff's timers are waited out on the fake clock. The fake clock runs every timer
  // due in the step, in order, however slow the machine is (#562).
  vi.useFakeTimers();
  const fixture = TestBed.createComponent(ModuleDiffComponent);
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(0);
      // Pictures and referenced titles: answered at once, so nothing stays pending.
      http
        .match((r) => r.url.startsWith('/api/assets/'))
        .forEach((r) => r.flush(new Blob(['x'], { type: 'image/png' })));
      http
        .match((r) => r.url === '/api/modules/en/safety-note')
        .forEach((r) =>
          r.flush(moduleDoc('safety-note', [], { title: 'Safety note' })),
        );
      // A read asked while the clock runs is answered only by the next turn of this loop.
      await advance();
    }
  };
  fixture.componentRef.setInput('change', change('charging'));
  fixture.componentRef.setInput('base', BASE);
  fixture.componentRef.setInput('head', HEAD);
  for (const [k, v] of Object.entries(inputs))
    fixture.componentRef.setInput(k, v);
  await settle();
  http
    .match((r) => r.url === '/api/modules/en/charging')
    .forEach((r) =>
      r.flush(r.request.params.get('ref') === BASE ? before : after),
    );
  await settle();
  const el = fixture.nativeElement as HTMLElement;
  const marks = () =>
    [...el.querySelectorAll('[data-change] > p:first-child')].map((m) =>
      [...m.children]
        .map((c) => c.textContent)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    );
  return { fixture, el, http, review, comments, settle, marks };
}

describe('ModuleDiffComponent', () => {
  it('draws its diff with the component the history compares versions with', async () => {
    const t = await render(
      moduleDoc('charging', [p('p1', 'Plug in.')]),
      moduleDoc('charging', [p('p1', 'Plug it in.')]),
      { view: 'side' },
    );
    const body = t.fixture.debugElement.query(
      (d) => d.componentInstance instanceof ModuleDiffBodyComponent,
    );
    expect(body).not.toBeNull();
    const shared = body.componentInstance as ModuleDiffBodyComponent;
    expect(shared.view()).toBe('side');
    expect(shared.commentModule()).toBe('en/charging');
    expect(shared.base()).toBe(BASE);
    expect(shared.head()).toBe(HEAD);
  });

  it('never shows one module’s blocks while the next one it is reused for is read', async () => {
    const t = await render(
      moduleDoc('charging', [p('p1', 'Plug in.')]),
      moduleDoc('charging', [p('p1', 'Plug it in.')]),
    );
    expect(t.el.textContent).toContain('Plug');
    t.fixture.componentRef.setInput('change', change('storage'));
    await t.settle();
    expect(t.el.textContent).not.toContain('Plug');
    t.http
      .match((r) => r.url === '/api/modules/en/storage')
      .forEach((r) =>
        r.flush(
          moduleDoc('storage', [p('p1', 'Keep it dry.')], { title: 'Storage' }),
        ),
      );
    await t.settle();
    expect(t.el.textContent).toContain('Storage');
  });

  it('shows the person’s example with real blocks, each change named', async () => {
    const t = await render(
      moduleDoc('charging', BEFORE),
      moduleDoc('charging', AFTER),
    );
    // The variant wrapper is one change, with its condition by its labels.
    expect(t.marks()).toContain(
      '+ Variant block added around existing content (Model: Small)',
    );
    const variant = t.el.querySelector('of-variant-block')!;
    expect(variant.textContent).toContain('Small');
    expect(variant.textContent).toContain('The vehicle charges automatically.');
    expect(t.marks()).toContain('+ Paragraph added');
    // The safety notice in its level's frame, with the signal word; what it holds is part of it.
    const notice = t.el.querySelector('of-safety-notice')!;
    expect(notice.getAttribute('data-level')).toBe('warning');
    expect(notice.textContent).toContain('Hot charging contacts');
    expect(t.marks()).toContain('+ Safety notice added');
    expect(
      t.marks().filter((m) => m?.includes('Paragraph added')),
    ).toHaveLength(1);
    // The image: both pictures, named, and its alt text compared word by word.
    expect(t.marks()).toContain('~ Image replaced');
    const figures = [...t.el.querySelectorAll('of-diff-image figure')];
    expect(
      figures.map((f) => f.querySelector('figcaption')?.textContent?.trim()),
    ).toEqual(['− Before', '+ After']);
    expect(t.el.querySelector('of-diff-image ins')?.textContent).toContain(
      'with its status ring',
    );
    // The reference as its card, with the module's title.
    expect(
      t.el.querySelector('of-module-reference-card')?.textContent,
    ).toContain('Safety note');
    // A changed paragraph: word by word, never colour alone.
    const changed = [...t.el.querySelectorAll('[data-change="changed"]')].find(
      (r) => r.textContent?.includes('Park'),
    )!;
    expect(changed.querySelector('del')?.textContent).toContain('near');
    expect(changed.querySelector('ins')?.textContent).toContain('Inserted');
    // The overview hears what it found.
    expect(t.review.summaryOf('module/en/charging')?.counts).toEqual({
      added: 3,
      removed: 0,
      changed: 2,
      moved: 0,
    });
  });

  it('names what changed beside the words: a mark, a link’s address, a cross-reference’s target', async () => {
    const t = await render(
      moduleDoc('charging', [
        {
          type: 'paragraph',
          id: 'p1',
          content: [
            { type: 'text', text: 'See ' },
            {
              type: 'text',
              text: 'docs',
              marks: [{ type: 'link', href: 'https://old.example' }],
            },
            { type: 'xref', module: 'charging', block: 'p2' },
          ],
        },
        p('p2', 'Plug in.'),
      ]),
      moduleDoc('charging', [
        {
          type: 'paragraph',
          id: 'p1',
          content: [
            { type: 'text', text: 'See ' },
            {
              type: 'text',
              text: 'docs',
              marks: [
                { type: 'strong' },
                { type: 'link', href: 'https://new.example' },
              ],
            },
            { type: 'xref', module: 'charging', block: 'p1' },
          ],
        },
        p('p2', 'Plug in.'),
      ]),
    );
    const mark = t.marks().find((m) => m.includes('Paragraph:'));
    expect(mark).toContain('Link removed from “docs” → https://old.example');
    expect(mark).toContain('Link added to “docs” → https://new.example');
    expect(mark).toContain('Bold added to “docs”');
    expect(mark).toContain('Cross-reference added to “charging#p1”');
  });

  const withBreak = [
    p('a', 'One.'),
    { type: 'pageBreak', id: 'break' },
    p('b', 'Two.'),
  ];
  const withoutBreak = [p('a', 'One.'), p('b', 'Two.')];

  it('shows an added page break as its labelled rule', async () => {
    const t = await render(
      moduleDoc('charging', withoutBreak),
      moduleDoc('charging', withBreak),
    );
    expect(t.marks()).toContain('+ Page break added');
    expect(
      t.el.querySelector('of-page-break-block')?.getAttribute('aria-label'),
    ).toBe('Page break (PDF)');
  });

  it('shows a removed page break', async () => {
    const t = await render(
      moduleDoc('charging', withBreak),
      moduleDoc('charging', withoutBreak),
    );
    expect(t.marks()).toContain('− Page break removed');
  });

  it('folds unchanged blocks, keeping one beside each change, and opens a run on request', async () => {
    const t = await render(
      moduleDoc('charging', BEFORE),
      moduleDoc('charging', AFTER),
    );
    const run = t.el.querySelector<HTMLButtonElement>(
      '[data-slot=unchanged-run] button',
    )!;
    expect(run.textContent).toContain('2 unchanged blocks');
    expect(run.getAttribute('aria-expanded')).toBe('false');
    let toggled = '';
    t.fixture.componentInstance.toggled.subscribe((key) => (toggled = key));
    run.click();
    expect(toggled).toBe('path');
    t.fixture.componentRef.setInput('open', new Set(['path']));
    await t.settle();
    expect(run.getAttribute('aria-expanded')).toBe('true');
  });

  it('names a move with where it came from, and links both places', async () => {
    const t = await render(
      moduleDoc('charging', [
        {
          type: 'section',
          id: 'a',
          title: text('Alpha'),
          blocks: [
            { type: 'section', id: 'b', title: text('Beta'), blocks: [] },
          ],
        },
      ]),
      moduleDoc('charging', [
        { type: 'section', id: 'a', title: text('Alpha'), blocks: [] },
        { type: 'section', id: 'b', title: text('Beta'), blocks: [] },
      ]),
    );
    expect(t.marks()).toContain(
      '↕ Heading moved from “Alpha” Show where it was',
    );
    expect(t.marks()).toContain(
      '↳ Heading moved to the top of the module Show where it is now',
    );
    const ghost = t.el.querySelector('[data-change="ghost"]')!;
    const moved = t.el.querySelector('[data-hunk="moved"]')!;
    expect(ghost.id).toBe('diff-module-en-charging-was-b');
    expect(moved.id).toBe('diff-module-en-charging-b');
  });

  it('draws a block moved to an earlier cell in its cell, once', async () => {
    const grid = (ids: string[]) => ({
      type: 'table',
      id: 't',
      header: false,
      columns: ids.map(() => ({ width: 1 })),
      rows: [{ cells: ids.map((id) => ({ blocks: [p(id, `Cell ${id}`)] })) }],
    });
    const t = await render(
      moduleDoc('charging', [grid(['a', 'b', 'c'])]),
      moduleDoc('charging', [grid(['c', 'a', 'b'])]),
    );
    const moved = t.el.querySelectorAll('[data-hunk="moved"]');
    expect(moved).toHaveLength(1);
    expect(moved[0]?.closest('td')?.textContent).toContain('Cell c');
    expect(
      t.el.querySelectorAll('#diff-module-en-charging-was-c'),
    ).toHaveLength(1);
  });

  it('shows its details as a table of before and after', async () => {
    const t = await render(
      moduleDoc('charging', [p('p1', 'Plug in.')]),
      moduleDoc('charging', [p('p1', 'Plug in.')], {
        title: 'Charging the vehicle',
        keywords: ['battery', 'charging station'],
      }),
    );
    const rows = [
      ...t.el.querySelectorAll('of-diff-fields [role=row][data-hunk]'),
    ];
    expect(
      rows.map((r) => r.querySelector('[role=rowheader]')?.textContent?.trim()),
    ).toEqual(['Title', 'Keywords']);
    expect(rows[1]?.querySelector('ins')?.textContent).toContain(
      'charging station',
    );
    expect(t.el.textContent).toContain('Renamed');
    expect(t.el.textContent).toContain('Only its details changed');
  });

  it('puts both sides in aligned rows side by side, a gap facing what one side lacks', async () => {
    const t = await render(
      moduleDoc('charging', BEFORE),
      moduleDoc('charging', AFTER),
      {
        view: 'side',
      },
    );
    const rows = [...t.el.querySelectorAll('[data-slot=side-row]')];
    const added = rows.find((r) => r.textContent?.includes('fast-charges'))!;
    expect(added.children[0]?.getAttribute('aria-hidden')).toBe('true');
    expect(added.children[0]?.textContent?.trim()).toBe('');
    // The removal and insertion each on their own side.
    const level = rows.find((r) =>
      r.textContent?.includes('Before you start'),
    )!;
    expect(level.children[0]?.querySelector('ins')).toBeNull();
    expect(level.children[1]?.querySelector('del')).toBeNull();
  });

  it('keeps a moved block’s old place in its cell in the before column', async () => {
    const grid = (ids: string[]) => ({
      type: 'table',
      id: 't',
      header: false,
      columns: ids.map(() => ({ width: 1 })),
      rows: [{ cells: ids.map((id) => ({ blocks: [p(id, `Cell ${id}`)] })) }],
    });
    const t = await render(
      moduleDoc('charging', [grid(['a', 'b', 'c'])]),
      moduleDoc('charging', [grid(['c', 'a', 'b'])]),
      { view: 'side' },
    );
    const before = [...t.el.querySelectorAll('[data-slot=side-row]')].map(
      (r) => r.children[0] as HTMLElement,
    );
    const ghost = before
      .map((c) => c.querySelector('[data-change="ghost"]'))
      .find((g) => g);
    // In the table, in its old cell; not below it.
    expect(ghost?.closest('td')?.textContent).toContain('Cell c');
    expect(before.flatMap((c) => [...c.querySelectorAll('td')])).toHaveLength(
      3,
    );
  });

  it('shows a block’s threads next to it and starts one from its gutter', async () => {
    const t = await render(
      moduleDoc('charging', [p('p1', 'Plug in.'), p('p2', 'Wait.')]),
      moduleDoc('charging', [p('p1', 'Plug it in.'), p('p2', 'Wait.')]),
      {},
      (c) => {
        c.reset('cs1');
        c.canWrite.set(true);
        c.me.set({ kind: 'user', id: 'sample-reviewer' });
      },
    );
    const list = () =>
      t.http.match((r) => r.url === '/api/change-sets/cs1/comments');
    const reads = list();
    expect(reads.length).toBe(1);
    expect(reads[0]?.request.params.get('filter[module]')).toBe('en/charging');
    reads[0]?.flush({
      data: [comment('t1', 'p2', 'Is this still right?')],
      meta: { page: { number: 1, size: 200, total: 1, lastPage: 1 } },
      links: {},
    });
    await t.settle();
    // An unchanged block with a thread is kept unfolded, its thread beside it.
    const thread = t.el.querySelector('[data-slot=thread]');
    expect(thread?.textContent).toContain('Is this still right?');
    expect(thread?.closest('[data-change]')?.textContent).toContain('Wait.');

    const button = [...t.el.querySelectorAll('button')].find((b) =>
      b.getAttribute('aria-label')?.startsWith('Comment on'),
    );
    button?.click();
    await t.settle();
    const box = t.el.querySelector<HTMLTextAreaElement>(
      '[data-slot=composer] textarea',
    );
    expect(box).not.toBeNull();
    box!.value = 'Name the plug.';
    box!.dispatchEvent(new Event('input'));
    await t.settle();
    [...t.el.querySelectorAll<HTMLButtonElement>('[data-slot=composer] button')]
      .find((b) => b.textContent?.trim() === 'Comment')
      ?.click();
    const posts = t.http.match(
      (r) => r.url === '/api/change-sets/cs1/comments' && r.method === 'POST',
    );
    expect(posts.length).toBe(1);
    expect(posts[0]?.request.body).toEqual({
      data: {
        type: 'Comment',
        attributes: {
          body: 'Name the plug.',
          blockId: 'p1',
          subject: { type: 'module', lang: 'en', moduleId: 'charging' },
        },
      },
    });
  });

  it('shows a deleted module inline in rendered mode, its threads with it', async () => {
    const t = await render(
      moduleDoc('charging', [p('p1', 'Plug in.')]),
      moduleDoc('charging', [p('p1', 'Plug in.')]),
      {
        view: 'rendered',
        change: {
          ...change('charging'),
          meta: { ...change('charging').meta, change: 'removed' },
        },
      },
      (c) => c.reset('cs1'),
    );
    t.http
      .match((r) => r.url === '/api/change-sets/cs1/comments')
      .forEach((r) =>
        r.flush({
          data: [comment('t1', 'p1', 'Why is this going?')],
          meta: { page: { number: 1, size: 200, total: 1, lastPage: 1 } },
          links: {},
        }),
      );
    await t.settle();
    expect(t.el.querySelector('of-diff-rendered')).toBeNull();
    expect(t.el.textContent).toContain('Plug in.');
    expect(t.el.querySelector('[data-slot=thread]')?.textContent).toContain(
      'Why is this going?',
    );
  });

  it.each(['inline', 'side', 'rendered'] as const)(
    'shows Comment on a changed block without a hover, in the %s view (#452)',
    async (view) => {
      const t = await render(
        moduleDoc('charging', [p('p1', 'Plug in.'), p('p2', 'Wait.')]),
        moduleDoc('charging', [p('p1', 'Plug it in.'), p('p2', 'Wait.')]),
        { view },
        (c) => {
          c.reset('cs1');
          c.canWrite.set(true);
          c.me.set({ kind: 'user', id: 'sample-admin' });
        },
      );
      t.http
        .match((r) => r.url === '/api/change-sets/cs1/comments')
        .forEach((r) =>
          r.flush({
            data: [],
            meta: { page: { number: 1, size: 200, total: 0, lastPage: 1 } },
            links: {},
          }),
        );
      await t.settle();
      // One for the changed paragraph (on the new side in side by side), none for the same one.
      const buttons = [
        ...t.el.querySelectorAll<HTMLElement>('[data-slot=comment-button]'),
      ];
      expect(buttons.length).toBe(1);
      // In sight at rest: a reviewer who never hovers the block still finds it.
      expect(buttons[0]!.classList).not.toContain('opacity-0');
      if (view === 'side') {
        const row = buttons[0]!.closest('[data-slot=side-row]')!;
        expect(row.children[1]?.contains(buttons[0]!)).toBe(true);
      }
    },
  );

  it('offers no comment to who may not write', async () => {
    const t = await render(
      moduleDoc('charging', [p('p1', 'Plug in.')]),
      moduleDoc('charging', [p('p1', 'Plug it in.')]),
      {},
      (c) => c.reset('cs1'),
    );
    t.http
      .match((r) => r.url === '/api/change-sets/cs1/comments')
      .forEach((r) =>
        r.flush({
          data: [],
          meta: { page: { number: 1, size: 200, total: 0, lastPage: 1 } },
          links: {},
        }),
      );
    await t.settle();
    expect(
      [...t.el.querySelectorAll('button')].some((b) =>
        b.getAttribute('aria-label')?.startsWith('Comment on'),
      ),
    ).toBe(false);
  });

  it('keys the rows of both sides alike, inside containers too', async () => {
    const t = await render(
      moduleDoc('charging', BEFORE),
      moduleDoc('charging', AFTER),
      { view: 'side' },
    );
    const keys = (i: number) =>
      [...t.el.querySelectorAll('[data-slot=side-row]')].flatMap((row) =>
        [...(row.children[i]?.querySelectorAll('[data-align]') ?? [])].map(
          (e) => e.getAttribute('data-align'),
        ),
      );
    const left = keys(0);
    const right = keys(1);
    // The section's paragraphs are rows of their own, matched on both sides.
    expect(left).toContain('clean');
    expect(right).toContain('clean');
  });
});

function comment(id: string, blockId: string, body: string) {
  return {
    type: 'Comment',
    id,
    attributes: {
      subject: { type: 'module', lang: 'en', moduleId: 'charging' },
      blockId,
      body,
      author: { kind: 'user', id: 'sample-reviewer' },
      commit: HEAD,
      createdAt: '2026-11-18T10:00:00.000Z',
      resolvedAt: null,
      resolvedBy: null,
    },
    relationships: {
      changeSet: { data: { type: 'ChangeSet', id: 'cs1' } },
      thread: { data: { type: 'Comment', id } },
    },
    meta: { orphaned: false, deleted: false, editedAt: null },
  };
}

const attachment = (asset: string, name: string, size: number) => ({
  type: 'attachment',
  id: 'f1',
  asset,
  name,
  fileName: 'settings.zip',
  mediaType: 'application/zip',
  size,
});

describe('ModuleDiffComponent: attachments', () => {
  it('names another file under the same facts, never showing it', async () => {
    const t = await render(
      moduleDoc('charging', [attachment(OLD_PHOTO, 'Sample settings', 2048)]),
      moduleDoc('charging', [attachment(NEW_PHOTO, 'Sample settings', 2048)]),
    );
    expect(t.marks()).toContain('~ File replaced');
    const card = t.el.querySelector('[data-slot="diff-attachment"]')!;
    expect(card.textContent).toContain('Sample settings');
    expect(card.textContent).toContain('settings.zip');
    expect(t.el.querySelector('img, iframe, object, embed')).toBeNull();
  });

  it('marks a new name or size word by word', async () => {
    const t = await render(
      moduleDoc('charging', [attachment(OLD_PHOTO, 'Sample settings', 2048)]),
      moduleDoc('charging', [attachment(OLD_PHOTO, 'Example settings', 4096)]),
    );
    expect(t.marks()).toContain('~ Attachment text changed');
    const card = t.el.querySelector('[data-slot="diff-attachment"]')!;
    expect(card.querySelector('ins')?.textContent).toContain('Example');
    expect(card.querySelector('del')?.textContent).toContain('Sample');
  });

  it('lines up attachments and page breaks side by side, by their IDs', async () => {
    const pageBreak = { type: 'pageBreak', id: 'pb' };
    const t = await render(
      moduleDoc('charging', [
        {
          type: 'section',
          id: 's',
          title: text('Files'),
          blocks: [attachment(OLD_PHOTO, 'Sample settings', 2048), pageBreak],
        },
      ]),
      moduleDoc('charging', [
        {
          type: 'section',
          id: 's',
          title: text('Files'),
          blocks: [
            p('new', 'Download the settings first.'),
            attachment(NEW_PHOTO, 'Sample settings', 2048),
            pageBreak,
          ],
        },
      ]),
      { view: 'side' },
    );
    const keys = (i: number) =>
      [...t.el.querySelectorAll('[data-slot=side-row]')].flatMap((row) =>
        [...(row.children[i]?.querySelectorAll('[data-align]') ?? [])].map(
          (e) => e.getAttribute('data-align'),
        ),
      );
    for (const side of [0, 1]) {
      expect(keys(side)).toContain('f1');
      expect(keys(side)).toContain('pb');
    }
    expect(t.marks()).toContain('~ File replaced');
  });
});
