import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { ToastService } from '@openfolia/ui/toast';

import { apiErrorInterceptor } from '../api/api-interceptors';
import { MeService } from '../permissions/me';
import { ModuleRename } from './module-rename';

const mod = (lang: string, moduleId: string) => ({
  type: 'module',
  lang,
  moduleId,
});
const operating = { type: 'manual', manualId: 'operating' };

const plan = (
  id: string,
  references: unknown[] = [],
  workingCopies: unknown[] = [],
  translations: unknown[] = [],
) => ({
  data: {
    type: 'ModuleReferences',
    id,
    attributes: { languages: ['en'], references, translations },
    meta: { head: 'h1', workingCopies },
  },
});
const created = { status: 201, statusText: 'Created' };
const refusal = (status: number, code: string, meta = {}) =>
  [
    { errors: [{ status: String(status), code, meta }] },
    { status, statusText: 'Refused' },
  ] as const;

function setup(person = 'author') {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(withInterceptors([apiErrorInterceptor])),
      provideHttpClientTesting(),
    ],
  });
  const me = TestBed.inject(MeService);
  me.set({
    id: person,
    kind: 'user',
    name: 'Author',
    role: '',
    permissions: new Set(['content.read', 'content.edit']),
  });
  return {
    me,
    renames: TestBed.inject(ModuleRename),
    http: TestBed.inject(HttpTestingController),
    toast: TestBed.inject(ToastService),
  };
}

const flushAll = async () => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
};

/** Answers the lock requests, in order, for `subjects`. */
async function locks(http: HttpTestingController, subjects: unknown[]) {
  for (const subject of subjects) {
    const take = http.expectOne('/api/change-sets/cs1/locks');
    expect(take.request.body.data.attributes.subject).toEqual(subject);
    take.flush({ data: { id: 'l' } }, created);
    await flushAll();
  }
}

const request = { from: 'charging', to: 'battery-charging', title: 'Charging' };

describe('ModuleRename', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('takes the locks, commits the working copies in its way, renames, and Undo renames back', async () => {
    const { renames, http, toast } = setup();
    const undone = vi.fn();
    const done = renames.rename(request, 'cs1', { undone });
    await flushAll();
    http
      .expectOne('/api/change-sets/cs1/module-references/charging')
      .flush(
        plan(
          'charging',
          [operating],
          [mod('en', 'charging')],
          [mod('de', 'safety-note')],
        ),
      );
    await flushAll();
    await locks(http, [
      mod('en', 'charging'),
      mod('en', 'battery-charging'),
      operating,
      mod('de', 'safety-note'),
    ]);
    const commit = http.expectOne('/api/change-sets/cs1/commits');
    expect(commit.request.body.data.attributes).toEqual({
      subjects: [mod('en', 'charging')],
    });
    commit.flush({ data: { id: 'c1' } }, created);
    await flushAll();
    const rename = http.expectOne('/api/change-sets/cs1/module-renames');
    expect(rename.request.body).toEqual({
      data: {
        type: 'ModuleRename',
        attributes: { from: 'charging', to: 'battery-charging' },
      },
    });
    rename.flush({ data: { id: 'r1' } }, created);
    expect(await done).toBe(true);
    const shown = toast.toasts().at(-1);
    expect(shown?.kind).toBe('success');
    expect(shown?.message).toMatchObject({
      key: 'editor.moduleEditor.rename.done',
      params: { title: 'Charging', id: 'battery-charging' },
    });

    // Undo: the same way back, no working copies this time.
    shown?.onAction?.();
    await flushAll();
    http
      .expectOne('/api/change-sets/cs1/module-references/battery-charging')
      .flush(plan('battery-charging', [operating]));
    await flushAll();
    await locks(http, [
      mod('en', 'battery-charging'),
      mod('en', 'charging'),
      operating,
    ]);
    const back = http.expectOne('/api/change-sets/cs1/module-renames');
    expect(back.request.body.data.attributes).toEqual({
      from: 'battery-charging',
      to: 'charging',
    });
    back.flush({ data: { id: 'r2' } }, created);
    await flushAll();
    expect(undone).toHaveBeenCalledTimes(1);
    expect(toast.toasts().at(-1)?.message).toMatchObject({
      key: 'editor.moduleEditor.rename.undone',
    });
  });

  it('says which kind of file another change set holds, and renames nothing', async () => {
    const { renames, http, toast } = setup();
    const done = renames.rename(request, 'cs1');
    await flushAll();
    http
      .expectOne('/api/change-sets/cs1/module-references/charging')
      .flush(plan('charging', [operating]));
    await flushAll();
    await locks(http, [mod('en', 'charging'), mod('en', 'battery-charging')]);
    http
      .expectOne('/api/change-sets/cs1/locks')
      .flush(...refusal(409, 'locked'));
    expect(await done).toBe(false);
    expect(toast.toasts().at(-1)?.message).toMatchObject({
      key: 'editor.moduleEditor.rename.lockedManual',
    });
  });

  it('says why the server refused it, by the code', async () => {
    const { renames, http, toast } = setup();
    const done = renames.rename(request, 'cs1');
    await flushAll();
    http
      .expectOne('/api/change-sets/cs1/module-references/charging')
      .flush(plan('charging'));
    await flushAll();
    await locks(http, [mod('en', 'charging'), mod('en', 'battery-charging')]);
    http
      .expectOne('/api/change-sets/cs1/module-renames')
      .flush(...refusal(409, 'id-taken', { moduleId: 'battery-charging' }));
    expect(await done).toBe(false);
    const shown = toast.toasts().at(-1);
    expect(shown?.kind).toBe('error');
    expect(String(shown?.message)).toContain(
      'A module with this ID exists already',
    );
    // A conflict may pass: offered again.
    expect(shown?.actionLabel).toBeDefined();
  });

  it('does nothing for someone else signed in meanwhile', async () => {
    const { renames, http, me, toast } = setup();
    const before = toast.toasts().length;
    const done = renames.rename(request, 'cs1');
    await flushAll();
    me.set({
      id: 'someone-else',
      kind: 'user',
      name: 'Else',
      role: '',
      permissions: new Set(['content.read', 'content.edit']),
    });
    http
      .expectOne('/api/change-sets/cs1/module-references/charging')
      .flush(plan('charging'));
    expect(await done).toBe(false);
    expect(toast.toasts().length).toBe(before);
  });
});
