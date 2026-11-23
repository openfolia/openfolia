import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { signal as plainSignal } from '@angular/core';
import { provideZard } from '@openfolia/ui/core';

import { apiErrorInterceptor } from '../api/api-interceptors';
import { setDocBlocksContext } from '../doc-editor/blocks/doc-blocks-context';
import { doc, p, testEditor } from '../doc-editor/testing/test-editor';
import { pickAndInsertTerm } from '../doc-editor/writing/term-insert';
import type { TermChoice } from '../doc-editor/writing/writing-aids';
import { MeService } from '../permissions/me';
import { advance } from '../testing/fake-time';
import {
  TERM_PICKER_PAGE,
  TERM_SEARCH_MS,
  TermPickerDialogComponent,
  type TermPickRequest,
} from './term-picker-dialog.component';

// The term picker (#247): approved terms of the document's language, searched, a page at a time;
// a choice is the term's preferred variant, inserted linked to the term.

const links = { self: '', first: '', last: '', prev: null, next: null };

const term = (id: string, preferred: string, definition?: string) => ({
  type: 'Term',
  id,
  attributes: {
    schemaVersion: 1,
    status: 'approved',
    domain: 'Charging',
    languages: {
      en: {
        preferred,
        allowed: [],
        forbidden: [],
        ...(definition
          ? { definition: [{ type: 'text', text: definition }] }
          : {}),
      },
    },
  },
  meta: {},
});

@Component({
  imports: [TermPickerDialogComponent],
  template: `<of-term-picker-dialog
    [request]="request()"
    (done)="answers.push($event); request.set(null)"
  />`,
})
class Host {
  readonly request = signal<TermPickRequest | null>(null);
  readonly answers: (TermChoice | null)[] = [];
}

async function render() {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(withInterceptors([apiErrorInterceptor])),
      provideHttpClientTesting(),
      provideZard(),
    ],
  });
  TestBed.inject(MeService).set({
    id: 'author',
    kind: 'user',
    name: 'Author',
    role: '',
    permissions: new Set(['content.read', 'content.edit']),
  });
  vi.useFakeTimers();
  const fixture = TestBed.createComponent(Host);
  const http = TestBed.inject(HttpTestingController);
  fixture.componentInstance.request.set({ lang: 'en' });
  await advance();
  await advance();
  const dialog = () => document.querySelector<HTMLElement>('z-dialog-panel')!;
  const rows = () =>
    Array.from(
      document.querySelectorAll<HTMLButtonElement>('button[data-term-row]'),
    );
  return { fixture, http, dialog, rows };
}

describe('TermPickerDialogComponent', () => {
  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
    document.querySelectorAll('z-dialog-panel').forEach((e) => e.remove());
  });

  it('lists approved terms of the language, searches them, and answers with the one chosen', async () => {
    const { fixture, http, dialog, rows } = await render();
    const first = http.expectOne((r) => r.url === '/api/terms');
    expect(first.request.params.get('filter[lang]')).toBe('en');
    expect(first.request.params.get('filter[status]')).toBe('approved');
    expect(first.request.params.get('page[size]')).toBe(
      String(TERM_PICKER_PAGE),
    );
    expect(first.request.params.has('filter[q]')).toBe(false);
    first.flush({
      data: [
        term('battery', 'battery'),
        term('charger', 'charger', '<b>The unit</b> that charges.'),
      ],
      meta: { page: { currentPage: 1, lastPage: 1, perPage: 20, total: 2 } },
      links,
    });
    await advance();
    expect(dialog().textContent).toContain('Insert a term');
    expect(rows().map((r) => r.querySelector('span')?.textContent)).toEqual([
      'battery',
      'charger',
    ]);
    // A definition is text, never markup.
    expect(rows()[1]!.textContent).toContain('<b>The unit</b> that charges.');
    expect(rows()[1]!.querySelector('b')).toBeNull();

    const search =
      dialog().querySelector<HTMLInputElement>('[data-term-search]')!;
    search.value = 'char';
    search.dispatchEvent(new Event('input'));
    await advance(TERM_SEARCH_MS + 10);
    const searched = http.expectOne((r) => r.url === '/api/terms');
    expect(searched.request.params.get('filter[q]')).toBe('char');
    searched.flush({
      data: [term('charger', 'charger')],
      meta: { page: { currentPage: 1, lastPage: 1, perPage: 20, total: 1 } },
      links,
    });
    await advance();
    rows()[0]!.click();
    await advance();
    expect(fixture.componentInstance.answers).toEqual([
      { termId: 'charger', text: 'charger' },
    ]);
  });

  it('answers null when cancelled', async () => {
    const { fixture, http, dialog } = await render();
    http
      .expectOne((r) => r.url === '/api/terms')
      .flush({
        data: [],
        meta: { page: { currentPage: 1, lastPage: 1, perPage: 20, total: 0 } },
        links,
      });
    await advance();
    expect(dialog().textContent).toContain('No terms found');
    Array.from(dialog().querySelectorAll('button'))
      .find((b) => b.textContent?.trim() === 'Cancel')!
      .click();
    await advance();
    expect(fixture.componentInstance.answers).toEqual([null]);
  });
});

describe('inserting a picked term', () => {
  it('puts the preferred variant in at the selection, linked, in one undo step', async () => {
    const editor = testEditor(doc(p('Use the device.', 'a')));
    const pick = vi.fn(async () => ({ termId: 'charger', text: 'charger' }));
    setDocBlocksContext(editor, {
      settings: plainSignal({ pickTerm: pick }),
      editable: plainSignal(true),
    });
    // "device" selected.
    editor.commands.setTextSelection({ from: 9, to: 15 });
    expect(await pickAndInsertTerm(editor)).toBe(true);
    expect(editor.state.doc.textContent).toBe('Use the charger.');
    const marked: string[] = [];
    editor.state.doc.descendants((node) => {
      if (node.isText && node.marks.some((m) => m.type.name === 'term'))
        marked.push(node.text ?? '');
    });
    expect(marked).toEqual(['charger']);
    editor.commands.undo();
    expect(editor.state.doc.textContent).toBe('Use the device.');
  });

  it('inserts nothing when the picker is cancelled or missing', async () => {
    const editor = testEditor(doc(p('Use the device.', 'a')));
    setDocBlocksContext(editor, {
      settings: plainSignal({ pickTerm: async () => null }),
      editable: plainSignal(true),
    });
    expect(await pickAndInsertTerm(editor)).toBe(false);
    setDocBlocksContext(editor, {
      settings: plainSignal({}),
      editable: plainSignal(true),
    });
    expect(await pickAndInsertTerm(editor)).toBe(false);
    expect(editor.state.doc.textContent).toBe('Use the device.');
  });
});
