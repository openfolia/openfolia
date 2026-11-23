import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Env } from '../../config/env.js';

/**
 * Tells Express which proxies to believe about the client's address (`CCMS_TRUST_PROXY`,
 * #574), so `req.ip` is the reader's address behind them. Unset, no proxy is trusted:
 * `req.ip` is the socket's address and `X-Forwarded-For` is never read. Call before
 * `init()`/`listen()`.
 */
export function setUpTrustProxy(app: NestExpressApplication): void {
  const config = app.get<ConfigService<Env, true>>(ConfigService);
  // A copy: Express compiles the list once, at `set`.
  const trusted = config.get('CCMS_TRUST_PROXY', { infer: true });
  app.set('trust proxy', Array.isArray(trusted) ? [...trusted] : trusted);
}
