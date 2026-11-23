import {
  type APIRequestContext,
  type APIResponse,
  request,
} from '@playwright/test';

/**
 * The state a flow needs, made through the API (never through the UI), as one of the seeded
 * demo users. Every helper checks its answer, so a broken setup fails where it broke.
 */

/** The seeded example users (`backend/api/src/access/repos/example-seed.ts`). */
export const USERS = {
  admin: 'sample-admin',
  author: 'sample-author',
  contributor: 'sample-contributor',
  reviewer: 'sample-reviewer',
  approver: 'sample-approver',
  translator: 'sample-translator',
  publisher: 'sample-publisher',
  reader: 'sample-reader',
} as const;
export type UserId = (typeof USERS)[keyof typeof USERS];

const MEDIA_TYPE = 'application/vnd.api+json';

/** An API document as the helpers read it: loosely, since the API's own tests check its shape. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = Record<string, any>;

export interface ModuleRef {
  readonly lang: string;
  readonly moduleId: string;
}

export interface Block {
  readonly type: string;
  readonly id: string;
  readonly [key: string]: unknown;
}

export interface ModuleContent {
  readonly blocks: readonly Block[];
  readonly [key: string]: unknown;
}

export const paragraph = (id: string, text: string): Block => ({
  type: 'paragraph',
  id,
  content: [{ type: 'text', text }],
});

/** A unique, readable suffix, so parallel tests never meet in shared data. */
export function unique(prefix: string): string {
  return `${prefix} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export class Api {
  /** Change sets this client started: abandoned by `cleanUp()` unless they were merged. */
  private readonly started: string[] = [];

  private readonly context: APIRequestContext;
  readonly user: UserId;

  private constructor(context: APIRequestContext, user: UserId) {
    this.context = context;
    this.user = user;
  }

  /** A client acting as `user` (demo mode's `X-Ccms-User`). */
  static async as(user: UserId): Promise<Api> {
    const baseURL = process.env['E2E_API_URL'];
    const token = process.env['E2E_API_TOKEN'];
    if (!baseURL || !token) {
      throw new Error(
        'E2E_API_URL and E2E_API_TOKEN come from the global setup',
      );
    }
    const context = await request.newContext({
      baseURL,
      extraHTTPHeaders: {
        Authorization: `Bearer ${token}`,
        'X-Ccms-User': user,
        Accept: MEDIA_TYPE,
      },
    });
    return new Api(context, user);
  }

  dispose(): Promise<void> {
    return this.context.dispose();
  }

  /**
   * Abandons the change sets this client started and did not merge, so their locks are free for
   * the next test (a retry included). A change set already merged or abandoned is left alone.
   * The abandons go on a fresh connection (the client's own may have sat idle past the API's
   * keep-alive through the test), and one the API closed as it went out (`ECONNRESET`,
   * "socket hang up", `EPIPE`) is tried once more: abandoning twice is safe, the second answer
   * is a 409.
   */
  async cleanUp(): Promise<void> {
    const ids = this.started.splice(0);
    if (ids.length === 0) return;
    const fresh = await Api.as(this.user);
    try {
      for (const id of ids) await fresh.abandon(id);
    } finally {
      await fresh.dispose();
    }
  }

  /** Abandons change set `id` (one already merged or abandoned answers 409: left alone). */
  async abandon(id: string): Promise<void> {
    const abandon = () => this.send('POST', `/change-sets/${id}/abandon`);
    const answer = await abandon().catch((error: unknown) => {
      if (!/ECONNRESET|socket hang up|EPIPE/i.test(String(error))) throw error;
      return abandon();
    });
    if (![200, 404, 409].includes(answer.status())) {
      throw new Error(
        `abandoning ${id} answered ${answer.status()}: ${await answer.text()}`,
      );
    }
  }

  /**
   * Reads `path`. A read the API closed as it went out (the client's connection idle past the
   * API's keep-alive while the page worked: `ECONNRESET`, "socket hang up", `EPIPE`) is sent
   * once more, as a read changes nothing (#633: the poll after a merge).
   */
  get(path: string): Promise<APIResponse> {
    return this.context.get(path).catch((error: unknown) => {
      if (!/ECONNRESET|socket hang up|EPIPE/i.test(String(error))) throw error;
      return this.context.get(path);
    });
  }

  /** A JSON:API request with a body (or none), the API's media type set as it requires. */
  send(
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<APIResponse> {
    return this.context.fetch(path, {
      method,
      headers: { 'Content-Type': MEDIA_TYPE },
      data: body === undefined ? '' : JSON.stringify(body),
    });
  }

  /** `path`'s document, checked to answer `status`. */
  async json<T = Json>(
    response: Promise<APIResponse>,
    status: number | number[] = 200,
  ): Promise<T> {
    const answer = await response;
    const expected = Array.isArray(status) ? status : [status];
    if (!expected.includes(answer.status())) {
      throw new Error(
        `${answer.url()} answered ${answer.status()}, not ${expected.join(' or ')}: ${await answer.text()}`,
      );
    }
    const text = await answer.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** A new change set (a "revision") with `title`, on a maintenance line when one is named. */
  async createChangeSet(
    title: string,
    { maintenanceLine }: { maintenanceLine?: string } = {},
  ): Promise<{ id: string; branch: string; baseCommit: string }> {
    const { data } = await this.json(
      this.send('POST', '/change-sets', {
        data: {
          type: 'ChangeSet',
          attributes: { title, ...(maintenanceLine && { maintenanceLine }) },
        },
      }),
      201,
    );
    this.started.push(data.id);
    return {
      id: data.id,
      branch: data.attributes.branch,
      baseCommit: data.attributes.baseCommit,
    };
  }

  /** A change set this client's user started in the browser: abandoned after the test too. */
  adopt(changeSet: string): void {
    this.started.push(changeSet);
  }

  /** Uploads an image (PNG or JPEG bytes) into the change set; its reference (`sha256:…`). */
  async uploadImage(changeSet: string, image: Buffer): Promise<string> {
    const { data } = await this.json(
      this.context.post(`/change-sets/${changeSet}/assets`, {
        // A form needs the cross-site request header.
        headers: { 'X-Ccms-Request': 'e2e' },
        multipart: {
          file: { name: 'picture.png', mimeType: 'image/png', buffer: image },
        },
      }),
      [200, 201],
    );
    return data.attributes.reference;
  }

  /** Locks `subject` for the change set (or finds it locked for it already). */
  async lock(
    changeSet: string,
    subject: Record<string, string>,
  ): Promise<void> {
    await this.json(
      this.send('POST', `/change-sets/${changeSet}/locks`, {
        data: { type: 'Lock', attributes: { subject } },
      }),
      // 200: the change set holds it already.
      [200, 201],
    );
  }

  /**
   * Adds a new module to the change set (a save point included unless `savePoint: false`).
   * A module of its own per test: no other test ever waits for its lock.
   */
  async createModule(
    changeSet: { id: string; baseCommit: string },
    module: ModuleRef & {
      title: string;
      type?: string;
      blocks: readonly Block[];
    },
    { savePoint = true }: { savePoint?: boolean } = {},
  ): Promise<void> {
    const { lang, moduleId, title, type = 'concept', blocks } = module;
    await this.lock(changeSet.id, { type: 'module', lang, moduleId });
    await this.json(
      this.send(
        'PUT',
        `/change-sets/${changeSet.id}/modules/${lang}/${moduleId}/working-copy`,
        {
          data: {
            type: 'WorkingCopy',
            attributes: {
              content: {
                schemaVersion: 1,
                id: moduleId,
                meta: { title, type, lang, facets: {} },
                blocks,
              },
            },
          },
          meta: { version: 0, baseCommit: changeSet.baseCommit },
        },
      ),
    );
    if (savePoint) await this.savePoint(changeSet.id);
  }

  /**
   * Locks `module` in the change set, changes its working copy with `change` and makes a save
   * point, so the change is on the branch.
   */
  editModule(
    changeSet: string,
    module: ModuleRef,
    change: (content: ModuleContent) => ModuleContent,
    { savePoint = true }: { savePoint?: boolean } = {},
  ): Promise<void> {
    return this.editSubject(
      changeSet,
      { type: 'module', ...module },
      `modules/${module.lang}/${module.moduleId}`,
      change as (content: Json) => unknown,
      savePoint,
    );
  }

  /** The same for a manual (its manifest: `title`, `entries`, …). */
  editManual(
    changeSet: string,
    manualId: string,
    change: (content: Json) => Json,
    { savePoint = true }: { savePoint?: boolean } = {},
  ): Promise<void> {
    return this.editSubject(
      changeSet,
      { type: 'manual', manualId },
      `manuals/${manualId}`,
      change,
      savePoint,
    );
  }

  /** The same for the project configuration (`openfolia.yaml`; an admin's). */
  editConfig(
    changeSet: string,
    change: (content: Json) => Json,
    { savePoint = true }: { savePoint?: boolean } = {},
  ): Promise<void> {
    return this.editSubject(
      changeSet,
      { type: 'config' },
      'config',
      change,
      savePoint,
    );
  }

  /**
   * Adds a new manual to the change set (its manifest: `title`, `variants`, `entries`, or a
   * derived manual's `kind` and `rule`; `schemaVersion` and `id` are filled in), with a save point.
   * A manual of its own per test: no other test waits for its lock.
   */
  async createManual(
    changeSet: { id: string; baseCommit: string },
    manualId: string,
    manifest: Record<string, unknown>,
  ): Promise<void> {
    await this.lock(changeSet.id, { type: 'manual', manualId });
    await this.json(
      this.send(
        'PUT',
        `/change-sets/${changeSet.id}/manuals/${manualId}/working-copy`,
        {
          data: {
            type: 'WorkingCopy',
            attributes: {
              content: {
                schemaVersion: 1,
                id: manualId,
                attributes: {},
                entries: [],
                ...manifest,
              },
            },
          },
          meta: { version: 0, baseCommit: changeSet.baseCommit },
        },
      ),
    );
    await this.savePoint(changeSet.id);
  }

  /**
   * Adds a new page design (#390, `design/<id>.yaml`) to the change set, every setting it leaves
   * out at its default, with a save point.
   */
  async createPageDesign(
    changeSet: { id: string; baseCommit: string },
    design: { id: string; name: string } & Record<string, unknown>,
  ): Promise<void> {
    await this.lock(changeSet.id, { type: 'design', designId: design.id });
    await this.json(
      this.send(
        'PUT',
        `/change-sets/${changeSet.id}/page-designs/${design.id}/working-copy`,
        {
          data: {
            type: 'WorkingCopy',
            attributes: {
              content: {
                schemaVersion: 1,
                preset: 'minimal',
                colours: {
                  primary: '#1f4e79',
                  accent: '#b45309',
                  text: '#1f2328',
                },
                ...design,
              },
            },
          },
          meta: { version: 0, baseCommit: changeSet.baseCommit },
        },
      ),
    );
    await this.savePoint(changeSet.id);
  }

  private async editSubject(
    changeSet: string,
    subject: Record<string, string>,
    path: string,
    change: (content: Json) => unknown,
    savePoint: boolean,
  ): Promise<void> {
    await this.lock(changeSet, subject);
    const workingCopy = `/change-sets/${changeSet}/${path}/working-copy`;
    const { data } = await this.json(this.get(workingCopy));
    await this.json(
      this.send('PUT', workingCopy, {
        data: {
          type: 'WorkingCopy',
          attributes: { content: change(data.attributes.content) },
        },
        meta: {
          version: data.attributes.version,
          baseCommit: data.attributes.baseCommit,
        },
      }),
    );
    if (savePoint) await this.savePoint(changeSet);
  }

  /** Commits the change set's working copies (a save point). */
  async savePoint(changeSet: string): Promise<void> {
    await this.json(
      this.send('POST', `/change-sets/${changeSet}/commits`),
      201,
    );
  }

  /** A workflow step: submit, approve, request-changes, merge, abandon, … */
  async transition(
    changeSet: string,
    name: string,
    comment?: string,
  ): Promise<Json> {
    return this.json(
      this.send(
        'POST',
        `/change-sets/${changeSet}/${name}`,
        comment === undefined ? undefined : { meta: { comment } },
      ),
    );
  }

  /** A comment thread on a block of a module in the change set. */
  async comment(
    changeSet: string,
    module: ModuleRef,
    blockId: string,
    body: string,
  ): Promise<{ id: string }> {
    const { data } = await this.json(
      this.send('POST', `/change-sets/${changeSet}/comments`, {
        data: {
          type: 'Comment',
          attributes: { body, subject: { type: 'module', ...module }, blockId },
        },
      }),
      201,
    );
    return { id: data.id };
  }

  /** Cuts a release of `main`. */
  async cutRelease(attributes: {
    product: string;
    revision: string;
    notes?: string;
    notesByLanguage?: Record<string, string>;
  }): Promise<{ id: string; tag: string }> {
    const { data } = await this.json(
      this.send('POST', '/releases', { data: { type: 'Release', attributes } }),
      201,
    );
    return { id: data.id, tag: data.attributes.tag };
  }

  /** Starts a maintenance line from release `release` (`release.publish`); its ID. */
  async startMaintenanceLine(release: string): Promise<string> {
    const { data } = await this.json(
      this.send('POST', '/maintenance-lines', {
        data: {
          type: 'MaintenanceLine',
          relationships: {
            baseRelease: { data: { type: 'Release', id: release } },
          },
        },
      }),
      201,
    );
    return data.id;
  }

  /** Carries merged change set `id` forward to main: the new draft, abandoned after the test. */
  async carryForward(id: string): Promise<{ id: string }> {
    const { data } = await this.json(
      this.send('POST', `/change-sets/${id}/carry-forward`),
    );
    this.started.push(data.id);
    return { id: data.id };
  }
}

/**
 * Puts a new module on main: a change set by the author, approved by the reviewer and merged by
 * the publisher, as the workflow asks.
 */
export async function mergedModule(
  author: Api,
  reviewer: Api,
  publisher: Api,
  title: string,
): Promise<{ changeSet: string; module: ModuleRef; moduleTitle: string }> {
  const made = await changeSetWithModule(author, unique('To main'), {
    submit: true,
    moduleTitle: title,
  });
  await reviewer.transition(made.id, 'approve');
  await publisher.transition(made.id, 'merge');
  return {
    changeSet: made.id,
    module: made.module,
    moduleTitle: made.moduleTitle,
  };
}

/** A module ID no other test uses. */
export function moduleId(prefix = 'e2e'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * A change set by `author` that adds a new module (two paragraphs, `p1` and `p2`), with a save
 * point, submitted when asked.
 */
export async function changeSetWithModule(
  author: Api,
  title: string,
  {
    submit = false,
    moduleTitle = unique('E2E module'),
    maintenanceLine,
  }: { submit?: boolean; moduleTitle?: string; maintenanceLine?: string } = {},
): Promise<{ id: string; module: ModuleRef; moduleTitle: string }> {
  const changeSet = await author.createChangeSet(title, {
    ...(maintenanceLine && { maintenanceLine }),
  });
  const module = { lang: 'en', moduleId: moduleId() };
  await author.createModule(changeSet, {
    ...module,
    title: moduleTitle,
    blocks: [
      paragraph('p1', 'Charge the battery before first use.'),
      paragraph('p2', 'Keep the charger dry.'),
    ],
  });
  if (submit)
    await author.transition(changeSet.id, 'submit', 'Ready for review.');
  return { id: changeSet.id, module, moduleTitle };
}
