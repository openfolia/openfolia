import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslocoService } from '@jsverse/transloco';
import { afterEach, describe, expect, it } from 'vitest';

import { ZardDialogService } from '../dialog/dialog.service';
import { ZardSheetService } from '../sheet/sheet.service';

import { ZardAlertDialogImports } from './alert-dialog.imports';
import { ZardAlertDialogService } from './alert-dialog.service';

/** A name as a person or an identity provider may write it: markup that must show as typed. */
const MARKUP =
  '<a href="https://example.org">admins</a><img src=x><b>&amp;</b>';

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** Renders what a service opened: a few rounds of timers and change detection. */
async function settle() {
  for (let round = 0; round < 3; round++) {
    await wait();
    TestBed.tick();
  }
}

/** The description the open overlay shows. */
function description(testId: string): Element {
  const found = document.querySelector(`[data-testid="${testId}"]`);
  if (!found) throw new Error(`no ${testId}`);
  return found;
}

function expectLiteral(element: Element, text: string): void {
  expect(element.textContent).toContain(text);
  expect(element.querySelector('a, img, b')).toBeNull();
}

afterEach(() => {
  document
    .querySelectorAll('.cdk-overlay-container')
    .forEach((c) => c.replaceChildren());
});

describe('alert dialog description', () => {
  const kinds = ['create', 'confirm', 'warning', 'info'] as const;

  for (const kind of kinds) {
    it(`shows markup in zDescription as literal text (${kind})`, async () => {
      const dialogs = TestBed.inject(ZardAlertDialogService);
      dialogs[kind]({
        zTitle: 'Remove?',
        zDescription: `Members of “${MARKUP}” lose the role.`,
        zDuration: 0,
      });
      await settle();
      expectLiteral(
        description('z-alert-description'),
        `Members of “${MARKUP}” lose the role.`,
      );
    });
  }

  it('renders the markup of a zDescriptionHtml translation, its parameters as literal text', async () => {
    TestBed.inject(TranslocoService).setTranslationKey(
      'test.removeGroup',
      '<em>{group}</em> loses {roles, plural, one {# role} other {# roles}}, as {who} asked.',
      { lang: 'en' },
    );
    TestBed.inject(ZardAlertDialogService).confirm({
      zTitle: 'Remove?',
      zDescriptionHtml: {
        key: 'test.removeGroup',
        params: { group: MARKUP, roles: 2, who: '<i>Ann</i>' },
      },
      zDuration: 0,
    });
    await settle();
    const shown = description('z-alert-description');
    // The translation's own emphasis is kept; nothing of the names is markup.
    const em = shown.querySelector('em');
    expect(em?.textContent).toBe(MARKUP);
    expect(em?.children).toHaveLength(0);
    expect(shown.querySelector('a, img, b, i')).toBeNull();
    expect(shown.textContent).toContain('loses 2 roles, as <i>Ann</i> asked.');
  });

  it('prefers the plain-text zDescription when both are given', async () => {
    TestBed.inject(ZardAlertDialogService).confirm({
      zTitle: 'Remove?',
      zDescription: MARKUP,
      zDescriptionHtml: { key: 'ui.dialog.confirm' },
      zDuration: 0,
    });
    await settle();
    expect(
      document.querySelectorAll('[data-testid="z-alert-description"]'),
    ).toHaveLength(1);
    expectLiteral(description('z-alert-description'), MARKUP);
  });

  it('shows markup in the declarative description as literal text', async () => {
    @Component({
      imports: [ZardAlertDialogImports],
      template: `
        <z-alert-dialog [(zVisible)]="open" [zDuration]="0">
          <z-alert-dialog-description
            data-testid="declared"
            [zDescription]="text"
          />
        </z-alert-dialog>
      `,
    })
    class Host {
      readonly open = signal(true);
      readonly text = MARKUP;
    }
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    await fixture.whenStable();
    expectLiteral(description('declared'), MARKUP);
  });
});

describe('dialog and sheet descriptions', () => {
  it('shows markup in a dialog zDescription as literal text', async () => {
    TestBed.inject(ZardDialogService).create({
      zTitle: 'Rename',
      zDescription: MARKUP,
      zDuration: 0,
    });
    await settle();
    expectLiteral(description('z-description'), MARKUP);
  });

  it('shows markup in a sheet zDescription as literal text', async () => {
    TestBed.inject(ZardSheetService).create({
      zTitle: 'Details',
      zDescription: MARKUP,
      zDuration: 0,
    });
    await settle();
    expectLiteral(description('z-description'), MARKUP);
  });
});
