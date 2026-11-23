import { HttpClient } from '@angular/common/http';
import { inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { API_BASE_URL, toApiError, type Schema } from '../api';

const JSON_API = 'application/vnd.api+json';
const HEADERS = { Accept: JSON_API, 'Content-Type': JSON_API };

/** What the sign-in page offers (`GET /auth/options`). */
export interface SignInOptions {
  readonly password: boolean;
  readonly passwordReset: boolean;
  /** "Email me a code" (#634). */
  readonly emailCode: boolean;
  readonly providers: number;
}

/** What a one-time link is for, for the page it opens. */
export type SignInLinkInfo = Schema<'SignInLinkDocument'>['meta'];

/** A link just made for a person, shown once. */
export type SignInLinkMade = Schema<'SignInLinkMadeDocument'>['meta'];

/** The fragment a one-time link carries its token in: `set-password#ccms_pwl_…`. */
export const LINK_TOKEN = /^ccms_pwl_[0-9a-f]{64}$/;

/** The fragment a code's email link carries its token in (#634): `sign-in-code#ccms_ecl_…`. */
export const CODE_LINK_TOKEN = /^ccms_ecl_[0-9a-f]{64}$/;

/**
 * Signing in with an email address and a password (#610), or a code by email (#634): the sign-in
 * page's options, signing in, "Forgot password", asking for a code and signing in with it or its link, the page a one-time link opens, changing one's password, and an
 * admin's invites and reset links. Each call rejects with an `ApiError`. The session is the
 * HttpOnly cookie the API sets, as with a provider's sign-in.
 */
@Injectable({ providedIn: 'root' })
export class PasswordSession {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);

  private readonly state = signal<SignInOptions | null>(null);
  private asked: Promise<SignInOptions | null> | null = null;

  /** The options once asked; null before (or when they could not be asked). */
  readonly options = this.state.asReadonly();

  /** Asks the API what the sign-in page offers, once; null when it could not be asked. */
  loadOptions(): Promise<SignInOptions | null> {
    this.asked ??= this.readOptions();
    return this.asked;
  }

  reloadOptions(): Promise<SignInOptions | null> {
    this.asked = this.readOptions();
    return this.asked;
  }

  signIn(email: string, password: string): Promise<string> {
    return this.send<Schema<'SignedInDocument'>>('/auth/password/sign-in', {
      data: { type: 'PasswordSignIn', attributes: { email, password } },
    }).then((doc) => doc.meta.userId);
  }

  async forgot(email: string): Promise<void> {
    await this.send('/auth/password/forgot', {
      data: { type: 'PasswordReset', attributes: { email } },
    });
  }

  /** "Email me a code" (#634): the same answer whether or not the address is known. */
  async requestCode(email: string, language: string): Promise<void> {
    await this.send('/auth/email-code/request', {
      data: { type: 'EmailCodeRequest', attributes: { email, language } },
    });
  }

  /** Signs in with the code from the email (#634); the API sets the session cookie. */
  signInWithCode(email: string, code: string): Promise<string> {
    return this.send<Schema<'SignedInDocument'>>('/auth/email-code/sign-in', {
      data: { type: 'EmailCodeSignIn', attributes: { email, code } },
    }).then((doc) => doc.meta.userId);
  }

  /** Signs in with the link from a code's email (#634). */
  signInWithLink(token: string): Promise<string> {
    return this.send<Schema<'SignedInDocument'>>('/auth/email-code/link', {
      data: { type: 'EmailCodeLink', attributes: { token } },
    }).then((doc) => doc.meta.userId);
  }

  readLink(token: string): Promise<SignInLinkInfo> {
    return this.send<Schema<'SignInLinkDocument'>>('/auth/password/link', {
      data: { type: 'SignInLink', attributes: { token } },
    }).then((doc) => doc.meta);
  }

  async setPassword(token: string, password: string): Promise<void> {
    await this.send('/auth/password/set', {
      data: { type: 'PasswordSet', attributes: { token, password } },
    });
  }

  changePassword(
    currentPassword: string,
    newPassword: string,
  ): Promise<number> {
    return this.send<Schema<'PasswordChangedDocument'>>('/me/password', {
      data: {
        type: 'PasswordChange',
        attributes: { currentPassword, newPassword },
      },
    }).then((doc) => doc.meta.sessionsEnded);
  }

  /** An invite (`invite`) or a reset link (`reset`) for `userId`, which replaces their earlier link. */
  makeLink(userId: string, kind: 'invite' | 'reset'): Promise<SignInLinkMade> {
    const path = kind === 'invite' ? 'invite' : 'password-reset';
    return this.send<Schema<'SignInLinkMadeDocument'>>(
      `/users/${encodeURIComponent(userId)}/${path}`,
      {},
    ).then((doc) => doc.meta);
  }

  async withdrawInvite(userId: string): Promise<void> {
    try {
      await firstValueFrom(
        this.http.delete(
          `${this.base}/users/${encodeURIComponent(userId)}/invite`,
          { headers: HEADERS },
        ),
      );
    } catch (error) {
      throw toApiError(error);
    }
  }

  /** The link to give the person: the API's, else one at this editor's own address. */
  linkOf(made: SignInLinkMade, origin: string): string {
    return made.url ?? `${origin}/set-password#${made.token}`;
  }

  private async readOptions(): Promise<SignInOptions | null> {
    try {
      const doc = await firstValueFrom(
        this.http.get<Schema<'SignInOptionsDocument'>>(
          `${this.base}/auth/options`,
          { headers: { Accept: JSON_API } },
        ),
      );
      this.state.set(doc.data.attributes);
      return doc.data.attributes;
    } catch {
      // An API before #610, or unreachable: no password form.
      this.state.set(null);
      return null;
    }
  }

  private async send<T>(path: string, body: unknown): Promise<T> {
    try {
      return await firstValueFrom(
        this.http.post<T>(`${this.base}${path}`, body, { headers: HEADERS }),
      );
    } catch (error) {
      throw toApiError(error);
    }
  }
}
