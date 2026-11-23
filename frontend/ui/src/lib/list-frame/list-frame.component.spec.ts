import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import {
  ListFrameComponent,
  ListGridDirective,
  ListRowDirective,
  ListTableDirective,
  type ListFrameError,
  type ListFramePage,
} from './list-frame.component';

@Component({
  imports: [ListFrameComponent, ListRowDirective],
  template: `
    <of-list-frame
      label="People"
      [items]="items"
      [page]="page"
      [loading]="loading"
      [error]="error"
      (pageChange)="pages.push($event)"
      (retry)="retries = retries + 1"
    >
      <ng-template ofListRow let-row
        ><span class="cell">{{ row }}</span></ng-template
      >
    </of-list-frame>
  `,
})
class Host {
  items: string[] = [];
  page: ListFramePage | null = null;
  loading = false;
  error: ListFrameError | null = null;
  pages: number[] = [];
  retries = 0;
}

@Component({
  imports: [ListFrameComponent, ListTableDirective],
  template: `
    <of-list-frame
      label="People"
      [items]="items"
      [page]="page"
      [loading]="loading"
    >
      <ng-template ofListTable let-rows>
        <table>
          <thead class="sticky top-0">
            <tr>
              <th>Name</th>
            </tr>
          </thead>
          <tbody>
            @for (row of rows; track $index) {
              <tr>
                <td class="cell">{{ row }}</td>
              </tr>
            }
          </tbody>
        </table>
      </ng-template>
    </of-list-frame>
  `,
})
class TableHost {
  items: string[] = [];
  page: ListFramePage | null = null;
  loading = false;
}

function render(setup: (h: Host) => void) {
  const fixture = TestBed.createComponent(Host);
  setup(fixture.componentInstance);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  return { fixture, el, host: fixture.componentInstance };
}

const rows = (n: number) => Array.from({ length: n }, (_, i) => `row ${i}`);

describe('ListFrameComponent', () => {
  it('renders a table of the page inside the scroller, which scrolls sideways in the frame', () => {
    const fixture = TestBed.createComponent(TableHost);
    fixture.componentInstance.items = rows(3);
    fixture.componentInstance.page = {
      currentPage: 1,
      lastPage: 1,
      perPage: 50,
      total: 3,
    };
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const scroller = el.querySelector('[data-slot="list-scroller"]')!;
    expect(scroller.querySelectorAll('table td.cell')).toHaveLength(3);
    expect(scroller.querySelector('ul')).toBeNull();
    expect(scroller.className).toContain('overflow-x-auto');
    expect(scroller.className).not.toContain('overflow-x-hidden');
    expect(
      scroller.contains(el.querySelector('[data-slot="list-pagination"]')),
    ).toBe(false);

    const loading = TestBed.createComponent(TableHost);
    loading.componentInstance.loading = true;
    loading.detectChanges();
    // The skeleton has a bar in place of the header row.
    expect(
      (loading.nativeElement as HTMLElement).querySelector(
        'of-skeleton-rows .bg-muted.h-10',
      ),
    ).toBeTruthy();
  });

  it('renders a 1,000-row page inside its own scroller, with the pagination outside it', () => {
    const { el } = render((h) => {
      h.items = rows(1000).map((r, i) => (i === 3 ? 'x'.repeat(500) : r));
      h.page = { currentPage: 1, lastPage: 3, perPage: 1000, total: 2500 };
    });
    const frame = el.querySelector('of-list-frame') as HTMLElement;
    const scroller = el.querySelector('[data-slot="list-scroller"]')!;
    const pagination = el.querySelector('[data-slot="list-pagination"]')!;

    expect(scroller.querySelectorAll('.cell')).toHaveLength(1000);
    expect(scroller.className).toContain('overflow-y-auto');
    expect(scroller.className).toContain('overflow-x-hidden');
    expect(scroller.className).toContain('min-h-0');
    // Positioned, so it clips its rows' absolutely positioned parts (an sr-only status) instead
    // of letting them stretch the page; and the page never scrolls on from its ends (#563).
    expect(scroller.className).toContain('relative');
    expect(scroller.className).toContain('overscroll-contain');
    expect(scroller.contains(pagination)).toBe(false);
    expect(pagination.parentElement).toBe(frame);
    // Capped to the remaining viewport height; the frame never grows with its rows.
    expect(frame.style.maxHeight).toBe('calc(100dvh - 10rem)');
    expect(frame.className).toContain('flex-col');
    expect(frame.className).toContain('overflow-hidden');
    // Long values wrap.
    expect(el.querySelector('li')!.className).toContain('break-words');
    expect(pagination.textContent).toContain('Page 1 of 3');
  });

  it('pages with the buttons and disables them at the ends', () => {
    const { fixture, el, host } = render((h) => {
      h.items = rows(2);
      h.page = { currentPage: 1, lastPage: 2, perPage: 2, total: 4 };
    });
    const [prev, next] = Array.from(
      el.querySelectorAll<HTMLButtonElement>(
        '[data-slot="list-pagination"] button',
      ),
    ) as [HTMLButtonElement, HTMLButtonElement];
    expect(prev.disabled).toBe(true);
    next.click();
    expect(host.pages).toEqual([2]);
    host.page = { currentPage: 2, lastPage: 2, perPage: 2, total: 4 };
    fixture.detectChanges();
    expect(next.disabled).toBe(true);
  });

  it('shows skeleton rows, not a spinner, while loading the first time', () => {
    const { el } = render((h) => {
      h.loading = true;
      h.items = [];
    });
    expect(el.querySelector('[data-state="loading"]')).not.toBeNull();
    expect(el.querySelector('.cell')).toBeNull();
    expect(el.querySelector('ng-icon')).toBeNull();
    expect(el.querySelector('of-list-frame')!.getAttribute('aria-busy')).toBe(
      'true',
    );
    expect(el.querySelector('[data-slot="list-pagination"]')).toBeNull();
  });

  it('keeps the rows on screen, dimmed, while loading again, with the pagination disabled', () => {
    const { el } = render((h) => {
      h.loading = true;
      h.items = rows(3);
      h.page = { currentPage: 2, lastPage: 3, perPage: 3, total: 9 };
    });
    expect(el.querySelector('[data-state="loading"]')).toBeNull();
    expect(el.querySelectorAll('.cell').length).toBe(3);
    const list = el.querySelector('[aria-busy="true"].opacity-60');
    expect(list).not.toBeNull();
    // The stale rows can't be used meanwhile.
    expect(list!.hasAttribute('inert')).toBe(true);
    const pagination = el.querySelector('[data-slot="list-pagination"]');
    expect(pagination).not.toBeNull();
    const buttons = Array.from(pagination!.querySelectorAll('button'));
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) {
      expect((b as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('shows the empty state', () => {
    const { el } = render(() => undefined);
    expect(el.querySelector('[data-state="empty"]')!.textContent).toContain(
      'Nothing here yet',
    );
  });

  it('shows an error with a retry that emits', () => {
    const { el, host } = render((h) => {
      h.error = { kind: 'unavailable', message: 'Busy.' };
    });
    const state = el.querySelector('[data-state="error"]')!;
    expect(state.textContent).toContain('Busy.');
    state.querySelector('button')!.click();
    expect(host.retries).toBe(1);
  });

  it('shows no access, without retry, for an unauthorized error', () => {
    const { el } = render((h) => {
      h.error = { kind: 'unauthorized', message: '' };
    });
    const state = el.querySelector('[data-state="no-access"]')!;
    expect(state.textContent).toContain('You do not have access');
    expect(state.querySelector('button')).toBeNull();
  });

  it('offers no retry for a missing thing', () => {
    const { el } = render((h) => {
      h.error = { kind: 'not-found', message: 'Gone.' };
    });
    expect(el.querySelector('[data-state="error"] button')).toBeNull();
  });
});

@Component({
  imports: [ListFrameComponent, ListGridDirective],
  template: `
    <of-list-frame
      label="Images"
      [items]="items"
      [page]="page"
      [loading]="loading"
      [skeletonRows]="6"
    >
      <ng-template ofListGrid let-tiles>
        <div class="tiles">
          @for (tile of tiles; track $index) {
            <span class="tile">{{ tile }}</span>
          }
        </div>
      </ng-template>
    </of-list-frame>
  `,
})
class GridHost {
  items: string[] = [];
  page: ListFramePage | null = null;
  loading = false;
}

describe('ListFrameComponent as a grid', () => {
  const renderGrid = (setup: (h: GridHost) => void) => {
    const f = TestBed.createComponent(GridHost);
    setup(f.componentInstance);
    f.detectChanges();
    return f.nativeElement as HTMLElement;
  };

  it('shows placeholder tiles while loading the first time, unframed', () => {
    const el = renderGrid((h) => (h.loading = true));
    expect(
      el.querySelectorAll('[data-state="loading"] .aspect-\\[8\\/5\\]'),
    ).toHaveLength(6);
    expect(
      el.querySelector('of-list-frame')!.classList.contains('border'),
    ).toBe(false);
  });

  it('hands the whole page to the grid template, with the pagination outside it', () => {
    const el = renderGrid((h) => {
      h.items = ['a', 'b'];
      h.page = { currentPage: 1, lastPage: 2, perPage: 2, total: 3 };
    });
    expect(
      [...el.querySelectorAll('.tiles .tile')].map((t) => t.textContent),
    ).toEqual(['a', 'b']);
    // One template for the page, not one per item.
    expect(el.querySelectorAll('.tiles')).toHaveLength(1);
    const scroller = el.querySelector('[data-slot="list-scroller"]')!;
    const pagination = el.querySelector('[data-slot="list-pagination"]')!;
    expect(scroller.contains(pagination)).toBe(false);
  });
});
