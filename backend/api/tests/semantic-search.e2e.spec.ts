import { sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { Actor } from '../src/access/core/actor.js';
import { SearchIndexSweeper } from '../src/search/api/search-index-sweeper.js';
import { SearchPageDocument } from '../src/search/api/search.resources.js';
import { CONCEPTS } from './fakes/concept-embedder.js';
import { actorWith, READER } from './fakes/actors.js';
import {
  embeddingServer,
  type EmbeddingServer,
} from './fakes/embedding-server.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * `GET /search` with an embedder configured (#54): the app's own
 * `HttpEmbedder` against a local endpoint answering concept vectors
 * (`tests/fakes/concept-embedder.ts`), the `search.embed` job, pgvector
 * on PGlite. The sample's `en/charging` (keywords "maintenance",
 * "battery") is about batteries; nothing in it says "cells".
 */
let server: EmbeddingServer;
let t: TestApp;
beforeAll(async () => {
  server = await embeddingServer();
  t = await createTestApp({
    CCMS_EMBEDDER_URL: server.url,
    CCMS_EMBEDDER_MODEL: 'concepts',
    CCMS_EMBEDDER_DIMENSIONS: String(CONCEPTS.length + 1),
  });
});
afterAll(async () => {
  await t?.close();
  await server?.close();
});
afterEach(() => t?.actAs(undefined));

type Page = z.infer<typeof SearchPageDocument>;

async function found(actor: Actor, query: string): Promise<Page> {
  t.actAs(actor);
  const res = await t.get(`/search?filter[q]=${encodeURIComponent(query)}`);
  expect(res.status).toBe(200);
  return SearchPageDocument.parse(res.body);
}

describe('semantic search', () => {
  it('finds a paraphrase by meaning once the job embedded the text, and says so', async () => {
    // The first search indexes the commit, embeds the query (the text is
    // not embedded yet) and asks for the embedding job.
    const before = await found(READER, 'cells');
    expect(before.data.map((hit) => hit.meta.matchedOn)).not.toContain(
      'meaning',
    );
    const inputs = () =>
      server.received.map(
        (r) => (JSON.parse(r.body) as { input: string[] }).input,
      );
    expect(inputs()).toEqual([['cells']]);
    expect(await t.runJobs()).toBeGreaterThan(0);
    // The job sent the indexed text: titles, keywords and blocks.
    expect(inputs().slice(1).flat()).toContainEqual(
      expect.stringContaining('Charging\nmaintenance, battery'),
    );
    const sent = server.received.length;
    const after = await found(READER, 'cells');
    const charging = after.data.find(
      (hit) => hit.attributes.resourceId === 'en/charging',
    );
    expect(charging?.meta).toMatchObject({ matchedOn: 'meaning', matches: [] });
    expect(after.meta.page.total).toBe(after.data.length);
    // The query's vector is kept: nothing more was sent.
    expect(server.received.length).toBe(sent);
  });

  it('never finds by meaning what the reader may not see', async () => {
    await t.runJobs();
    const publicOnly: Actor = {
      ...actorWith(['content.read'], { maxAudience: 'public' }),
      id: 'public-only',
    };
    // `en/internals` (internal) has the keyword "internal wiring": a cable.
    const wide = await found(READER, 'wire harness');
    expect(wide.data.map((hit) => hit.attributes.resourceId)).toContain(
      'en/internals',
    );
    await t.runJobs();
    const narrow = await found(publicOnly, 'wire harness');
    expect(narrow.data.map((hit) => hit.attributes.resourceId)).not.toContain(
      'en/internals',
    );
    expect(JSON.stringify(narrow)).not.toMatch(/internals|Internal/);
    expect(narrow.meta.page.total).toBe(narrow.data.length);
  });

  it('searches by words alone while the embedder is down', async () => {
    server.handle = (_req, res) => {
      res.statusCode = 503;
      res.end();
    };
    try {
      const page = await found(READER, 'automatically');
      expect(page.data.map((hit) => hit.attributes.resourceId)).toContain(
        'en/charging',
      );
    } finally {
      const { conceptAnswer } = await import('./fakes/embedding-server.js');
      server.handle = conceptAnswer;
    }
  });
});

describe('the search index sweep (#540)', () => {
  it('runs on the Postgres index, keeps what is in its grace period, and records the model in use', async () => {
    await found(READER, 'battery');
    await t.runJobs();
    const report = await t.app.get(SearchIndexSweeper).runOnce();
    expect(report).toMatchObject({
      scopes: 0,
      documents: 0,
      texts: 0,
      modelEmbeddings: 0,
      complete: true,
    });
    const { rows } = await t.database.db.execute<{ model: string }>(
      sql`select model from search_embedding_models`,
    );
    expect(rows.map((row) => row.model)).toEqual([
      `concepts@${CONCEPTS.length + 1}`,
    ]);
  });
});
