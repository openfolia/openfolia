import { withFixtureApi } from './fixture-api.ts';

/**
 * The fixture API (`fixture-api.ts`) as a process of its own: prints `{ url, tokens, releases }`
 * as one JSON line once it listens, and stops when its standard input closes. For tests whose
 * runner cannot host the API in its own process (a Vitest worker aborts on it).
 */
await withFixtureApi(async (api) => {
  process.stdout.write(
    `${JSON.stringify({ url: api.url.href, tokens: api.tokens, releases: api.releases })}\n`,
  );
  process.stdin.resume();
  await new Promise<void>((done) =>
    process.stdin.once('end', done).once('close', done),
  );
});
process.exit(0);
