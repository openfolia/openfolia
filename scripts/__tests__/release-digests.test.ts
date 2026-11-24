// @vitest-environment node
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { IMAGES } from '@/scripts/images-plan.mjs';
import {
  lockText,
  manifestDigest,
  overrideText,
  parseArgs,
  parseLock,
  pinnedServices,
  repoDigestLines,
  checkExpected,
} from '@/scripts/release-digests.mjs';

const root = join(import.meta.dirname, '..', '..');
const composeText = readFileSync(join(root, 'deploy', 'compose.yaml'), 'utf8');
const compose = parse(composeText, { merge: true });
const images = 'ghcr.io/openfolia/openfolia';
const tag = 'v1.2.3';
const digestOf = (image: string) =>
  `sha256:${String(IMAGES.indexOf(image) + 1).repeat(64)}`;
const digests = Object.fromEntries(
  IMAGES.map((image) => [image, digestOf(image)]),
);

describe('release-digests (#739)', () => {
  it("pins every service of compose.yaml that runs an OpenFolia image, the backup's anchor included", () => {
    expect(pinnedServices(compose)).toEqual([
      { service: 'api', image: 'api' },
      { service: 'worker', image: 'api' },
      { service: 'editor', image: 'editor' },
      { service: 'backup', image: 'backup' },
      { service: 'restore', image: 'backup' },
      { service: 'mcp', image: 'mcp' },
      { service: 'portal', image: 'portal' },
    ]);
  });

  it('refuses a service that names its image in another way, so none is left unpinned', () => {
    expect(() =>
      pinnedServices({
        services: {
          api: { image: '${OPENFOLIA_IMAGES}/api:${OPENFOLIA_VERSION}' },
        },
      }),
    ).toThrow(/the service api names its image/);
    expect(() =>
      pinnedServices({ services: { db: { image: 'postgres:18' } } }),
    ).toThrow(/runs no OpenFolia image/);
  });

  it('writes the override: each service by tag and digest, loadable as Compose YAML', () => {
    const services = pinnedServices(compose);
    const text = overrideText({ images, tag, digests, services });
    expect(parse(text)).toEqual({
      services: Object.fromEntries(
        services.map(({ service, image }) => [
          service,
          { image: `${images}/${image}:${tag}@${digestOf(image)}` },
        ]),
      ),
    });
    expect(text).toMatch(/^# OpenFolia v1\.2\.3: /);
    // The same digests always make the same file, so the docs' SHA-256 matches the release's.
    expect(overrideText({ images, tag, digests, services })).toBe(text);
    expect(() =>
      overrideText({ images, tag, digests: { api: digests.api }, services }),
    ).toThrow(/no digest for editor/);
  });

  it('writes images.lock for every image and reads it back, checked against its repository and tag', () => {
    const lock = lockText({ images, tag, digests });
    expect(lock.trim().split('\n')).toEqual(
      IMAGES.map((image) => `${images}/${image}:${tag}@${digestOf(image)}`),
    );
    expect(parseLock(lock, { images, tag })).toEqual(digests);
    expect(parseLock(lock.replace(/\n/g, ' '), { images, tag })).toEqual(
      digests,
    );
    expect(() => parseLock(lock, { images, tag: 'v1.2.4' })).toThrow(
      /no image of/,
    );
    expect(() =>
      parseLock(lock, { images: 'ghcr.io/other/openfolia', tag }),
    ).toThrow(/no image of/);
    // A dot in the repository is a dot, not any character.
    expect(() =>
      parseLock(lock.replace(/ghcr\.io/g, 'ghcrxio'), { images, tag }),
    ).toThrow(/no image of/);
    const api = `${images}/api:${tag}@${digests.api}`;
    expect(() => parseLock(`${api}\n${api}`, { images, tag })).toThrow(
      /named twice/,
    );
    expect(() =>
      parseLock(`${images}/other:${tag}@${digests.api}`, { images, tag }),
    ).toThrow(/names no image of a release/);
    expect(() => lockText({ images, tag, digests: {} })).toThrow(
      /no digest for api/,
    );
  });

  it("names what step 7 compares: the repository's digest of each service's image", () => {
    expect(
      repoDigestLines({
        images,
        tag,
        digests,
        services: [
          { service: 'api', image: 'api' },
          { service: 'worker', image: 'api' },
        ],
      }),
    ).toBe(
      `api ${images}/api@${digests.api} ${images}/api:${tag}@${digests.api}\n` +
        `worker ${images}/api@${digests.api} ${images}/api:${tag}@${digests.api}`,
    );
  });

  it('records only the digests the build pushed: a tag moved since the push throws', () => {
    const pushed = IMAGES.map((image) => `${image} ${digestOf(image)}`).join(
      '\n',
    );
    expect(() => checkExpected(digests, pushed + '\n')).not.toThrow();
    expect(() =>
      checkExpected({ ...digests, mcp: `sha256:${'f'.repeat(64)}` }, pushed),
    ).toThrow(/for mcp, the build pushed .*: the tag moved/);
    expect(() =>
      checkExpected(digests, pushed.split('\n').slice(1).join('\n')),
    ).toThrow(/recorded no digest for api/);
    for (const extra of [
      'other sha256:' + 'a'.repeat(64),
      'api sha256:abc',
      `api ${digests.api}`,
      `api ${digests.api} more`,
    ])
      expect(() => checkExpected(digests, `${pushed}\n${extra}`)).toThrow(
        /release-digests/,
      );
  });

  it("reads the digest from imagetools' manifest, and nothing else", () => {
    const digest = digestOf('mcp');
    expect(
      manifestDigest(
        JSON.stringify({ mediaType: 'x', digest, size: 1 }),
        'ref',
      ),
    ).toBe(digest);
    for (const output of [
      '',
      'not json',
      '{}',
      JSON.stringify({ digest: 'sha256:abc' }),
      JSON.stringify({ digest: `sha512:${'a'.repeat(64)}` }),
    ])
      expect(() => manifestDigest(output, 'the/ref')).toThrow(
        'no digest for the/ref',
      );
  });

  it('takes only the arguments it knows, each checked', () => {
    expect(
      parseArgs(['--images', images, '--tag', tag, '--out', 'dir']),
    ).toEqual({
      images,
      tag,
      out: 'dir',
      compose: 'deploy/compose.yaml',
      expect: null,
    });
    for (const argv of [
      ['--images', `${images}:v1`, '--tag', tag, '--out', 'd'],
      ['--images', images, '--tag', 'latest', '--out', 'd'],
      ['--images', images, '--tag', tag],
      ['--images', images, '--tag', tag, '--out'],
      ['--images', images, '--tag', tag, '--out', '--force'],
      ['--images', images, '--tag', tag, '--out', 'd', '--push', 'x'],
      ['images', images],
    ])
      expect(() => parseArgs(argv)).toThrow(/release-digests/);
  });
});

describe('release-digests, run as the workflow runs it', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  /** A `docker` that answers `buildx imagetools inspect <ref>` from a table, and logs its calls. */
  const fakeDocker = (answers: Record<string, string>) => {
    dir = mkdtempSync(join(tmpdir(), 'release-digests-'));
    const docker = join(dir, 'docker');
    writeFileSync(
      docker,
      `#!/bin/sh\necho "$*" >> "${dir}/calls"\ncase "$4" in\n${Object.entries(
        answers,
      )
        .map(([ref, out]) => `  '${ref}') echo '${out}' ;;\n`)
        .join('')}  *) echo "no such image $4" >&2; exit 1 ;;\nesac\n`,
    );
    chmodSync(docker, 0o755);
    return dir;
  };
  const run = (bin: string, out: string) =>
    execFileSync(
      process.execPath,
      [
        join(root, 'scripts', 'release-digests.mjs'),
        '--images',
        images,
        '--tag',
        tag,
        '--out',
        out,
        '--compose',
        join(root, 'deploy', 'compose.yaml'),
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

  it('reads each image of the tag once, and writes images.lock and the override', () => {
    const bin = fakeDocker(
      Object.fromEntries(
        IMAGES.map((image) => [
          `${images}/${image}:${tag}`,
          JSON.stringify({ digest: digestOf(image) }),
        ]),
      ),
    );
    const out = join(bin, 'out');
    const printed = run(bin, out);
    const lock = readFileSync(join(out, 'images.lock'), 'utf8');
    expect(printed).toBe(lock);
    expect(lock).toBe(lockText({ images, tag, digests }));
    expect(readFileSync(join(out, 'compose.digests.yaml'), 'utf8')).toBe(
      overrideText({ images, tag, digests, services: pinnedServices(compose) }),
    );
    expect(readFileSync(join(bin, 'calls'), 'utf8').trim().split('\n')).toEqual(
      IMAGES.map(
        (image) =>
          `buildx imagetools inspect ${images}/${image}:${tag} --format {{json .Manifest}}`,
      ),
    );
  });

  it('fails, and writes nothing, when an image of the tag is missing', () => {
    const bin = fakeDocker({
      [`${images}/api:${tag}`]: JSON.stringify({ digest: digestOf('api') }),
    });
    const out = join(bin, 'out');
    expect(() => run(bin, out)).toThrow();
    expect(() => readFileSync(join(out, 'images.lock'))).toThrow();
  });
});

describe('the workflows (#739)', () => {
  const workflow = (name: string) =>
    parse(readFileSync(join(root, '.github', 'workflows', name), 'utf8'));

  it('records the digests once every image of a release tag is pushed, and attaches the files once', () => {
    const images = workflow('images.yml');
    const job = images.jobs['release-files'];
    expect(job.needs).toEqual(['plan', 'build']);
    expect(job.if).toContain("github.ref_type == 'tag'");
    const run = job.steps.map((s: { run?: string }) => s.run ?? '').join('\n');
    // The repository the build job pushes to, lowercased as the metadata action does.
    expect(
      images.jobs.build.steps.find((s: { id?: string }) => s.id === 'meta').with
        .images,
    ).toBe(
      '${{ env.REGISTRY }}/${{ github.repository_owner }}/openfolia/${{ matrix.image }}',
    );
    expect(run).toContain(
      'node scripts/release-digests.mjs --images "$REGISTRY/${OWNER,,}/openfolia" --tag "$TAG"',
    );
    expect(run).toContain(
      'sha256sum compose.yaml compose.digests.yaml images.lock > SHA256SUMS',
    );
    expect(run).toContain('--expect "$RUNNER_TEMP/pushed.txt"');
    // The job that runs the repository's code holds no token that can change the release.
    expect(job.permissions).toEqual({ contents: 'read', packages: 'read' });
    // The one that can runs none of it: no checkout, no install, only gh.
    const upload = images.jobs['release-upload'];
    expect(upload.permissions).toEqual({ contents: 'write' });
    expect(JSON.stringify(upload.steps)).not.toMatch(/checkout|pnpm|node /);
    expect(upload.steps.at(-1).run).toMatch(
      /gh release upload "\$TAG"[^\n]*--clobber/,
    );
    // Each build leg records the digest it pushed, for --expect.
    expect(JSON.stringify(images.jobs.build.steps)).toContain(
      'steps.push.outputs.digest',
    );
    // Only this job writes SHA256SUMS: release.yml no longer uploads one that could replace it.
    expect(JSON.stringify(workflow('release.yml'))).not.toContain('SHA256SUMS');
    expect(images.jobs.digests.steps.at(-1).run).toBe('deploy/digests-test.sh');
  });
});
