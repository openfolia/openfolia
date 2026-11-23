import { DestroyRef, effect, inject, Injectable } from '@angular/core';
import { Title } from '@angular/platform-browser';
import {
  type ActivatedRouteSnapshot,
  type RouterStateSnapshot,
  TitleStrategy,
} from '@angular/router';
import { TranslocoService } from '@jsverse/transloco';

import { BrandingService } from '../branding/branding.service';

/**
 * Route titles are translation keys. The document title is the innermost route's title in the
 * active language ("Roles and permissions - Admin" under a parent with `data.titleParent`), then
 * the product's name from the branding (#169), and is set again when the language or the
 * product's name changes.
 */
@Injectable()
export class TranslatedTitleStrategy extends TitleStrategy {
  private readonly title = inject(Title);
  private readonly transloco = inject(TranslocoService);
  private readonly product = inject(BrandingService).productName;
  private last: RouterStateSnapshot | undefined;

  constructor() {
    super();
    effect(() => {
      this.product();
      if (this.last) this.updateTitle(this.last);
    });
    const subscription = this.transloco.langChanges$.subscribe(() => {
      if (this.last) this.updateTitle(this.last);
    });
    inject(DestroyRef).onDestroy(() => subscription.unsubscribe());
  }

  override updateTitle(snapshot: RouterStateSnapshot): void {
    this.last = snapshot;
    const key = this.buildTitle(snapshot);
    if (key === undefined) return;
    const page = this.transloco.translate(key);
    const parent = innermost(snapshot.root).data['titleParent'];
    const title =
      typeof parent === 'string'
        ? this.transloco.translate('editor.titles.nested', {
            page,
            parent: this.transloco.translate(parent),
          })
        : page;
    this.title.setTitle(
      this.transloco.translate('editor.titles.product', {
        title,
        product: this.product(),
      }),
    );
  }
}

function innermost(route: ActivatedRouteSnapshot): ActivatedRouteSnapshot {
  let current = route;
  while (current.firstChild) current = current.firstChild;
  return current;
}
