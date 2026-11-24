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
  PLATFORMS,
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

/**
 * What `imagetools inspect --format '{{json .Manifest}}'` prints for an index the workflow's merge
 * job made (#827): an image per platform and, for each, its attestation manifest (buildx's SBOM
 * and provenance), whose platform is `unknown/unknown`.
 */
const indexOf = (
  digest: string,
  platforms: readonly string[] = PLATFORMS,
  mediaType = 'application/vnd.oci.image.index.v1+json',
) => {
  const manifests = platforms.flatMap((platform, n) => {
    const [os, architecture] = platform.split('/');
    const image = `sha256:${String(n + 1).repeat(64)}`;
    return [
      {
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        digest: image,
        size: 1000,
        platform: { architecture, os },
      },
      {
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        digest: `sha256:${String(n + 5).repeat(64)}`,
        size: 800,
        annotations: {
          'vnd.docker.reference.digest': image,
          'vnd.docker.reference.type': 'attestation-manifest',
        },
        platform: { architecture: 'unknown', os: 'unknown' },
      },
    ];
  });
  return JSON.stringify({
    schemaVersion: 2,
    mediaType,
    digest,
    size: 1600,
    manifests,
  });
};

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

  it("reads the index's digest from imagetools' manifest, and nothing else", () => {
    const digest = digestOf('mcp');
    expect(PLATFORMS).toEqual(['linux/amd64', 'linux/arm64']);
    expect(manifestDigest(indexOf(digest), 'ref')).toBe(digest);
    // Docker's manifest list is an index too, and an arm64 image of a variant counts as arm64.
    expect(
      manifestDigest(
        indexOf(
          digest,
          PLATFORMS,
          'application/vnd.docker.distribution.manifest.list.v2+json',
        ),
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

  it('refuses a single image and an index without every platform: a release runs on both (#827)', () => {
    const digest = digestOf('api');
    // One platform's image, as the workflow pushed them before #827.
    expect(() =>
      manifestDigest(
        JSON.stringify({
          schemaVersion: 2,
          mediaType: 'application/vnd.oci.image.manifest.v1+json',
          digest,
          size: 1000,
        }),
        'the/ref',
      ),
    ).toThrow('the/ref is no multi-platform image index');
    expect(() =>
      manifestDigest(
        JSON.stringify({
          mediaType: 'application/vnd.oci.image.index.v1+json',
          digest,
        }),
        'the/ref',
      ),
    ).toThrow('no multi-platform image index');
    expect(() =>
      manifestDigest(indexOf(digest, ['linux/amd64']), 'the/ref'),
    ).toThrow('the/ref has no image for linux/arm64');
    expect(() =>
      manifestDigest(indexOf(digest, ['linux/arm64', 'linux/ppc64le']), 'r'),
    ).toThrow('r has no image for linux/amd64');
    // An attestation that names linux/amd64 as its platform is still no image.
    const forged = JSON.parse(indexOf(digest, ['linux/arm64']));
    forged.manifests[1].platform = { os: 'linux', architecture: 'amd64' };
    expect(() => manifestDigest(JSON.stringify(forged), 'r')).toThrow(
      'r has no image for linux/amd64',
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
          indexOf(digestOf(image)),
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
      [`${images}/api:${tag}`]: indexOf(digestOf('api')),
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
    expect(job.needs).toEqual(['plan', 'merge']);
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
    // Each build leg records the digest it pushed for the merge, and the merge the index's, for
    // --expect.
    expect(JSON.stringify(images.jobs.build.steps)).toContain(
      'steps.push.outputs.digest',
    );
    expect(JSON.stringify(images.jobs.merge.steps)).toContain(
      'steps.index.outputs.digest',
    );
    // Only this job writes SHA256SUMS: release.yml no longer uploads one that could replace it.
    expect(JSON.stringify(workflow('release.yml'))).not.toContain('SHA256SUMS');
    expect(images.jobs.digests.steps.at(-1).run).toBe('deploy/digests-test.sh');
  });
});

describe('the images for both architectures (#827)', () => {
  const images = parse(
    readFileSync(join(root, '.github', 'workflows', 'images.yml'), 'utf8'),
  );
  type Step = {
    id?: string;
    uses?: string;
    run?: string;
    with?: Record<string, string>;
  };

  it('builds every image natively on a runner of each architecture, and pushes each by digest', () => {
    const build = images.jobs.build;
    expect(build['runs-on']).toBe('${{ matrix.runner }}');
    expect(build.strategy.matrix.arch).toEqual(['amd64', 'arm64']);
    expect(build.strategy.matrix.include).toEqual([
      { arch: 'amd64', runner: 'ubuntu-24.04' },
      { arch: 'arm64', runner: 'ubuntu-24.04-arm' },
    ]);
    const builds = build.steps.filter((s: Step) =>
      s.uses?.startsWith('docker/build-push-action'),
    );
    expect(builds).toHaveLength(2);
    for (const step of builds)
      expect(step.with.platforms).toBe('linux/${{ matrix.arch }}');
    const push = build.steps.find((s: Step) => s.id === 'push');
    expect(push.with.outputs).toContain('push-by-digest=true');
    expect(push.with.tags).toBeUndefined();
    expect(push.with.sbom).toBe(true);
    expect(push.with.provenance).toBe('mode=max');
  });

  it('tags one index of both, checked, and the release pins and signs that index', () => {
    const merge = images.jobs.merge;
    expect(merge.needs).toEqual(['plan', 'build']);
    const index = merge.steps.find((s: Step) => s.id === 'index').run;
    expect(index).toContain(
      'docker buildx imagetools create "${tags[@]}" "${sources[@]}"',
    );
    expect(index).toContain('for arch in amd64 arm64');
    expect(index).toContain(
      '(index("linux/amd64") != null) and (index("linux/arm64") != null)',
    );
    expect(images.jobs.retag.needs).toEqual(['plan', 'merge']);
    expect(images.jobs.deploy.needs).toContain('merge');
    // Signing takes every image of a release, the sandbox too, each an index of both.
    const sign = images.jobs['release-sign'].steps
      .map((s: Step) => s.run ?? '')
      .join('\n');
    const named = /release_images="([^"]+)"/.exec(sign)?.[1]?.split(' ');
    expect(named).toEqual([...IMAGES]);
    expect(sign).toContain('is no index of linux/amd64 and linux/arm64');
  });

  it('runs the compose smoke test on both architectures, and the sandbox test on each leg', () => {
    expect(images.jobs.smoke['runs-on']).toBe('${{ matrix.runner }}');
    expect(images.jobs.smoke.strategy.matrix.include).toEqual([
      { arch: 'amd64', runner: 'ubuntu-24.04' },
      { arch: 'arm64', runner: 'ubuntu-24.04-arm' },
    ]);
    const test = images.jobs.build.steps.find(
      (s: Step) => s.run === 'deploy/sandbox-test.sh',
    );
    expect(test.if).toBe("matrix.image == 'sandbox'");
  });
});
