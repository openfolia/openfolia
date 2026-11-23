import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import {
  ListFrameComponent,
  ListRowDirective,
  ListTableDirective,
  type ListFramePage,
} from './list-frame.component';
import { ListItemDirective } from './list-item.directive';

interface Row {
  id: string;
}

@Component({
  imports: [ListFrameComponent, ListRowDirective],
  template: `
    <of-list-frame label="People" [items]="items()" [page]="page()">
      <ng-template ofListRow let-row
        ><span class="cell">{{ row.id }}</span></ng-template
      >
    </of-list-frame>
  `,
})
class RowsHost {
  readonly items = signal<Row[]>([]);
  readonly page = signal<ListFramePage | null>(null);
}

@Component({
  imports: [ListFrameComponent, ListTableDirective, ListItemDirective],
  template: `
    <of-list-frame label="People" [items]="items()" [page]="page()">
      <ng-template ofListTable let-rows>
        <table>
          <tbody>
            @for (row of asRows(rows); track row.id) {
              <tr [ofListItem]="row">
                <td>{{ row.id }}</td>
              </tr>
            }
          </tbody>
        </table>
      </ng-template>
    </of-list-frame>
  `,
})
class TableHost {
  readonly items = signal<Row[]>([]);
  readonly page = signal<ListFramePage | null>(null);
  asRows(rows: readonly unknown[]): Row[] {
    return rows as Row[];
  }
}

/** Items without an `id`, made anew on every answer: the frame's `trackBy` names their key. */
@Component({
  imports: [ListFrameComponent, ListTableDirective, ListItemDirective],
  template: `
    <of-list-frame
      label="People"
      [items]="items()"
      [page]="page()"
      [trackBy]="byName"
    >
      <ng-template ofListTable let-rows>
        <table>
          <tbody>
            @for (row of asRows(rows); track byName(row)) {
              <tr [ofListItem]="row">
                <td>{{ row.name }}</td>
              </tr>
            }
          </tbody>
        </table>
      </ng-template>
    </of-list-frame>
  `,
})
class KeyedHost {
  readonly items = signal<{ name: string }[]>([]);
  readonly page = signal<ListFramePage | null>(null);
  readonly byName = (row: { name: string }) => `name:${row.name}`;
  asRows(rows: readonly unknown[]): { name: string }[] {
    return rows as { name: string }[];
  }
}

const ROW_HEIGHT = 40;
const ids = (...names: string[]) => names.map((id) => ({ id }));
const page = (currentPage: number): ListFramePage => ({
  currentPage,
  lastPage: 3,
  perPage: 50,
  total: 120,
});

interface Played {
  element: Element;
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
  cancelled: boolean;
}

/** Element.animate (missing in jsdom), recorded; and each row placed by its index. */
function stubMotion(reduce = false): Played[] {
  const played: Played[] = [];
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: reduce && query.includes('reduce'),
        media: query,
      }) as MediaQueryList,
  );
  Object.defineProperty(HTMLElement.prototype, 'animate', {
    configurable: true,
    value(
      this: Element,
      keyframes: Keyframe[],
      options: KeyframeAnimationOptions,
    ) {
      const entry: Played = {
        element: this,
        keyframes,
        options,
        cancelled: false,
      };
      played.push(entry);
      return {
        cancel: () => {
          entry.cancelled = true;
        },
      } as Animation;
    },
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      const row = this.matches('li, tr') ? this : null;
      const index = row?.parentElement
        ? [...row.parentElement.children].indexOf(row)
        : 0;
      return { top: index * ROW_HEIGHT, left: 0 } as DOMRect;
    },
  );
  return played;
}

function setup<H extends RowsHost | TableHost>(type: new () => H, rows: Row[]) {
  const fixture = TestBed.createComponent(type);
  fixture.componentInstance.items.set(rows);
  fixture.componentInstance.page.set(page(1));
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const row = (id: string) =>
    [...el.querySelectorAll<HTMLElement>('li, tbody tr')].find((r) =>
      r.textContent?.includes(id),
    ) ?? null;
  const shownIds = () =>
    [...el.querySelectorAll('li, tbody tr')].map((r) => r.textContent?.trim());
  return { fixture, host: fixture.componentInstance, row, shownIds };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fadesOut = (p: Played) =>
  p.keyframes[0]?.['opacity'] === 1 && p.keyframes[1]?.['opacity'] === 0;
const fadesIn = (p: Played) =>
  p.keyframes[0]?.['opacity'] === 0 && p.keyframes[1]?.['opacity'] === 1;

describe('ListFrameComponent, moving items (#385)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (HTMLElement.prototype as { animate?: unknown }).animate;
  });

  it('tracks rows by key: a row that stays is the same element, never drawn again', () => {
    const { fixture, host, row } = setup(RowsHost, ids('a', 'b', 'c'));
    const a = row('a');
    const c = row('c');
    host.items.set(ids('a', 'c', 'd'));
    fixture.detectChanges();
    expect(row('a')).toBe(a);
    expect(row('c')).toBe(c);
    expect(row('b')).toBeNull();
  });

  it('fades a removed row out in place, then the rows after it slide up', async () => {
    const played = stubMotion();
    const { fixture, host, row, shownIds } = setup(
      RowsHost,
      ids('a', 'b', 'c'),
    );
    const b = row('b')!;
    host.items.set(ids('a', 'c'));
    fixture.detectChanges();

    // First the removed row fades out, still in its place.
    expect(shownIds()).toEqual(['a', 'b', 'c']);
    expect(played.filter(fadesOut).map((p) => p.element)).toEqual([b]);

    await wait(200);
    fixture.detectChanges();
    expect(shownIds()).toEqual(['a', 'c']);
    // c was third (80 px), now second (40 px): it starts 40 px lower and slides up.
    const slide = played.find((p) => p.element === row('c'));
    expect(slide?.keyframes[0]?.['transform']).toBe('translate(0px, 40px)');
    expect(played.some((p) => p.element === row('a'))).toBe(false);
  });

  it('makes room for an added row, which then fades in', () => {
    const played = stubMotion();
    const { fixture, host, row, shownIds } = setup(TableHost, ids('a', 'c'));
    host.items.set(ids('a', 'b', 'c'));
    fixture.detectChanges();

    expect(shownIds()).toEqual(['a', 'b', 'c']);
    const slide = played.find((p) => p.element === row('c'));
    expect(slide?.keyframes[0]?.['transform']).toBe('translate(0px, -40px)');
    const enter = played.find((p) => p.element === row('b'));
    expect(enter && fadesIn(enter)).toBe(true);
    // Shown once the rows after it have mostly made room.
    expect(enter?.options.delay).toBeGreaterThan(0);
    expect(enter?.options.fill).toBe('backwards');
  });

  it('tells items apart by the trackBy key when they have no id', () => {
    const played = stubMotion();
    const fixture = TestBed.createComponent(KeyedHost);
    const named = (...names: string[]) => names.map((name) => ({ name }));
    fixture.componentInstance.items.set(named('a', 'b', 'c'));
    fixture.componentInstance.page.set(page(1));
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const rowsNow = () => [...el.querySelectorAll('tbody tr')];
    const [a, b, c] = rowsNow();
    // New objects, the same names: only b leaves.
    fixture.componentInstance.items.set(named('a', 'c'));
    fixture.detectChanges();
    expect(played.filter(fadesOut).map((p) => p.element)).toEqual([b]);
    expect(rowsNow()).toEqual([a, b, c]);
  });

  it('switches another page at once: no fade, no slide', () => {
    const played = stubMotion();
    const { fixture, host, shownIds } = setup(TableHost, ids('a', 'b', 'c'));
    host.items.set(ids('a', 'd', 'e'));
    host.page.set(page(2));
    fixture.detectChanges();
    expect(shownIds()).toEqual(['a', 'd', 'e']);
    expect(played).toEqual([]);
  });

  it('switches at once when no item stays', () => {
    const played = stubMotion();
    const { fixture, host, shownIds } = setup(RowsHost, ids('a', 'b'));
    host.items.set(ids('c', 'd'));
    fixture.detectChanges();
    expect(shownIds()).toEqual(['c', 'd']);
    expect(played).toEqual([]);
  });

  it('does not move under reduced motion', () => {
    const played = stubMotion(true);
    const { fixture, host, shownIds } = setup(RowsHost, ids('a', 'b', 'c'));
    host.items.set(ids('a', 'c'));
    fixture.detectChanges();
    expect(shownIds()).toEqual(['a', 'c']);
    host.items.set(ids('a', 'b', 'c'));
    fixture.detectChanges();
    expect(shownIds()).toEqual(['a', 'b', 'c']);
    expect(played).toEqual([]);
  });

  it('a change while rows fade out starts over from what is on screen', async () => {
    const played = stubMotion();
    const { fixture, host, row, shownIds } = setup(
      RowsHost,
      ids('a', 'b', 'c'),
    );
    host.items.set(ids('a', 'c'));
    fixture.detectChanges();
    const fade = played.find(fadesOut)!;
    // b comes back before it has gone: its fade is undone, nothing is left faded.
    host.items.set(ids('a', 'b', 'c'));
    fixture.detectChanges();
    expect(fade.cancelled).toBe(true);
    await wait(200);
    fixture.detectChanges();
    expect(shownIds()).toEqual(['a', 'b', 'c']);
    expect(row('b')).toBe(fade.element);
  });
});
