// @vitest-environment node
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import {
  IMAGES,
  outputLines,
  parseArgs,
  planImages,
} from '@/scripts/images-plan.mjs';

const root = join(import.meta.dirname, '..', '..');
const never = () => {
  throw new Error('Nx was asked although the files decide it');
};

describe('images-plan', () => {
  it('names every image the compose files run, the backup image included, and the sandbox', () => {
    expect(IMAGES).toEqual([
      'api',
      'backup',
      'editor',
      'embedder',
      'mcp',
      'portal',
      'sandbox',
      'sandbox-launcher',
      'demo-portal',
    ]);
    const compose = [
      'compose.yaml',
      'compose.embedder.yaml',
      'compose.demo.yaml',
    ]
      .map((file) => readFileSync(join(root, 'deploy', file), 'utf8'))
      .join('\n');
    const used = new Set(
      [...compose.matchAll(/\$\{OPENFOLIA_IMAGES[^}]*\}\/([a-z-]+):/g)].map(
        (m) => m[1],
      ),
    );
    // The sandbox runs on its own, one container per visitor the launcher's agent starts (#828):
    // compose.demo.yaml names it as the agent's CCMS_LAUNCHER_SANDBOX_IMAGE.
    expect([...used].sort()).toEqual([...IMAGES].sort());
    // Every image is a target of the Dockerfile.
    const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');
    for (const image of IMAGES)
      expect(dockerfile).toMatch(new RegExp(`^FROM \\S+ AS ${image}$`, 'm'));
  });

  it('builds every image with nothing to compare with', () => {
    expect(planImages({ changedFiles: null, affectedProjects: never })).toEqual(
      { images: [...IMAGES], unaffected: [] },
    );
  });

  it('rebuilds the backup image with the API: a change in the API selects both', () => {
    const affectedProjects = vi.fn(() => ['api']);
    expect(
      planImages({
        changedFiles: ['backend/api/src/backups/core/actions/run-backup.ts'],
        affectedProjects,
      }),
    ).toEqual({
      images: ['api', 'backup', 'sandbox', 'demo-portal'],
      unaffected: ['editor', 'embedder', 'mcp', 'portal', 'sandbox-launcher'],
    });
    expect(affectedProjects).toHaveBeenCalledTimes(1);
  });

  it('rebuilds the backup image when its own build changes (the Dockerfile, deploy/)', () => {
    for (const file of [
      'Dockerfile',
      'deploy/docker/node-entrypoint.sh',
      'deploy/compose.yaml',
    ]) {
      expect(
        planImages({ changedFiles: [file], affectedProjects: never }).images,
      ).toContain('backup');
    }
  });

  it('rebuilds every image for the files every image is built from', () => {
    for (const file of [
      '.dockerignore',
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      '.github/workflows/images.yml',
      'scripts/images-plan.mjs',
    ]) {
      expect(
        planImages({ changedFiles: [file], affectedProjects: never }),
      ).toEqual({ images: [...IMAGES], unaffected: [] });
    }
  });

  it('leaves the API and backup images alone for an editor-only change', () => {
    expect(
      planImages({
        changedFiles: ['frontend/editor/src/main.ts'],
        affectedProjects: () => ['editor', 'ui'],
      }),
    ).toEqual({
      images: ['editor', 'sandbox'],
      unaffected: [
        'api',
        'backup',
        'embedder',
        'mcp',
        'portal',
        'sandbox-launcher',
        'demo-portal',
      ],
    });
  });

  it('follows Nx through the dependencies: a shared package rebuilds all that use it', () => {
    expect(
      planImages({
        changedFiles: ['packages/content-model/src/index.ts'],
        affectedProjects: () => [
          'content-model',
          'api',
          'mcp',
          'editor',
          'portal',
        ],
      }).images,
    ).toEqual([
      'api',
      'backup',
      'editor',
      'mcp',
      'portal',
      'sandbox',
      'demo-portal',
    ]);
  });

  it('rebuilds the portal images, and only them, for a portal-only change', () => {
    expect(
      planImages({
        changedFiles: ['frontend/portal/build/refresh.ts'],
        affectedProjects: () => ['portal'],
      }).images,
    ).toEqual(['portal', 'demo-portal']);
  });

  it('rebuilds the sandbox and the demo portal, and only them, for the database and the demo it bakes', () => {
    expect(
      planImages({
        changedFiles: ['backend/sandbox/src/database.ts'],
        affectedProjects: () => ['sandbox', 'editor-e2e'],
      }).images,
    ).toEqual(['sandbox', 'demo-portal']);
    // scripts/demo/ is the workflow project's, which no image is built from: the files decide.
    expect(
      planImages({
        changedFiles: ['scripts/demo/populate.mjs'],
        affectedProjects: () => ['workflow'],
      }),
    ).toEqual({
      images: ['sandbox', 'demo-portal'],
      unaffected: [
        'api',
        'backup',
        'editor',
        'embedder',
        'mcp',
        'portal',
        'sandbox-launcher',
      ],
    });
    expect(
      planImages({
        changedFiles: ['scripts/board.mjs'],
        affectedProjects: () => ['workflow'],
      }).images,
    ).toEqual([]);
  });

  it('rebuilds the launcher for its own changes alone', () => {
    expect(
      planImages({
        changedFiles: ['backend/sandbox-launcher/src/server.ts'],
        affectedProjects: () => ['sandbox-launcher'],
      }).images,
    ).toEqual(['sandbox-launcher']);
  });

  it('builds nothing when no image project is affected', () => {
    expect(
      planImages({
        changedFiles: ['docs/features.md'],
        affectedProjects: () => [],
      }),
    ).toEqual({ images: [], unaffected: [...IMAGES] });
  });

  it('writes the workflow output lines', () => {
    expect(
      outputLines({ images: ['api', 'backup'], unaffected: ['editor', 'mcp'] }),
    ).toEqual(['images=["api","backup"]', 'unaffected=["editor","mcp"]']);
  });

  it('takes only a commit SHA as the base', () => {
    expect(parseArgs([])).toEqual({ base: null });
    expect(parseArgs(['--base', 'a4b2e6a6'])).toEqual({ base: 'a4b2e6a6' });
    for (const argv of [
      ['--base'],
      ['--base', ''],
      ['--base', '--output=/tmp/x'],
      ['--base', 'main'],
      ['--other'],
    ]) {
      expect(() => parseArgs(argv)).toThrow(/unexpected argument/);
    }
  });

  it('is what the workflow runs, and the workflow builds only the images it names', () => {
    const workflow = parse(
      readFileSync(join(root, '.github', 'workflows', 'images.yml'), 'utf8'),
    );
    const plan = workflow.jobs.plan.steps.find(
      (s: { id?: string }) => s.id === 'affected',
    );
    expect(plan.run).toContain('node scripts/images-plan.mjs');
    expect(plan.run).not.toMatch(/\["api"/);
    expect(workflow.jobs.build.strategy.matrix.image).toBe(
      '${{ fromJSON(needs.plan.outputs.images) }}',
    );
    // Only the images of the plan: no job builds a target of its own.
    const builds = Object.values(
      workflow.jobs as Record<
        string,
        { steps?: { uses?: string; with?: { target?: string } }[] }
      >,
    ).flatMap((job) =>
      (job.steps ?? []).filter((s) =>
        s.uses?.startsWith('docker/build-push-action'),
      ),
    );
    expect(builds.length).toBeGreaterThan(0);
    for (const step of builds) {
      expect(step.with?.target).toBe('${{ matrix.image }}');
    }
  });
  // The merge step's script run against a stub `docker` (#866): the registry may answer `not
  // found` just after the push; only that is retried, a bounded number of times.
  describe('the merge step tagging an index', () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    const both = JSON.stringify({
      digest,
      manifests: ['amd64', 'arm64'].map((architecture) => ({
        platform: { os: 'linux', architecture },
      })),
    });
    const onlyOne = JSON.stringify({
      digest,
      manifests: [{ platform: { os: 'linux', architecture: 'amd64' } }],
    });

    // `failures` inspects fail with `error` first, then one answers `manifest`.
    function runMerge(failures: number, error: string, manifest: string) {
      const dir = mkdtempSync(join(tmpdir(), 'images-merge-'));
      const bin = join(dir, 'bin');
      const legs = join(dir, 'legs');
      mkdirSync(bin);
      mkdirSync(legs);
      for (const arch of ['amd64', 'arm64']) {
        writeFileSync(join(legs, arch), `sha256:${'b'.repeat(64)}`);
      }
      const stub = (name: string, body: string) => {
        writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`);
        chmodSync(join(bin, name), 0o755);
      };
      stub('sleep', `echo slept >>"${dir}/sleeps"`);
      stub(
        'docker',
        `[ "$2" = inspect ] || [ "$3" = inspect ] || exit 0
n=$(cat "${dir}/n" 2>/dev/null || echo 0); echo $((n + 1)) >"${dir}/n"
if [ "$n" -lt ${failures} ]; then echo '${error}' >&2; exit 1; fi
echo '${manifest}'`,
      );
      const workflow = parse(
        readFileSync(join(root, '.github', 'workflows', 'images.yml'), 'utf8'),
      );
      const step = workflow.jobs.merge.steps.find(
        (s: { id?: string }) => s.id === 'index',
      );
      // `${OWNER,,}` needs bash 4 (the runners'; macOS ships 3.2): the owner is lowercase already.
      const script = (step.run as string).replace('${OWNER,,}', '${OWNER}');
      const result = spawnSync('bash', ['-e', '-c', script], {
        encoding: 'utf8',
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          REGISTRY: 'ghcr.io',
          OWNER: 'owner',
          IMAGE_NAME: 'demo-portal',
          TAGS: 'ghcr.io/owner/openfolia/demo-portal:abc',
          LEGS: legs,
          GITHUB_SHA: 'abc',
          GITHUB_OUTPUT: join(dir, 'out'),
        },
      });
      const read = (f: string) => {
        try {
          return readFileSync(join(dir, f), 'utf8');
        } catch {
          return '';
        }
      };
      return {
        status: result.status,
        stderr: result.stderr,
        stdout: result.stdout,
        inspects: Number(read('n') || 0),
        out: read('out'),
      };
    }

    it('retries a not found, then goes on', () => {
      const r = runMerge(2, 'ERROR: not found', both);
      expect(r.status).toBe(0);
      expect(r.inspects).toBe(3);
      expect(r.out).toContain(`digest=${digest}`);
    });

    it('gives up after 5 tries of not found, with a message', () => {
      const r = runMerge(99, 'ERROR: not found', both);
      expect(r.status).toBe(1);
      expect(r.inspects).toBe(5);
      expect(r.stdout).toContain('cannot inspect');
    });

    it('does not retry any other error', () => {
      const r = runMerge(99, 'ERROR: unauthorized', both);
      expect(r.status).toBe(1);
      expect(r.inspects).toBe(1);
    });

    it('still demands both architectures', () => {
      const r = runMerge(0, '', onlyOne);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('is no index of linux/amd64 and linux/arm64');
    });
  });
});
