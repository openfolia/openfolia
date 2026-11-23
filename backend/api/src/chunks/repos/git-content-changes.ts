import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GitRepo } from '@openfolia/content-repo';
import type { Env } from '../../config/env.js';
import { ContentChanges } from '../core/content-changes.js';

/** `ContentChanges` over the content repository (`CCMS_CONTENT_DIR`), read-only. */
@Injectable()
export class GitContentChanges extends ContentChanges {
  private readonly repo: GitRepo;

  constructor(config: ConfigService<Env, true>) {
    super();
    // Runs one git command per call; no long-running process to close.
    this.repo = new GitRepo(config.get('CCMS_CONTENT_DIR', { infer: true }));
  }

  contains(commit: string, since: string): Promise<boolean> {
    return this.repo.isAncestor(since, commit);
  }

  async changedPaths(from: string, to: string): Promise<string[]> {
    return (await this.repo.changedPaths(from, to)).map(({ path }) => path);
  }
}
