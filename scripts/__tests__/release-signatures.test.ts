// @vitest-environment node
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
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
import { pinnedServices } from '@/scripts/release-digests.mjs';
import {
  bundleName,
  GITHUB_ACTIONS_ISSUER,
  githubSignerIdentity,
  parseSignatureSums,
  SIGNATURE_PREDICATE,
  signedImageLines,
  TRUSTED_ROOT,
} from '@/scripts/release-signatures.mjs';

const root = join(import.meta.dirname, '..', '..');
const compose = parse(
  readFileSync(join(root, 'deploy', 'compose.yaml'), 'utf8'),
  { merge: true },
);
const hex = (digit: number) => String(digit).repeat(64);
/** A release's signatures.sha256, as `sha256sum` writes it. */
const sums = [
  `${hex(9)}  ${TRUSTED_ROOT}`,
  ...IMAGES.map((image, i) => `${hex(i + 1)}  ${bundleName(image)}`),
].join('\n');

describe('release-signatures (#745)', () => {
  it("reads a release's signatures.sha256: the trust root and a bundle for every image", () => {
    expect(parseSignatureSums(sums)).toEqual({
      trustedRoot: hex(9),
      bundles: Object.fromEntries(
        IMAGES.map((image, i) => [image, hex(i + 1)]),
      ),
    });
    // The same in one line (an environment variable), and sha256sum's binary mark.
    expect(
      parseSignatureSums(sums.replace(/\n/g, ' ').replace('  api', ' *api'))
        .bundles.api,
    ).toBe(hex(1));
  });

  it('refuses one that misses a file, names another or one twice, or holds no SHA-256', () => {
    const lines = sums.split('\n');
    for (const [text, error] of [
      [lines.slice(1).join('\n'), /no SHA-256 for trusted_root.json/],
      [
        lines.filter((l) => !l.includes('mcp')).join('\n'),
        /no SHA-256 for mcp.sigstore.json/,
      ],
      [`${sums}\n${hex(7)}  compose.yaml`, /"compose.yaml" is no file/],
      [`${sums}\n${hex(7)}  api.sigstore.json`, /named twice/],
      [sums.replace(hex(9), 'abc'), /"abc" is no SHA-256/],
      [`${sums}\n${hex(7)}`, /a SHA-256 and a file name/],
      [`${sums}\n${hex(7)}  ../api.sigstore.json`, /is no file/],
    ] as const)
      expect(() => parseSignatureSums(text)).toThrow(error);
  });

  it('names the identity of the release workflow on GitHub, and none elsewhere', () => {
    expect(
      githubSignerIdentity('https://github.com/Some-Fork/openfolia', 'v1.2.3'),
    ).toBe(
      'https://github.com/Some-Fork/openfolia/.github/workflows/images.yml@refs/tags/v1.2.3',
    );
    expect(
      githubSignerIdentity('https://git.example.com/a/b', 'v1.2.3'),
    ).toBeNull();
    expect(
      githubSignerIdentity('https://github.com/a/b/tree/main', 'v1.2.3'),
    ).toBeNull();
    expect(GITHUB_ACTIONS_ISSUER).toBe(
      'https://token.actions.githubusercontent.com',
    );
  });

  it('lists each image compose.yaml runs once, with the hex of its digest', () => {
    const digests = Object.fromEntries(
      IMAGES.map((image, i) => [image, `sha256:${hex(i + 1)}`]),
    );
    expect(
      signedImageLines({ digests, services: pinnedServices(compose) }),
    ).toBe(
      [
        `api ${hex(IMAGES.indexOf('api') + 1)}`,
        `editor ${hex(IMAGES.indexOf('editor') + 1)}`,
        `backup ${hex(IMAGES.indexOf('backup') + 1)}`,
        `mcp ${hex(IMAGES.indexOf('mcp') + 1)}`,
        `portal ${hex(IMAGES.indexOf('portal') + 1)}`,
      ].join('\n'),
    );
    expect(() =>
      signedImageLines({ digests: {}, services: pinnedServices(compose) }),
    ).toThrow(/no digest for api/);
  });
});

describe('the images workflow signs, only when SIGN_IMAGES is on (#745)', () => {
  const images = parse(
    readFileSync(join(root, '.github', 'workflows', 'images.yml'), 'utf8'),
  );
  const sign = images.jobs['release-sign'];
  const upload = images.jobs['release-upload'];
  const run = (job: { steps: { run?: string }[] }) =>
    job.steps.map((s) => s.run ?? '').join('\n');

  it('signs only with the variable set to true, after the release files, by digest, keyless', () => {
    expect(sign.needs).toBe('release-files');
    expect(sign.if).toBe(
      "needs.release-files.outputs.release == 'true' && vars.SIGN_IMAGES == 'true'",
    );
    expect(sign.permissions).toEqual({
      contents: 'read',
      packages: 'read',
      'id-token': 'write',
    });
    const script = run(sign);
    expect(script).toContain(
      'cosign sign --yes --upload=false --bundle "$OUT/$image.sigstore.json" "$repository/$image@$digest"',
    );
    // Each bundle verified right away, offline, as the install guide does.
    expect(script).toMatch(
      /cosign verify-blob-attestation --bundle "\$OUT\/\$image\.sigstore\.json" \\\n\s+--trusted-root "\$OUT\/trusted_root\.json"/,
    );
    expect(script).toContain(`--type ${SIGNATURE_PREDICATE}`);
    expect(script).toContain(
      `--certificate-oidc-issuer ${GITHUB_ACTIONS_ISSUER}`,
    );
    expect(script).toContain(
      '"$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/.github/workflows/images.yml@refs/tags/$TAG"',
    );
    expect(script).toContain(
      'sha256sum trusted_root.json *.sigstore.json >signatures.sha256',
    );
    // cosign pinned by its checksum; no code of the repository where the OIDC token is.
    expect(script).toContain(
      'echo "$COSIGN_SHA256  $RUNNER_TEMP/bin/cosign" | sha256sum -c -',
    );
    expect(sign.env.COSIGN_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(sign.steps)).not.toMatch(
      /actions\/checkout|pnpm|node |npx/,
    );
  });

  it('is the only job with an OIDC token', () => {
    for (const [name, job] of Object.entries(images.jobs) as [
      string,
      { permissions?: Record<string, string> },
    ][])
      if (name !== 'release-sign')
        expect(job.permissions?.['id-token']).toBeUndefined();
    expect(images.permissions).toEqual({ contents: 'read' });
  });

  it('attaches the same files as before with signing off, and nothing when signing failed', () => {
    expect(upload.needs).toEqual(['release-files', 'release-sign']);
    const condition = upload.if.replace(/\s+/g, ' ');
    expect(condition).toContain('!cancelled()');
    expect(condition).toContain(
      "!cancelled() && needs.release-files.result == 'success' && needs.release-files.outputs.release == 'true'",
    );
    expect(condition).toContain(
      "(needs.release-sign.result == 'success' || (needs.release-sign.result == 'skipped' && vars.SIGN_IMAGES != 'true'))",
    );
    const script = upload.steps.at(-1).run;
    expect(script).toContain(
      'files=("$FILES/compose.yaml" "$FILES/compose.digests.yaml" "$FILES/images.lock" "$FILES/SHA256SUMS")',
    );
    expect(script).toContain(
      'if [ "$SIGNED" = true ]; then\n  files+=("$SIGNATURES/signatures.sha256" "$SIGNATURES/trusted_root.json" "$SIGNATURES"/*.sigstore.json)\nfi\n',
    );
    expect(upload.steps.at(-1).env.SIGNED).toBe(
      "${{ needs.release-sign.result == 'success' }}",
    );
    // The upload, run with signing off: exactly the four files of #739.
    const calls = execFileSync(
      'bash',
      [
        '-c',
        `gh() { [ "$1" = release ] && [ "$2" = view ] && return 0; printf '%s\\n' "$@"; }\n${script}`,
      ],
      {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          TAG: 'v1.2.3',
          FILES: '/f',
          SIGNATURES: '/s',
          SIGNED: 'false',
          GITHUB_REPOSITORY: 'o/r',
        },
      },
    );
    expect(calls.trim().split('\n')).toEqual([
      'release',
      'upload',
      'v1.2.3',
      '--repo',
      'o/r',
      '--clobber',
      '/f/compose.yaml',
      '/f/compose.digests.yaml',
      '/f/images.lock',
      '/f/SHA256SUMS',
    ]);
  });

  it("runs the install guide's signature check in CI (deploy/signatures-test.sh)", () => {
    const steps = JSON.stringify(images.jobs.digests.steps);
    expect(steps).toContain('deploy/signatures-test.sh');
  });
});

describe("release-sign's step, run with stand-ins for cosign, gh and docker (#745)", () => {
  const images = parse(
    readFileSync(join(root, '.github', 'workflows', 'images.yml'), 'utf8'),
  );
  const step = images.jobs['release-sign'].steps.find((s: { name?: string }) =>
    s.name?.startsWith('sign each image'),
  );
  const repository = 'ghcr.io/some-owner/openfolia';
  const tag = 'v1.2.3';
  const digestOf = (image: string) =>
    `sha256:${String(IMAGES.indexOf(image) + 1).repeat(64)}`;
  const lock = IMAGES.map(
    (image) => `${repository}/${image}:${tag}@${digestOf(image)}`,
  );

  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  /**
   * What `imagetools inspect --format '{{json .Manifest}}'` prints for a digest: an index of an
   * image per architecture and its attestation (#827); `amd64-only:<digest>`, an index of one.
   */
  const inspected = (value: string) => {
    const [digest, platforms] = value.startsWith('amd64-only:')
      ? [value.slice('amd64-only:'.length), ['amd64']]
      : [value, ['amd64', 'arm64']];
    return JSON.stringify({
      mediaType: 'application/vnd.oci.image.index.v1+json',
      digest,
      manifests: platforms.flatMap((architecture) => [
        {
          digest: `sha256:${'a'.repeat(64)}`,
          platform: { os: 'linux', architecture },
        },
        {
          digest: `sha256:${'b'.repeat(64)}`,
          platform: { os: 'unknown', architecture: 'unknown' },
          annotations: { 'vnd.docker.reference.type': 'attestation-manifest' },
        },
      ]),
    });
  };

  /** Runs the step on these images.lock lines; the registry names `registry`'s digests. */
  const runStep = (
    lines: string[],
    registry: Record<string, string> = Object.fromEntries(
      IMAGES.map((image) => [image, digestOf(image)]),
    ),
  ) => {
    dir = mkdtempSync(join(tmpdir(), 'release-sign-'));
    const bin = join(dir, 'bin');
    for (const sub of ['bin', 'files', 'pushed', 'out', 'tmp'])
      mkdirSync(join(dir, sub));
    writeFileSync(join(dir, 'files', 'images.lock'), `${lines.join('\n')}\n`);
    // What the build legs recorded: always the release's own digests.
    for (const image of IMAGES)
      writeFileSync(
        join(dir, 'pushed', image),
        `${image} ${digestOf(image)}\n`,
      );
    const stub = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    stub(
      'cosign',
      `echo "$*" >> "${dir}/cosign.log"
if [ "$1" = sign ]; then echo bundle > "$5"; fi`,
    );
    stub(
      'gh',
      `echo '{"certificateAuthorities":[{"uri":"https://fulcio.sigstore.dev"}]}'
echo '{"certificateAuthorities":[{"uri":"fulcio.githubapp.com"}]}'`,
    );
    stub(
      'docker',
      `[ "$2" = version ] && exit 0\ncase "$4" in\n${Object.entries(registry)
        .map(
          ([image, digest]) =>
            `  '${repository}/${image}:${tag}') echo '${inspected(digest)}' ;;`,
        )
        .join('\n')}\n  *) exit 1 ;;\nesac`,
    );
    stub(
      'sha256sum',
      'if command -v shasum >/dev/null; then exec shasum -a 256 "$@"; fi; exec /usr/bin/sha256sum "$@"',
    );
    try {
      execFileSync('bash', ['-e', '-c', step.run], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          REGISTRY: 'ghcr.io',
          OWNER: 'Some-Owner',
          TAG: tag,
          FILES: join(dir, 'files'),
          PUSHED: join(dir, 'pushed'),
          OUT: join(dir, 'out'),
          RUNNER_TEMP: join(dir, 'tmp'),
          GITHUB_STEP_SUMMARY: join(dir, 'summary'),
          GITHUB_SERVER_URL: 'https://github.com',
          GITHUB_REPOSITORY: 'Some-Owner/openfolia',
          GITHUB_WORKFLOW_REF: `Some-Owner/openfolia/.github/workflows/images.yml@refs/tags/${tag}`,
        },
      });
      return { ok: true, error: '', cosign: readCalls() };
    } catch (error) {
      return {
        ok: false,
        error: String((error as { stdout?: string }).stdout ?? error),
        cosign: readCalls(),
      };
    }
  };
  const readCalls = () => {
    try {
      return readFileSync(join(dir!, 'cosign.log'), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean);
    } catch {
      return [];
    }
  };

  it('signs every image of images.lock by the digest the build pushed and the registry names', () => {
    const run = runStep(lock);
    expect(run.error).toBe('');
    expect(run.ok).toBe(true);
    const signs = run.cosign.filter((call) => call.startsWith('sign '));
    expect(signs).toEqual(
      IMAGES.map(
        (image) =>
          `sign --yes --upload=false --bundle ${dir}/out/${image}.sigstore.json ${repository}/${image}@${digestOf(image)}`,
      ),
    );
    expect(
      run.cosign.filter((call) => call.startsWith('verify-blob-attestation ')),
    ).toHaveLength(IMAGES.length);
    const sums = readFileSync(join(dir!, 'out', 'signatures.sha256'), 'utf8');
    expect(parseSignatureSums(sums).bundles.mcp).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(join(dir!, 'out', 'trusted_root.json'), 'utf8')).toBe(
      '{"certificateAuthorities":[{"uri":"https://fulcio.sigstore.dev"}]}\n',
    );
  });

  it('refuses a tampered images.lock, and signs nothing', () => {
    const other = `sha256:${'f'.repeat(64)}`;
    const replace = (index: number, line: string) =>
      lock.map((l, i) => (i === index ? line : l));
    for (const [lines, registry, error] of [
      // Another repository, though with a digest of its own the registry would answer.
      [
        replace(
          0,
          `ghcr.io/someone-else/openfolia/api:${tag}@${digestOf('api')}`,
        ),
        undefined,
        /not this release's repository/,
      ],
      // A digest the build never pushed, which the registry names too (the tag moved).
      [
        replace(0, `${repository}/api:${tag}@${other}`),
        {
          ...Object.fromEntries(IMAGES.map((i) => [i, digestOf(i)])),
          api: other,
        },
        /not the digest the build pushed for api/,
      ],
      // The build's digest, but the registry names another for the tag now.
      [
        lock,
        {
          ...Object.fromEntries(IMAGES.map((i) => [i, digestOf(i)])),
          mcp: other,
        },
        /the registry names .* for mcp/,
      ],
      // The build's digest, the registry's too, but an image of one architecture alone.
      [
        lock,
        {
          ...Object.fromEntries(IMAGES.map((i) => [i, digestOf(i)])),
          sandbox: `amd64-only:${digestOf('sandbox')}`,
        },
        /sandbox:v1.2.3 is no index of linux\/amd64 and linux\/arm64/,
      ],
      [
        replace(0, `${repository}/evil:${tag}@${digestOf('api')}`),
        undefined,
        /not an image of the release/,
      ],
      [
        replace(0, `${repository}/api:v9.9.9@${digestOf('api')}`),
        undefined,
        /not the tag v1.2.3/,
      ],
      [lock.slice(1), undefined, /images.lock names no api/],
      [[...lock, lock[0]!], undefined, /api is named twice/],
      [
        replace(0, `${repository}/api@${digestOf('api')}`),
        undefined,
        /no image pinned by its digest/,
      ],
    ] as const) {
      const run = runStep([...lines], registry && { ...registry });
      expect(run.ok).toBe(false);
      expect(run.error).toMatch(error);
      expect(run.cosign).toEqual([]);
    }
  });
});
