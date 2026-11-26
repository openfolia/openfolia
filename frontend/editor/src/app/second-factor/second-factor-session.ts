import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom, type Observable } from 'rxjs';

import { API_BASE_URL, toApiError, type ApiError, type Schema } from '../api';
import { apiErrorText } from '../i18n';

const JSON_API = 'application/vnd.api+json';
const HEADERS = { Accept: JSON_API, 'Content-Type': JSON_API };

/** One's own second factor, as the account menu shows it. */
export type OwnSecondFactor = Schema<'SecondFactorResource'>;

/** A set-up begun: the secret and its QR code, shown once. */
export type SetUpBegun = Schema<'SecondFactorSetUpDocument'>['meta'];

/** The second step of a sign-in open in this browser. */
export type SecondStep = Schema<'SecondStepDocument'>['meta'];

/** What is left to do after the first step: a code, a set-up first, or nothing. */
export type SecondStepKind = Schema<'SignedInDocument'>['meta']['secondFactor'];

/** Proof it is still you: your password, or a code. */
export type Proof = { readonly password: string } | { readonly code: string };

/** A code as the API reads it, without the spaces and dashes people type. */
export const codeOf = (typed: string): string => typed.replace(/[\s-]/g, '');

/** Six digits: a code of the app. */
export const isAppCode = (typed: string): boolean =>
  /^[0-9]{6}$/.test(codeOf(typed));

/** A quiet text button or link beside the form of a second factor. */
export const SECOND_FACTOR_LINK =
  'text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit max-w-full cursor-pointer rounded-sm text-start text-sm break-words underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50';

/** A lockout's wait, in whole minutes. */
export const waitMinutes = (error: ApiError): number =>
  Math.max(1, Math.ceil((error.retryAfter ?? 0) / 60));

/** Why a code or a password was refused, as the person reads it; a lockout's wait in minutes. */
export function secondFactorProblem(
  error: ApiError,
  recovery = false,
): {
  key: string;
  params?: Record<string, unknown> | undefined;
} {
  if (recovery && error.code === 'wrong-code') {
    return { key: 'editor.secondFactor.code.recoveryWrong' };
  }
  if (error.code === 'too-many-failed-attempts') {
    return {
      key: 'editor.secondFactor.locked',
      params: { minutes: waitMinutes(error) },
    };
  }
  return apiErrorText(error);
}

/**
 * Two-factor sign-in (#611): the second step of a sign-in (its cookie is the API's, HttpOnly),
 * one's own second factor in the account menu, and an admin's reset. Each call rejects with an
 * `ApiError`. Secrets and recovery codes are answered once and kept nowhere here.
 */
@Injectable({ providedIn: 'root' })
export class SecondFactorSession {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);

  /** The second step open in this browser; 410 `second-factor-expired` when there is none. */
  async step(): Promise<SecondStep> {
    const doc = await this.call(
      this.http.get<Schema<'SecondStepDocument'>>(
        `${this.base}/auth/second-factor`,
        { headers: HEADERS },
      ),
    );
    return doc.meta;
  }

  /** Signs in with a code of the app, or a recovery code. */
  async verify(code: string): Promise<void> {
    await this.post('/auth/second-factor/verify', codeBody(code));
  }

  /** Begins the set-up the installation requires before signing in. */
  async beginRequired(): Promise<SetUpBegun> {
    const doc = await this.post<Schema<'SecondFactorSetUpDocument'>>(
      '/auth/second-factor/set-up',
      {},
    );
    return doc.meta;
  }

  /** Confirms it and signs in; answers the recovery codes. */
  async confirmRequired(code: string): Promise<readonly string[]> {
    const doc = await this.post<Schema<'SecondStepSetUpDoneDocument'>>(
      '/auth/second-factor/confirm',
      codeBody(code),
    );
    return doc.meta.recoveryCodes;
  }

  async own(): Promise<OwnSecondFactor> {
    const doc = await this.call(
      this.http.get<Schema<'SecondFactorDocument'>>(
        `${this.base}/me/second-factor`,
        { headers: HEADERS },
      ),
    );
    return doc.data;
  }

  /** Begins setting it up; the password when there is one. */
  async begin(password: string | null): Promise<SetUpBegun> {
    const doc = await this.post<Schema<'SecondFactorSetUpDocument'>>(
      '/me/second-factor/set-up',
      {
        data: {
          type: 'SecondFactorSetUp',
          attributes: password === null ? {} : { password },
        },
      },
    );
    return doc.meta;
  }

  /** Turns it on; the other sessions end. */
  async confirm(
    code: string,
  ): Promise<Schema<'SecondFactorOnDocument'>['meta']> {
    const doc = await this.post<Schema<'SecondFactorOnDocument'>>(
      '/me/second-factor/confirm',
      codeBody(code),
    );
    return doc.meta;
  }

  async newRecoveryCodes(proof: Proof): Promise<readonly string[]> {
    const doc = await this.post<Schema<'RecoveryCodesDocument'>>(
      '/me/second-factor/recovery-codes',
      proofBody(proof),
    );
    return doc.meta.recoveryCodes;
  }

  async turnOff(proof: Proof): Promise<void> {
    await this.post('/me/second-factor/turn-off', proofBody(proof));
  }

  /** Removes another person's second factor (`admin.roles`). */
  async reset(userId: string): Promise<void> {
    await this.call(
      this.http.delete(
        `${this.base}/users/${encodeURIComponent(userId)}/second-factor`,
        { headers: HEADERS },
      ),
    );
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.call(
      this.http.post<T>(`${this.base}${path}`, body, { headers: HEADERS }),
    );
  }

  private async call<T>(request: Observable<T>): Promise<T> {
    try {
      return await firstValueFrom(request);
    } catch (error) {
      throw toApiError(error);
    }
  }
}

const codeBody = (code: string) => ({
  data: { type: 'SecondFactorCode', attributes: { code } },
});

const proofBody = (proof: Proof) => ({
  data: { type: 'SecondFactorProof', attributes: proof },
});
