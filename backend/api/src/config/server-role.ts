import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from './env.js';
import { runsBackground, servesHttp, type ServerRoleName } from './role.js';

/**
 * This process's role (`CCMS_ROLE`, #527), for what starts at boot: the
 * background loops ask `runsBackground` before they schedule anything, the
 * job queue whether to supervise, the PDF renderer how large its pool is.
 */
export class ServerRole {
  constructor(readonly name: ServerRoleName) {}

  /** Serves the HTTP API (`all`, `api`). */
  get servesHttp(): boolean {
    return servesHttp(this.name);
  }

  /** Consumes jobs and runs the background loops (`all`, `worker`). */
  get runsBackground(): boolean {
    return runsBackground(this.name);
  }

  /** Applies migrations at start (never the `worker`: it waits for them). */
  get migrates(): boolean {
    return this.name !== 'worker';
  }
}

/** Provides `ServerRole` to every module (global). */
@Global()
@Module({
  providers: [
    {
      provide: ServerRole,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        new ServerRole(config.get('CCMS_ROLE', { infer: true })),
    },
  ],
  exports: [ServerRole],
})
export class ServerRoleModule {}
