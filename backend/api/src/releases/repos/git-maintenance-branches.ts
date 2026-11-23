import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GitRepo,
  GitWriter,
  RefConflictError,
  WriteError,
} from '@openfolia/content-repo';
import { ConflictError, UnprocessableError } from '../../base/core/errors.js';
import type { Env } from '../../config/env.js';
import { MaintenanceBranches } from '../core/maintenance-branches.js';
import { maintenanceBranchName } from '../core/maintenance-line.js';

/**
 * `MaintenanceBranches` over the content repository (`CCMS_CONTENT_DIR`),
 * through `GitWriter.createBranch`: a branch is only ever created, by
 * compare-and-swap, and only under a name `CCMS_MAINTENANCE_BRANCH` gives;
 * nothing here moves or deletes one.
 */
@Injectable()
export class GitMaintenanceBranches extends MaintenanceBranches {
  private readonly writer: GitWriter;
  private readonly repo: GitRepo;
  private readonly pattern: string;

  constructor(config: ConfigService<Env, true>) {
    super();
    const dir = config.get('CCMS_CONTENT_DIR', { infer: true });
    this.writer = new GitWriter(dir);
    // Only `for-each-ref`: no long-running process to close.
    this.repo = new GitRepo(dir);
    this.pattern = config.get('CCMS_MAINTENANCE_BRANCH', { infer: true });
  }

  nameOf(product: string, revision: string): string {
    const name = maintenanceBranchName(this.pattern, product, revision);
    if (name === undefined) {
      throw new UnprocessableError(
        'invalid-maintenance-branch',
        'The product and revision make no branch name by CCMS_MAINTENANCE_BRANCH.',
      );
    }
    return name;
  }

  async create(name: string, commit: string): Promise<'created' | 'existed'> {
    // Only names the pattern makes: no caller can create another branch here.
    if (!this.isLineBranch(name)) {
      throw new Error(`"${name}" is no maintenance branch.`);
    }
    try {
      await this.writer.createBranch(name, commit);
      return 'created';
    } catch (error) {
      if (error instanceof RefConflictError) {
        if (error.actual === commit) return 'existed';
        throw new ConflictError(
          'branch-exists',
          `The branch "${name}" exists already, at another commit.`,
        );
      }
      if (error instanceof WriteError && error.code === 'invalid-ref') {
        throw new ConflictError(
          'branch-exists',
          `A branch or tag clashing with "${name}" exists already.`,
        );
      }
      throw error;
    }
  }

  async head(name: string): Promise<string | undefined> {
    const { branches } = await this.repo.refs();
    return branches.find((b) => b.name === name)?.commit;
  }

  /** Whether the pattern makes `name` from some product and revision. */
  private isLineBranch(name: string): boolean {
    const parts = name.split('/');
    const pattern = this.pattern.split('/');
    if (parts.length !== pattern.length) return false;
    const product = parts[pattern.indexOf('{product}')] ?? '';
    const revision = parts[pattern.indexOf('{revision}')] ?? '';
    return maintenanceBranchName(this.pattern, product, revision) === name;
  }
}
