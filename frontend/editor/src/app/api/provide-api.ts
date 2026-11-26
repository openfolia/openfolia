import {
  provideHttpClient,
  withFetch,
  withInterceptors,
} from '@angular/common/http';
import type { EnvironmentProviders } from '@angular/core';
import {
  apiErrorInterceptor,
  backgroundInterceptor,
  demoUserInterceptor,
  missingBranchInterceptor,
  peopleInterceptor,
  stateChangeInterceptor,
} from './api-interceptors';

/**
 * HttpClient with the API layer's interceptors (demo identity header, the cross-site headers on
 * state-changing calls, the mark of a call nobody's doing made, a change set's branch found
 * missing, who of the people named is deactivated, error mapping).
 */
export const provideApi = (): EnvironmentProviders =>
  provideHttpClient(
    withFetch(),
    withInterceptors([
      demoUserInterceptor,
      stateChangeInterceptor,
      backgroundInterceptor,
      missingBranchInterceptor,
      peopleInterceptor,
      apiErrorInterceptor,
    ]),
  );
