import { Global, Module } from '@nestjs/common';
import { MaintenanceLineStore } from './core/maintenance-line-store.js';
import { DrizzleMaintenanceLineStore } from './repos/drizzle-maintenance-line-store.js';

/**
 * The maintenance lines' store (#60), for the releases (cutting a release
 * from a line) and the change sets (starting one on a line, carrying a
 * fix forward): global, since the change sets cannot import the releases
 * module (it imports theirs).
 */
@Global()
@Module({
  providers: [
    { provide: MaintenanceLineStore, useClass: DrizzleMaintenanceLineStore },
  ],
  exports: [MaintenanceLineStore],
})
export class MaintenanceLineStoreModule {}
