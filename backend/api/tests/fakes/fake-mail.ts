import type { Transaction } from '../../src/base/core/unit-of-work.js';
import type { MailLanguage, RenderedMail } from '../../src/mail/core/mail.js';
import {
  type MailBrand,
  MailBrandSource,
  Mailer,
  MailSendError,
  type MailServerInfo,
  MailSettings,
  type MailState,
  MailStore,
  type StoredMail,
} from '../../src/mail/core/mail-ports.js';
import { fakeOf } from './fake-unit-of-work.js';

/** Records what it was asked to send; `failWith` makes the next sends throw it, in turn. */
export class FakeMailer extends Mailer {
  readonly sent: RenderedMail[] = [];
  readonly failWith: MailSendError[] = [];

  async send(mail: RenderedMail): Promise<void> {
    const error = this.failWith.shift();
    if (error) throw error;
    this.sent.push(mail);
  }
}

/** Settings set by the test; on, with a server, unless it changes them. */
export class FakeMailSettings extends MailSettings {
  state: MailState = 'on';
  server: MailServerInfo | null = {
    host: 'mail.example.com',
    port: 587,
    tls: 'starttls',
    authenticated: true,
  };
  from: string | null = 'docs@example.com';
  language: MailLanguage = 'en';
  publicUrl: string | null = 'https://docs.example.com/';
}

/** A brand set by the test (default: the name only). */
export class FakeMailBrandSource extends MailBrandSource {
  brand: MailBrand = { productName: 'Docs', primary: null, logo: null };

  async read(): Promise<MailBrand> {
    return this.brand;
  }

  async productName(): Promise<string> {
    return this.brand.productName;
  }
}

/** Queued emails in memory, staged on the transaction like the database's. */
export class FakeMailStore extends MailStore {
  readonly rows = new Map<string, StoredMail>();

  async add(
    tx: Transaction,
    mail: Omit<StoredMail, 'attempts' | 'lastError' | 'createdAt'>,
  ): Promise<void> {
    fakeOf(tx).onCommit(() =>
      this.rows.set(mail.id, {
        ...mail,
        attempts: 0,
        lastError: null,
        createdAt: new Date(),
      }),
    );
  }

  async find(id: string): Promise<StoredMail | undefined> {
    return this.rows.get(id);
  }

  async recordFailure(id: string, error: string): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row) return false;
    this.rows.set(id, { ...row, attempts: row.attempts + 1, lastError: error });
    return true;
  }

  async remove(tx: Transaction, id: string): Promise<boolean> {
    if (!this.rows.has(id)) return false;
    fakeOf(tx).onCommit(() => this.rows.delete(id));
    return true;
  }

  async removeStale(before: Date, limit: number): Promise<number> {
    let removed = 0;
    for (const [id, row] of this.rows) {
      if (removed >= limit) break;
      if (row.createdAt < before) {
        this.rows.delete(id);
        removed++;
      }
    }
    return removed;
  }
}
