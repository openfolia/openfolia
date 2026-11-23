import {
  provideHttpClient,
  withFetch,
  withInterceptors,
} from '@angular/common/http';
import type { EnvironmentProviders } from '@angular/core';
import {
  apiErrorInterceptor,
  demoUserInterceptor,
  missingBranchInterceptor,
  stateChangeInterceptor,
} from './api-interceptors';

/**
 * HttpClient with the API layer's interceptors (demo identity header, the cross-site headers on
 * state-changing calls, a change set's branch found missing, error mapping).
 */
export const provideApi = (): EnvironmentProviders =>
  provideHttpClient(
    withFetch(),
    withInterceptors([
      demoUserInterceptor,
      stateChangeInterceptor,
      missingBranchInterceptor,
      apiErrorInterceptor,
    ]),
  );
