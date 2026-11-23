import { computed, inject, Injectable, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { injectTranslate } from '@openfolia/ui/startup';

import { ApiClient, pageQuery, type Item, type Schema } from '../api';
import { UiTexts } from '../i18n/ui-texts';
import { isUnconfirmed, MeService } from '../permissions/me';
import { PermissionService } from '../permissions/permission.service';
import { Generation } from '../shared/generation';

/** A maintenance line as the API lists it (#60): an older product version fixed apart from main. */
export type MaintenanceLine = Item<'/maintenance-lines'>;

/** The branch the published content is on. */
export const MAIN = 'main';
const PAGE_SIZE = 200;
const MAX_PAGES = 5;

type ProjectConfig = Schema<'ProjectConfig'>;

interface Read {
  /** Who it was read for (`me().id`). */
  readonly for: string;
  readonly lines: readonly MaintenanceLine[];
  readonly config: ProjectConfig | null;
}

/**
 * The maintenance lines (#250), read once per person and only when something asks: a change set
 * whose base is not `main`, the picker's "New revision" form, the Releases page. They need
 * `content.read.draft`; without it there are none.
 *
 * A line is never named by its branch anywhere in the editor: `label` names a base branch as people
 * read it, a line's as its product and product version ("North 2.1"), `main` as `main`.
 */
@Injectable({ providedIn: 'root' })
export class MaintenanceLines {
  private readonly api = inject(ApiClient);
  private readonly texts = inject(UiTexts);
  private readonly me = inject(MeService);
  private readonly permissions = inject(PermissionService);
  private readonly t = injectTranslate();

  private readonly read = signal<Read | null>(null);
  private readonly loading = signal(false);
  private readonly reads = new Generation();
  /** The person a read was last asked for, so asking again (every change detection) asks once. */
  private askedFor: string | null = null;

  private readonly person = computed(() => this.me.me().id);
  private readonly mine = computed(() => {
    const read = this.read();
    return read && read.for === this.person() ? read : null;
  });

  /** Every line the person may read (open and closed), newest first; none until read. */
  readonly all = computed(() => this.mine()?.lines ?? []);
  /** The open lines: new revisions start on these. */
  readonly open = computed(() =>
    this.all().filter((l) => l.attributes.state === 'open'),
  );
  /** The lines were read for whoever acts now (or there is nothing they may read). */
  readonly known = computed(() => this.mine() !== null);
  readonly busy = this.loading.asReadonly();

  /**
   * Asks for the lines once for whoever acts now; safe to call from a template or a computed. It
   * reads the person tracked, so a template or computed calling it before `/me` answered calls it
   * again once it has.
   */
  ensure(): void {
    const me = this.me.me();
    const who = me.id;
    if (
      who === '' ||
      isUnconfirmed(who) ||
      me.permissions.size === 0 ||
      this.askedFor === who
    )
      return;
    this.askedFor = who;
    // Never written while a template or computed is being evaluated.
    queueMicrotask(() => void this.load(who));
  }

  /** Reads the lines again (one started, one closed). */
  refresh(): Promise<void> {
    const who = untracked(this.person);
    this.askedFor = who;
    return this.load(who);
  }

  /** The line a branch belongs to, or null (`main`, another branch, or not read yet). */
  lineOf(ref: string | null | undefined): MaintenanceLine | null {
    if (!ref || ref === MAIN) return null;
    this.ensure();
    return this.all().find((l) => l.attributes.branch === ref) ?? null;
  }

  /** A product as people read it: the product facet value's label, else its ID. */
  productLabel(product: string): string {
    const config = this.mine()?.config;
    if (!config) return product;
    const id = config.release?.productFacet;
    const facet =
      (id ? config.facets.find((f) => f.id === id) : config.facets[0]) ??
      undefined;
    const label = facet?.values.find((v) => v.id === product)?.label;
    return label === undefined
      ? product
      : this.texts.text(label, config.languages) || product;
  }

  /** A line as people read it: its product and product version, "North 2.1". */
  lineLabel(line: MaintenanceLine): string {
    return this.t('editor.maintenance.lineLabel', {
      product: this.productLabel(line.attributes.product),
      version: line.attributes.revision,
    });
  }

  /**
   * A base branch as people read it: `main` as `main`, a line by its product and version. Any
   * other branch (a line started since the lines were read, or one the person may not read) is
   * "an older product version", and the lines are read once more for it: a branch name is never
   * shown.
   */
  label(ref: string | null | undefined): string {
    if (!ref || ref === MAIN) return MAIN;
    const line = this.lineOf(ref);
    if (line) return this.lineLabel(line);
    this.missing(ref);
    return this.t('editor.maintenance.otherVersion');
  }

  /** Branches looked for and not found in a read: read again once for each. */
  private readonly lookedFor = new Set<string>();

  private missing(ref: string): void {
    if (!untracked(this.known) || this.couldBeHidden()) return;
    const key = `${untracked(this.person)} ${ref}`;
    if (this.lookedFor.has(key)) return;
    this.lookedFor.add(key);
    // Never written while a template or computed is being evaluated.
    queueMicrotask(() => void this.refresh());
  }

  /** Without `content.read.draft` the lines are not to be read: any branch may be one. */
  private couldBeHidden(): boolean {
    return (
      this.permissions.state({ permission: 'content.read.draft' }).kind !==
      'enabled'
    );
  }

  private async load(who: string): Promise<void> {
    const live = this.reads.start();
    if (
      this.permissions.state({ permission: 'content.read.draft' }).kind !==
      'enabled'
    ) {
      this.read.set({ for: who, lines: [], config: null });
      return;
    }
    this.loading.set(true);
    try {
      const lines: MaintenanceLine[] = [];
      for (let number = 1; number <= MAX_PAGES; number++) {
        const page = await firstValueFrom(
          this.api.get('/maintenance-lines', {
            query: pageQuery({ number, size: PAGE_SIZE }),
          }),
        );
        lines.push(...page.data);
        if (number >= page.meta.page.lastPage) break;
      }
      let config = this.mine()?.config ?? null;
      if (lines.length > 0 && !config) {
        try {
          config = (
            await firstValueFrom(
              this.api.get('/config', { query: { ref: MAIN } }),
            )
          ).data.attributes;
        } catch {
          // Products are named by their IDs then.
        }
      }
      if (live() && who === untracked(this.person)) {
        this.read.set({ for: who, lines, config });
      }
    } catch {
      // Not to be read now: asked again next time something needs them.
      if (live() && this.askedFor === who) this.askedFor = null;
    } finally {
      if (live()) this.loading.set(false);
    }
  }
}
