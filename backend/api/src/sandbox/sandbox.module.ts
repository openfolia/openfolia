import {
  Global,
  Injectable,
  Logger,
  Module,
  type MiddlewareConsumer,
  type NestMiddleware,
  type NestModule,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NextFunction, Request, Response } from 'express';
import type { Env } from '../config/env.js';
import {
  SandboxEnv,
  sandboxLifetimeOf,
  sandboxLimitsOf,
  type SandboxSettings,
} from '../config/sandbox-env.js';
import { SandboxController } from './api/sandbox.controller.js';
import { GetSandboxAction } from './core/actions/get-sandbox.action.js';
import { Sandbox } from './core/sandbox.js';

/** The `Sandbox` the settings ask for: on with `CCMS_PUBLIC_SANDBOX=on`, else `Sandbox.OFF`. */
export function sandboxFrom(config: ConfigService<Env, true>): Sandbox {
  if (config.get('CCMS_PUBLIC_SANDBOX', { infer: true }) !== 'on') {
    return Sandbox.OFF;
  }
  // Every `CCMS_SANDBOX_*` setting, as validated.
  const settings = Object.fromEntries(
    Object.keys(SandboxEnv.shape).map((name) => [
      name,
      config.get(name as keyof SandboxSettings, { infer: true }),
    ]),
  ) as SandboxSettings;
  return Sandbox.on({
    limits: sandboxLimitsOf(settings),
    lifetime: sandboxLifetimeOf(settings),
  });
}

/**
 * Paths whose requests are no activity: the banner's own reads, the health checks and the
 * editor's unread-count poll (every 30 s while a tab is visible), so an open tab nobody uses
 * still ends after the idle minutes.
 */
const QUIET = /^\/(?:sandbox|health|me\/notifications\/unread-count)(?:[/?]|$)/;

/** Every other request moves the sandbox's idle end on. */
@Injectable()
class SandboxActivity implements NestMiddleware {
  constructor(private readonly sandbox: Sandbox) {}

  use(req: Request, _res: Response, next: NextFunction): void {
    if (this.sandbox.on && !QUIET.test(req.originalUrl)) this.sandbox.touch();
    next();
  }
}

/** Says once, at start-up, that this instance is a public sandbox. */
@Injectable()
class SandboxStartup implements OnApplicationBootstrap {
  constructor(private readonly sandbox: Sandbox) {}

  onApplicationBootstrap(): void {
    if (!this.sandbox.on) return;
    new Logger('Sandbox').log(
      'This instance is a public sandbox (CCMS_PUBLIC_SANDBOX=on): nothing leaves it, nothing reaches other people; users, tokens, uploads, imports, webhooks and email are off.',
    );
  }
}

/**
 * The public sandbox (#826), global: `Sandbox`, which the actions ask before what a sandbox
 * never does and around what it counts, and which the modules ask when they choose an adapter
 * that reaches the network (each takes its sandbox adapter, which never connects:
 * `tests/sandbox-outbound.spec.ts` lists them). `GET /sandbox` tells the editor's banner.
 */
@Global()
@Module({
  controllers: [SandboxController],
  providers: [
    { provide: Sandbox, inject: [ConfigService], useFactory: sandboxFrom },
    GetSandboxAction,
    SandboxActivity,
    SandboxStartup,
  ],
  exports: [Sandbox],
})
export class SandboxModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(SandboxActivity).forRoutes('*path');
  }
}
