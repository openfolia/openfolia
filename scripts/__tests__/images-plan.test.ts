// @vitest-environment node
import { readFileSync } from 'node:fs';
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
  it('names every image compose.yaml and compose.embedder.yaml run, the backup image included, and the sandbox', () => {
    expect(IMAGES).toEqual([
      'api',
      'backup',
      'editor',
      'embedder',
      'mcp',
      'portal',
      'sandbox',
    ]);
    const compose = ['compose.yaml', 'compose.embedder.yaml']
      .map((file) => readFileSync(join(root, 'deploy', file), 'utf8'))
      .join('\n');
    const used = new Set(
      [...compose.matchAll(/\$\{OPENFOLIA_IMAGES[^}]*\}\/([a-z-]+):/g)].map(
        (m) => m[1],
      ),
    );
    // The sandbox runs on its own, one container per visitor (deploy/README.md), never in compose.
    expect([...used, 'sandbox'].sort()).toEqual([...IMAGES].sort());
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
      images: ['api', 'backup', 'sandbox'],
      unaffected: ['editor', 'embedder', 'mcp', 'portal'],
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
      unaffected: ['api', 'backup', 'embedder', 'mcp', 'portal'],
    });
  });

  it('follows Nx through the dependencies: a shared package rebuilds all six', () => {
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
    ).toEqual(['api', 'backup', 'editor', 'mcp', 'portal', 'sandbox']);
  });

  it('rebuilds only the portal image for a portal-only change', () => {
    expect(
      planImages({
        changedFiles: ['frontend/portal/build/refresh.ts'],
        affectedProjects: () => ['portal'],
      }).images,
    ).toEqual(['portal']);
  });

  it('rebuilds the sandbox, and only it, for its embedded database and the demo it bakes', () => {
    expect(
      planImages({
        changedFiles: ['backend/sandbox/src/database.ts'],
        affectedProjects: () => ['sandbox', 'editor-e2e'],
      }).images,
    ).toEqual(['sandbox']);
    // scripts/demo/ is the workflow project's, which no image is built from: the files decide.
    expect(
      planImages({
        changedFiles: ['scripts/demo/populate.mjs'],
        affectedProjects: () => ['workflow'],
      }),
    ).toEqual({
      images: ['sandbox'],
      unaffected: ['api', 'backup', 'editor', 'embedder', 'mcp', 'portal'],
    });
    expect(
      planImages({
        changedFiles: ['scripts/board.mjs'],
        affectedProjects: () => ['workflow'],
      }).images,
    ).toEqual([]);
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
});
