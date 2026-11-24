// The sandbox test's client (deploy/sandbox-test.sh, #827): what a visitor's browser does, through
// the editor's port, as each demo person. It runs in a container of its own on the sandbox's
// network (node, the script on stdin), so nothing it does counts towards the sandbox's memory:
//
//   docker run --rm -i --network <net> -e SANDBOX_URL=http://sandbox:8080 -e MODE=<mode> \
//     --entrypoint node <image> --input-type=module - < deploy/sandbox-client.mjs
//
// MODE:
//   people  each demo person signed in (GET /api/me), the sandbox's limits (GET /api/sandbox), the
//           baked state (two releases, the change set in review), the editor's page, and the
//           proxy's refusals: a request from another site, another host, an upload
//   edit    a change made (a module edited, a save point), submitted, commented and approved
//           by the reviewer, merged by the admin; then EDIT_SAVES autosaves of a working copy,
//           as a visitor typing for a while
//   render  a release cut and its files made (every PDF, the offline packages); one PDF downloaded
//
// It prints what it did, one line each, and ends non-zero at the first answer that is wrong.

import http from 'node:http';

const base = process.env.SANDBOX_URL ?? 'http://sandbox:8080';
const mode = process.env.MODE ?? 'people';
const lang = process.env.SANDBOX_LANG ?? 'en';
const MEDIA_TYPE = 'application/vnd.api+json';
const PEOPLE = {
  author: 'demo-author',
  reviewer: 'demo-reviewer',
  admin: 'demo-admin',
};
/** The demo's product (scripts/demo/content.mjs, PRODUCT). */
const PRODUCT = 'fenna';

const say = (text) => console.log(`sandbox-client: ${text}`);
const fail = (text) => {
  console.error(`sandbox-client: FAILED: ${text}`);
  process.exit(1);
};

/**
 * One request through the editor's proxy, as the editor's own page sends it: the page's origin
 * (the proxy adds the token only then), the demo person, and the JSON:API media type.
 */
async function request(
  person,
  method,
  path,
  body,
  { expect = [200, 201], headers = {} } = {},
) {
  const response = await fetch(`${base}/api${path}`, {
    method,
    headers: {
      Origin: base,
      Accept: MEDIA_TYPE,
      ...(person && { 'X-Ccms-User': person }),
      ...(method !== 'GET' && { 'Content-Type': MEDIA_TYPE }),
      ...headers,
    },
    body:
      method === 'GET'
        ? undefined
        : body === undefined
          ? ''
          : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  if (!expect.includes(response.status))
    fail(
      `${person ?? 'nobody'}: ${method} ${path} answered ${response.status}: ${text.slice(0, 400)}`,
    );
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}
const get = (person, path) => request(person, 'GET', path).then((r) => r.body);
const post = (person, path, body, expect) =>
  request(person, 'POST', path, body, { expect }).then((r) => r.body);

/** The first text run of a module's content with ` ` + `suffix` added to it. */
function withSuffix(content, suffix) {
  let done = false;
  const walk = (node) => {
    if (done || node === null || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(walk);
    if (node.type === 'text' && typeof node.text === 'string') {
      done = true;
      return { ...node, text: `${node.text} ${suffix}` };
    }
    return Object.fromEntries(
      Object.entries(node).map(([k, v]) => [k, walk(v)]),
    );
  };
  const changed = walk(content);
  if (!done) fail('the module has no text to change');
  return changed;
}

/** The ID of the module's first block that has one (a comment's anchor). */
function firstBlockId(content) {
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return undefined;
    if (Array.isArray(node)) {
      for (const child of node) {
        const id = walk(child);
        if (id) return id;
      }
      return undefined;
    }
    // The editor's document (`attrs.id`) or the content model's (`id`).
    const id = node.attrs?.id ?? node.id;
    if (typeof node.type === 'string' && typeof id === 'string' && id)
      return id;
    return walk(node.content ?? node.blocks);
  };
  return walk(content) ?? fail('the module has no block with an ID');
}

async function lockAndRead(person, changeSet, moduleId) {
  await post(person, `/change-sets/${changeSet}/locks`, {
    data: {
      type: 'Lock',
      attributes: { subject: { type: 'module', lang, moduleId } },
    },
  });
  return `/change-sets/${changeSet}/modules/${lang}/${moduleId}/working-copy`;
}

async function save(person, path, change) {
  const { data } = await get(person, path);
  return request(person, 'PUT', path, {
    data: {
      type: 'WorkingCopy',
      attributes: { content: change(data.attributes.content) },
    },
    meta: {
      version: data.attributes.version,
      baseCommit: data.attributes.baseCommit,
    },
  });
}

async function people() {
  for (const [role, id] of Object.entries(PEOPLE)) {
    const { data } = await get(id, '/me');
    if (data?.id !== id) fail(`GET /me as ${id} answered ${data?.id}`);
    say(`signed in as the ${role}: ${data.attributes?.name ?? id}`);
  }
  const { data: sandbox } = await get(PEOPLE.author, '/sandbox');
  if (sandbox?.type !== 'Sandbox') fail('GET /sandbox: no sandbox');
  say(
    `a public sandbox: ends ${sandbox.meta.endsAt}, limits ${JSON.stringify(sandbox.attributes.limits)}`,
  );
  const releases = await get(PEOPLE.author, '/releases');
  const revisions = releases.data.map((r) => r.attributes.revision).sort();
  if (revisions.join(',') !== '1.0,1.1')
    fail(`the baked releases are ${revisions}`);
  const changeSets = await get(
    PEOPLE.reviewer,
    '/change-sets?filter[state]=in-review',
  );
  if (changeSets.data.length !== 1)
    fail(`${changeSets.data.length} change sets in review, not the baked one`);
  say(
    `baked: releases ${revisions.join(' and ')}, "${changeSets.data[0].attributes.title}" in review`,
  );

  const page = await fetch(`${base}/`);
  const html = await page.text();
  if (!page.ok || !html.includes('<of-root'))
    fail(`the editor's page answered ${page.status}`);
  say("the editor's page is served");

  // The proxy adds the token only for the editor's own page and host.
  const foreign = await fetch(`${base}/api/me`, {
    headers: {
      Origin: 'https://elsewhere.example',
      'X-Ccms-User': PEOPLE.admin,
    },
  });
  if (foreign.status !== 403)
    fail(`a request from another site answered ${foreign.status}`);
  const bare = await fetch(`${base}/api/me`, {
    headers: { 'X-Ccms-User': PEOPLE.admin },
  });
  if (bare.status !== 403)
    fail(`a request without an origin answered ${bare.status}`);
  // A page on another name pointed at this server (DNS rebinding) sends that name as Host and
  // Origin: fetch cannot set Host, so node:http does.
  const url = new URL(base);
  const hostStatus = await new Promise((done, reject) => {
    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        path: '/api/me',
        headers: {
          Host: 'rebound.example',
          Origin: 'http://rebound.example',
          'X-Ccms-User': PEOPLE.admin,
        },
      },
      (res) => {
        res.resume();
        done(res.statusCode);
      },
    );
    req.on('error', reject);
    req.end();
  });
  if (hostStatus !== 421)
    fail(`a request for another host answered ${hostStatus}`);
  say('refused: another site (403), no origin (403), another host (421)');

  // What a sandbox never takes: an upload.
  const { data: draft } = await post(PEOPLE.author, '/change-sets', {
    data: { type: 'ChangeSet', attributes: { title: 'An upload' } },
  });
  const form = new FormData();
  form.append(
    'file',
    new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }),
    'x.png',
  );
  const upload = await fetch(`${base}/api/change-sets/${draft.id}/assets`, {
    method: 'POST',
    headers: {
      Origin: base,
      'X-Ccms-User': PEOPLE.author,
      'X-Ccms-Request': '1',
    },
    body: form,
  });
  const refusal = await upload.json();
  if (
    upload.status !== 403 ||
    refusal.errors?.[0]?.code !== 'sandbox-not-allowed'
  )
    fail(
      `an upload answered ${upload.status}: ${JSON.stringify(refusal).slice(0, 300)}`,
    );
  say('refused: an upload (403 sandbox-not-allowed)');
}

async function edit() {
  const saves = Number(process.env.EDIT_SAVES ?? 30);
  const started = Date.now();
  const { data: change } = await post(PEOPLE.author, '/change-sets', {
    data: {
      type: 'ChangeSet',
      attributes: { title: 'Sandbox test: tyre pressures' },
    },
  });
  const path = await lockAndRead(PEOPLE.author, change.id, 'tyre-pressures');
  const saved = await save(PEOPLE.author, path, (content) =>
    withSuffix(content, '(checked)'),
  );
  const blockId = firstBlockId(saved.body.data.attributes.content);
  await post(
    PEOPLE.author,
    `/change-sets/${change.id}/commits`,
    undefined,
    [201],
  );
  await post(
    PEOPLE.author,
    `/change-sets/${change.id}/submit`,
    { meta: { comment: 'Ready.' } },
    [200],
  );
  say(`the author changed tyre-pressures (${lang}) and submitted it`);
  await post(
    PEOPLE.reviewer,
    `/change-sets/${change.id}/comments`,
    {
      data: {
        type: 'Comment',
        attributes: {
          body: 'Looks right.',
          subject: { type: 'module', lang, moduleId: 'tyre-pressures' },
          blockId,
        },
      },
    },
    [201],
  );
  await post(
    PEOPLE.reviewer,
    `/change-sets/${change.id}/approve`,
    undefined,
    [200],
  );
  say('the reviewer commented and approved it');
  await post(PEOPLE.admin, `/change-sets/${change.id}/merge`, undefined, [200]);
  const { data: merged } = await get(PEOPLE.admin, `/change-sets/${change.id}`);
  if (merged.attributes.state !== 'merged')
    fail(`the change set is ${merged.attributes.state}`);
  say('the admin merged it');

  // A visitor typing: the editor saves the working copy every few seconds.
  const { data: typing } = await post(PEOPLE.author, '/change-sets', {
    data: { type: 'ChangeSet', attributes: { title: 'Sandbox test: typing' } },
  });
  const draft = await lockAndRead(PEOPLE.author, typing.id, 'warning-triangle');
  for (let n = 1; n <= saves; n += 1)
    await save(PEOPLE.author, draft, (content) => withSuffix(content, `${n}`));
  await post(
    PEOPLE.author,
    `/change-sets/${typing.id}/commits`,
    undefined,
    [201],
  );
  say(
    `${saves} autosaves and a save point, in ${Math.round((Date.now() - started) / 100) / 10} s all told`,
  );
}

async function render() {
  const started = Date.now();
  const { data: release } = await post(
    PEOPLE.admin,
    '/releases',
    {
      data: {
        type: 'Release',
        attributes: {
          product: PRODUCT,
          revision: '1.2',
          notes: 'Cut by the sandbox test.',
        },
      },
    },
    [201],
  );
  let outputs;
  for (;;) {
    const { data } = await get(PEOPLE.admin, `/releases/${release.id}`);
    outputs = data.meta?.outputs ?? {};
    if (outputs.state === 'done') break;
    if (outputs.state === 'failed')
      fail(`the release's files failed: ${JSON.stringify(outputs)}`);
    if (Date.now() - started > 600_000)
      fail(`the release's files took too long: ${JSON.stringify(outputs)}`);
    await new Promise((done) => setTimeout(done, 500));
  }
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  const list = await get(
    PEOPLE.admin,
    `/releases/${release.id}/outputs?page[size]=100`,
  );
  const first = list.data.find(
    (o) => o.attributes.kind === 'pdf' && o.attributes.state === 'done',
  );
  if (!first) fail('no PDF is done');
  const pdfs = list.data.filter((o) => o.attributes.kind === 'pdf').length;
  const file = await fetch(
    `${base}/api/releases/${release.id}/outputs/${first.id}/file`,
    {
      headers: { Origin: base, 'X-Ccms-User': PEOPLE.reviewer },
    },
  );
  const bytes = new Uint8Array(await file.arrayBuffer());
  const magic = new TextDecoder().decode(bytes.subarray(0, 5));
  if (!file.ok || magic !== '%PDF-')
    fail(`the PDF answered ${file.status}, starting "${magic}"`);
  say(
    `release 1.2: ${pdfs} PDFs and ${list.data.length - pdfs} offline packages rendered in ${seconds} s; one downloaded as the reviewer (${bytes.length} bytes)`,
  );
}

const modes = { people, edit, render };
if (!modes[mode]) fail(`MODE must be one of ${Object.keys(modes).join(', ')}`);
await modes[mode]();
