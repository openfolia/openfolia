import { Module } from '@nestjs/common';
import { SnapshotInterceptor } from './api/read-content.js';
import { OpenReleasedSnapshotsAction } from './core/actions/open-released-snapshots.action.js';
import { OpenSnapshotAction } from './core/actions/open-snapshot.action.js';
import { ContentRepository } from './core/content.repository.js';
import { ReadableRefs } from './core/readable-refs.js';
import { GitContentRepo } from './repos/git-content.repo.js';
import { WithdrawnReleases } from './core/withdrawn-releases.js';
// The releases component's table, read here so every reader of release
// tags leaves out withdrawn ones (#138).
import { DrizzleWithdrawnReleases } from '../releases/repos/drizzle-withdrawn-releases.js';

/** Content in Git; imported by every component that reads it. */
@Module({
  providers: [
    { provide: ContentRepository, useClass: GitContentRepo },
    { provide: WithdrawnReleases, useClass: DrizzleWithdrawnReleases },
    OpenSnapshotAction,
    OpenReleasedSnapshotsAction,
    ReadableRefs,
    SnapshotInterceptor,
  ],
  exports: [
    ContentRepository,
    OpenSnapshotAction,
    OpenReleasedSnapshotsAction,
    ReadableRefs,
    SnapshotInterceptor,
  ],
})
export class ContentModule {}
