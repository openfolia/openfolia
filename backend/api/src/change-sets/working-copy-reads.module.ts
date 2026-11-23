import { Global, Module } from '@nestjs/common';
import { AssetsModule } from '../assets/assets.module.js';
import { WorkingCopyInterceptor } from './api/working-copy-reads.js';
import { OpenWorkingCopiesAction } from './core/actions/open-working-copies.action.js';
import { WorkingCopyStore } from './core/working-copy-store.js';
import { DrizzleWorkingCopyStore } from './repos/drizzle-working-copy-store.js';

/**
 * Reading a change set's working copies in place of their files
 * (`@ReadsWorkingCopies()`, `?workingCopy=true`, #237), for the content
 * routes of other components (the previews, the PDF): global, as those
 * cannot import the change sets' own module. The one `WorkingCopyStore`,
 * which the change sets' module takes from here.
 */
@Global()
@Module({
  imports: [AssetsModule],
  providers: [
    OpenWorkingCopiesAction,
    WorkingCopyInterceptor,
    { provide: WorkingCopyStore, useClass: DrizzleWorkingCopyStore },
  ],
  exports: [OpenWorkingCopiesAction, WorkingCopyInterceptor, WorkingCopyStore],
})
export class WorkingCopyReadsModule {}
