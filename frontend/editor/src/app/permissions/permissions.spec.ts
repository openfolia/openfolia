import { Component, signal } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ZardButtonComponent } from '@openfolia/ui/button';

import { GuardDirective } from './guard.directive';
import { MeService, toMe } from './me';
import { ManualPermissions, PermissionService } from './permission.service';
import { contributesOnly, decide, suggestsOnly } from './permissions';

beforeEach(() =>
  TestBed.configureTestingModule({
    providers: [provideHttpClient(), provideHttpClientTesting()],
  }),
);

describe('decide', () => {
  const granted = new Set(['releases.read']);

  it('hides what the role can never do', () => {
    expect(decide(granted, { permission: 'admin.roles' })).toEqual({
      kind: 'hidden',
    });
  });

  it('allows a rule that any of its other permissions grants (#254)', () => {
    expect(
      decide(granted, { permission: 'admin.roles', anyOf: ['releases.read'] }),
    ).toEqual({ kind: 'enabled' });
    expect(
      decide(granted, { permission: 'admin.roles', anyOf: ['webhook.manage'] }),
    ).toEqual({ kind: 'hidden' });
  });

  it('hides it even when something blocks it right now', () => {
    expect(
      decide(granted, { permission: 'admin.roles', blockedReason: 'x' }),
    ).toEqual({ kind: 'hidden' });
  });

  it('disables with the reason what is blocked now', () => {
    expect(
      decide(granted, {
        permission: 'releases.read',
        blockedReason: 'Checks are failing',
      }),
    ).toEqual({ kind: 'disabled', reason: 'Checks are failing' });
  });

  it('enables otherwise, also for an empty or null reason', () => {
    expect(decide(granted, { permission: 'releases.read' })).toEqual({
      kind: 'enabled',
    });
    expect(
      decide(granted, { permission: 'releases.read', blockedReason: '' }),
    ).toEqual({ kind: 'enabled' });
    expect(
      decide(granted, { permission: 'releases.read', blockedReason: null }),
    ).toEqual({ kind: 'enabled' });
  });
});

describe('contributors (#137)', () => {
  it('suggest only with content.edit and without content.read.draft', () => {
    expect(suggestsOnly(new Set(['content.read', 'content.edit']))).toBe(true);
    expect(
      suggestsOnly(
        new Set(['content.read', 'content.read.draft', 'content.edit']),
      ),
    ).toBe(false);
    expect(suggestsOnly(new Set(['content.read']))).toBe(false);
  });

  it('are labelled in review when they neither review nor approve', () => {
    expect(contributesOnly(new Set(['content.read', 'content.edit']))).toBe(
      true,
    );
    expect(contributesOnly(new Set(['content.review']))).toBe(false);
    expect(contributesOnly(new Set(['content.approve']))).toBe(false);
  });

  it('read manuals but never build them (ManualPermissions)', () => {
    TestBed.overrideProvider(PermissionService, {
      useFactory: () => new ManualPermissions(),
    });
    const me = TestBed.inject(MeService);
    const manuals = TestBed.inject(PermissionService);
    const edit = { permission: 'content.edit' };
    const read = { permission: 'content.read' };
    const as = (permissions: string[]) =>
      me.set({
        id: 'c',
        kind: 'user',
        name: 'C',
        role: '',
        permissions: new Set(permissions),
      });
    as(['content.read', 'content.edit']);
    expect(manuals.state(edit).kind).toBe('hidden');
    expect(manuals.state(read).kind).toBe('enabled');
    as(['content.read', 'content.read.draft', 'content.edit']);
    expect(manuals.state(edit).kind).toBe('enabled');
  });
});

describe('toMe', () => {
  const me = (
    roles: { permissions: string[]; scope: Record<string, unknown> }[],
  ) =>
    toMe({
      data: {
        type: 'Actor',
        id: 'u',
        attributes: {
          kind: 'user',
          name: 'U',
          roles: roles.map((r, i) => ({ id: `r${i}`, name: `R${i}`, ...r })),
        },
        meta: { permissions: [] },
      },
    } as unknown as Parameters<typeof toMe>[0]);

  it('edits everything only with drafts and editing, each in an unrestricted role, as the API decides for unused files', () => {
    const both = ['content.read.draft', 'content.edit'];
    expect(me([{ permissions: both, scope: {} }]).editsEverything).toBe(true);
    expect(
      me([
        { permissions: ['content.read.draft'], scope: {} },
        { permissions: ['content.edit'], scope: {} },
      ]).editsEverything,
    ).toBe(true);
    // A contributor: editing, no drafts.
    expect(
      me([{ permissions: ['content.edit'], scope: {} }]).editsEverything,
    ).toBe(false);
    expect(
      me([{ permissions: both, scope: { languages: ['de'] } }]).editsEverything,
    ).toBe(false);
    expect(
      me([
        { permissions: both, scope: { moduleTypes: ['safety'] } },
        { permissions: ['content.edit'], scope: {} },
      ]).editsEverything,
    ).toBe(false);
  });

  it('knows the permissions held in a role that restricts nothing (#254)', () => {
    const unrestricted = me([
      { permissions: ['content.read', 'webhook.manage'], scope: {} },
      { permissions: ['translation.manage'], scope: { languages: ['de'] } },
    ]).unrestricted;
    expect([...(unrestricted ?? [])].sort()).toEqual([
      'content.read',
      'webhook.manage',
    ]);
  });

  it('knows the languages translations are managed into, as the API decides for an export', () => {
    const tm = 'translation.manage';
    const managed = me([
      { permissions: [tm], scope: { languages: ['de'] } },
      { permissions: [tm], scope: { languages: ['fr'], moduleTypes: ['x'] } },
      { permissions: ['content.read'], scope: {} },
    ]).managedLanguages;
    expect(managed === 'all' ? managed : [...managed!].sort()).toEqual([
      'de',
      'fr',
    ]);
    expect(
      me([
        { permissions: [tm], scope: { languages: ['de'] } },
        { permissions: [tm], scope: { moduleTypes: ['x'] } },
      ]).managedLanguages,
    ).toBe('all');
    expect([...(me([]).managedLanguages as Set<string>)]).toEqual([]);
  });
});

describe('PermissionService', () => {
  it('follows the current person', () => {
    const me = TestBed.inject(MeService);
    const service = TestBed.inject(PermissionService);
    const rule = { permission: 'admin.roles' };
    // Nobody holds anything until the API has said who is acting.
    expect(service.state(rule).kind).toBe('hidden');
    me.set({
      id: 'r',
      kind: 'user',
      name: 'R',
      role: 'Admin',
      permissions: new Set(['admin.roles']),
    });
    expect(service.state(rule).kind).toBe('enabled');
    me.set({
      id: 'a',
      kind: 'user',
      name: 'A',
      role: 'Viewer',
      permissions: new Set(),
    });
    expect(service.state(rule).kind).toBe('hidden');
  });
});

@Component({
  imports: [GuardDirective],
  template: `
    <button id="a" [ofGuard]="rule()" (click)="clicks = clicks + 1">A</button>
  `,
})
class Host {
  rule = signal<{ permission: string; blockedReason?: string }>({
    permission: 'x',
  });
  clicks = 0;
}

describe('GuardDirective', () => {
  async function setup(permissions: string[]) {
    TestBed.inject(MeService).set({
      id: 'a',
      kind: 'user',
      name: 'A',
      role: 'R',
      permissions: new Set(permissions),
    });
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const button = fixture.nativeElement.querySelector(
      '#a',
    ) as HTMLButtonElement;
    return { fixture, button };
  }

  it('hides without the permission', async () => {
    const { button } = await setup([]);
    expect(button.hidden).toBe(true);
  });

  it('keeps a blocked control focusable, explains it and swallows the click', async () => {
    const { fixture, button } = await setup(['x']);
    fixture.componentInstance.rule.set({
      permission: 'x',
      blockedReason: 'Checks fail',
    });
    await fixture.whenStable();
    expect(button.hidden).toBe(false);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('aria-description')).toBe('Checks fail');
    expect(button.disabled).toBe(false);
    button.click();
    expect(fixture.componentInstance.clicks).toBe(0);
  });

  it('shows the reason in the Tooltip on keyboard focus and describes the control with it', async () => {
    const { fixture, button } = await setup(['x']);
    fixture.componentInstance.rule.set({
      permission: 'x',
      blockedReason: 'Checks fail',
    });
    await fixture.whenStable();
    // The tooltip shows and hides on timers, and renders on the change detection those start:
    // on fake time they run in order, however late a loaded machine runs real ones (#355).
    vi.useFakeTimers();
    button.focus();
    await vi.advanceTimersByTimeAsync(400);
    const tip = document.querySelector('[role="tooltip"]');
    expect(tip?.textContent).toContain('Checks fail');
    expect(button.getAttribute('aria-describedby')).toBe(tip?.id);
    button.blur();
    await vi.advanceTimersByTimeAsync(400);
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });

  it('lets an allowed control through', async () => {
    const { fixture, button } = await setup(['x']);
    button.click();
    expect(fixture.componentInstance.clicks).toBe(1);
    expect(button.hasAttribute('aria-description')).toBe(false);
  });

  it('stays blocked when a Zard button on the same element rewrites aria-disabled', async () => {
    TestBed.inject(MeService).set({
      id: 'a',
      kind: 'user',
      name: 'A',
      role: 'R',
      permissions: new Set(['x']),
    });
    const fixture = TestBed.createComponent(ZardHost);
    await fixture.whenStable();
    const button = fixture.nativeElement.querySelector('button') as HTMLElement;
    expect(button.getAttribute('aria-disabled')).toBe('true');
    fixture.componentInstance.loading.set(true);
    await fixture.whenStable();
    fixture.componentInstance.loading.set(false);
    await fixture.whenStable();
    expect(button.getAttribute('aria-disabled')).toBe('true');
  });

  it("leaves a Zard button's own aria-disabled alone when the rule allows it", async () => {
    TestBed.inject(MeService).set({
      id: 'a',
      kind: 'user',
      name: 'A',
      role: 'R',
      permissions: new Set(['x']),
    });
    const fixture = TestBed.createComponent(ZardHost);
    fixture.componentInstance.reason.set(null);
    fixture.componentInstance.disabled.set(true);
    await fixture.whenStable();
    const button = fixture.nativeElement.querySelector('button') as HTMLElement;
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.hidden).toBe(false);
  });

  it('gives back the own aria-disabled once the rule allows the control again', async () => {
    TestBed.inject(MeService).set({
      id: 'a',
      kind: 'user',
      name: 'A',
      role: 'R',
      permissions: new Set(['x']),
    });
    const fixture = TestBed.createComponent(ZardHost);
    fixture.componentInstance.disabled.set(true);
    await fixture.whenStable();
    const button = fixture.nativeElement.querySelector('button') as HTMLElement;
    expect(button.getAttribute('aria-description')).toBe('Busy');
    fixture.componentInstance.reason.set(null);
    await fixture.whenStable();
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.hasAttribute('aria-description')).toBe(false);
    expect(button.title).toBe('Save the draft');
  });
});

@Component({
  imports: [GuardDirective, ZardButtonComponent],
  template: `
    <button
      z-button
      [zLoading]="loading()"
      [zDisabled]="disabled()"
      title="Save the draft"
      [ofGuard]="{ permission: 'x', blockedReason: reason() }"
    >
      Save
    </button>
  `,
})
class ZardHost {
  loading = signal(false);
  disabled = signal(false);
  reason = signal<string | null>('Busy');
}
